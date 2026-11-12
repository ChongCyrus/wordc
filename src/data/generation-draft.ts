/**
 * task-106 · AI 批量生成草稿（分片/增量/断点续跑）。
 *
 * 草稿复用 `packs` + `packItems` 表：pack.status='reviewing'，item.status='pending'，
 * pack.draft 记录 { scope, kind, cursor, targetTotal, errors, updatedAt }；
 * **每片 append 即持久化**（写 packItems），崩溃/关闭后可继续。
 * 草稿 items 不是 applied，不影响 getEffectiveContent（已应用内容）。
 */
import { getDb } from './db'
import type { PackItemRecord, PackItemV1, PackRecord } from './packs/schema'
import type { GenerationKind } from './ai/types'

export interface GenerationDraftMeta {
  /** 生成 scope（today/deck/words/prefix/range… 原样存，UI 恢复用） */
  scope: unknown
  /** 生成类型；单类型时可为单值，多类型时数组 */
  kind: GenerationKind | GenerationKind[]
  /** 已处理目标数（offset，由调用方按批推进） */
  cursor: number
  /** 预计总目标数 */
  targetTotal: number
  /** 已失败目标（可选；供续跑跳过/提示） */
  errors?: Array<{ index: number; code: string; message: string }>
  updatedAt: number
}

export interface GenerationDraft {
  /** = packId，可作为 draftId 传回 */
  id: string
  name: string
  meta: GenerationDraftMeta
  /** = packItems 数量 */
  done: number
  status: 'reviewing' | 'complete'
  createdAt: number
}

export interface GenerationDraftItemInput {
  headwordLower: string
  meaningIndex?: number
  payload: PackItemV1
}

function draftMetaOf(pack: PackRecord): GenerationDraftMeta | null {
  const raw = pack.draft as Partial<GenerationDraftMeta> | undefined
  if (!raw || typeof raw !== 'object') return null
  return {
    scope: raw.scope,
    kind: raw.kind ?? 'examples',
    cursor: Number(raw.cursor ?? 0),
    targetTotal: Number(raw.targetTotal ?? 0),
    ...(Array.isArray(raw.errors) && raw.errors.length > 0 ? { errors: raw.errors } : {}),
    updatedAt: Number(raw.updatedAt ?? pack.updatedAt),
  }
}

async function toDto(pack: PackRecord): Promise<GenerationDraft | null> {
  const meta = draftMetaOf(pack)
  if (!meta) return null
  const done = await getDb().packItems.where('packId').equals(pack.id).count()
  return {
    id: pack.id,
    name: pack.name,
    meta,
    done,
    status: pack.status === 'applied' || pack.status === 'partial' ? 'complete' : 'reviewing',
    createdAt: pack.createdAt,
  }
}

function pickDraftKind(kinds: GenerationKind[]): PackRecord['kind'] {
  if (kinds.length === 1) return kinds[0] === 'semantics' ? 'semantics' : (kinds[0] as PackRecord['kind'])
  return 'mixed'
}

/** 新建生成草稿（不写 items；scope/kind 原样持久化） */
export async function createGenerationDraft(input: {
  scope: unknown
  kind: GenerationKind[]
  name?: string
}): Promise<GenerationDraft> {
  const db = getDb()
  const now = Date.now()
  const id = `draft_${now}_${Math.random().toString(36).slice(2, 8)}`
  const kinds = input.kind.length > 0 ? input.kind : (['examples'] as GenerationKind[])
  const pack: PackRecord = {
    id,
    name: input.name?.trim() || `AI 生成草稿 ${new Date(now).toLocaleString('zh-CN')}`,
    kind: pickDraftKind(kinds),
    formatVersion: 1,
    checksum: `draft:${id}`, // 草稿不参与 checksum 去重
    source: 'ai',
    status: 'reviewing',
    counts: { items: 0, pending: 0, approved: 0, applied: 0, rejected: 0, skipped: 0 },
    draft: {
      scope: input.scope,
      kind: kinds.length === 1 ? kinds[0]! : kinds,
      cursor: 0,
      targetTotal: 0,
      updatedAt: now,
    } satisfies GenerationDraftMeta,
    createdAt: now,
    updatedAt: now,
  }
  await db.packs.put(pack)
  return (await toDto(pack))!
}

/**
 * 追加一批生成结果（持久化 pending items）。
 * 幂等：同 headwordLower+meaningIndex 已存在则跳过；返回累计 done。
 */
export async function appendGenerationDraftItems(
  draftId: string,
  items: GenerationDraftItemInput[],
): Promise<{ done: number; added: number }> {
  const db = getDb()
  const pack = await db.packs.get(draftId)
  if (!pack) throw new Error(`生成草稿不存在：${draftId}`)
  const meta = draftMetaOf(pack)
  if (!meta) throw new Error(`内容包不是生成草稿：${draftId}`)
  if (items.length === 0) {
    return { done: await db.packItems.where('packId').equals(draftId).count(), added: 0 }
  }
  const now = Date.now()
  return db.transaction('rw', [db.packs, db.packItems], async () => {
    const existing = await db.packItems.where('packId').equals(draftId).toArray()
    const seen = new Set(existing.map((item) => `${item.headwordLower}#${item.meaningIndex ?? 0}`))
    let seq = existing.reduce((max, item) => Math.max(max, item.seq), 0)
    const records: PackItemRecord[] = []
    for (const input of items) {
      const lower = input.headwordLower.trim().toLowerCase()
      if (!lower) continue
      const key = `${lower}#${input.meaningIndex ?? 0}`
      if (seen.has(key)) continue
      seen.add(key)
      seq += 1
      records.push({
        id: `${draftId}:${seq}`,
        packId: draftId,
        seq,
        headword: input.payload.headword || lower,
        headwordLower: lower,
        ...(input.meaningIndex != null ? { meaningIndex: input.meaningIndex } : {}),
        payload: input.payload,
        status: 'pending',
        contentHashes: [],
        createdAt: now,
      })
    }
    if (records.length > 0) await db.packItems.bulkPut(records)
    const counts = {
      ...pack.counts,
      items: pack.counts.items + records.length,
      pending: pack.counts.pending + records.length,
    }
    await db.packs.update(draftId, {
      counts,
      draft: { ...meta, updatedAt: now },
      updatedAt: now,
    })
    return { done: existing.length + records.length, added: records.length }
  })
}

/** 更新断点（cursor/targetTotal/errors；每批完成后调用） */
export async function updateGenerationDraftCursor(
  draftId: string,
  patch: { cursor?: number; targetTotal?: number; errors?: GenerationDraftMeta['errors'] },
): Promise<void> {
  const db = getDb()
  const pack = await db.packs.get(draftId)
  if (!pack) throw new Error(`生成草稿不存在：${draftId}`)
  const meta = draftMetaOf(pack)
  if (!meta) throw new Error(`内容包不是生成草稿：${draftId}`)
  const now = Date.now()
  const next: GenerationDraftMeta = {
    ...meta,
    ...(patch.cursor != null ? { cursor: Math.max(0, patch.cursor) } : {}),
    ...(patch.targetTotal != null ? { targetTotal: Math.max(0, patch.targetTotal) } : {}),
    ...(patch.errors !== undefined ? { errors: patch.errors } : {}),
    updatedAt: now,
  }
  await db.packs.update(draftId, { draft: next, updatedAt: now })
}

export async function getGenerationDraft(draftId: string): Promise<GenerationDraft | null> {
  const pack = await getDb().packs.get(draftId)
  return pack ? toDto(pack) : null
}

/** 未完成草稿（status='reviewing' 且有 draft 元数据） */
export async function listGenerationDrafts(): Promise<GenerationDraft[]> {
  const packs = await getDb().packs.toArray()
  const drafts = packs.filter((pack) => pack.draft && pack.status === 'reviewing')
  const dtos = await Promise.all(drafts.map((pack) => toDto(pack)))
  return dtos.filter((draft): draft is GenerationDraft => Boolean(draft)).sort((a, b) => b.createdAt - a.createdAt)
}

/** 放弃草稿：删除 pack + 全部 items（快路径，不读 items） */
export async function clearGenerationDraft(draftId: string): Promise<void> {
  const pack = await getDb().packs.get(draftId)
  if (!pack) return
  if (!pack.draft) throw new Error(`内容包不是生成草稿：${draftId}`)
  await getDb().transaction('rw', [getDb().packs, getDb().packItems], async () => {
    await getDb().packItems.where('packId').equals(draftId).delete()
    await getDb().packs.delete(draftId)
  })
}
