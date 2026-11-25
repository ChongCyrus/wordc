/**
 * task-106 · AI 批量生成草稿（分片/增量/断点续跑）。
 *
 * 草稿复用 `packs` + `packItems` 表：pack.status='reviewing'，item.status='pending'，
 * pack.draft 记录 { scope, kind, cursor, targetTotal, errors, updatedAt }；
 * **每片 append 即持久化**（写 packItems），崩溃/关闭后可继续。
 * 草稿 items 不是 applied，不影响 getEffectiveContent（已应用内容）。
 */
import { getDb } from './db'
import { ContentWriteError, getContentWriteSource, saveContentEntitiesChunked } from './content-write-source'
import type { ContentEntityRow, SaveContentEntitiesResult } from './content-write-source'
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
  wordId?: string
  deckId?: string
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

// ============ 0.14：内容写源接线（AI 生成草稿 pack / packItems） ============
// 语义：
// - `data.contentWriteSource==='idb'`（默认）：沿用原 IDB 写路径，行为不变；
// - `'sqlite'`：先构造完整行（pack 行含 status/counts/draft/updatedAt，pack-item 行含完整记录），
//   经 `saveContentEntitiesChunked`（≤500/批）写 content_kv；**成功后才写 IDB cache**；
//   失败抛结构化 `ContentWriteError`，失败批**不回写 IDB**（不产生双源）。
// key 规范与 packs 写入口一致：`pack:<id>` / `pack-item:<id>`。

function draftContentRow(pack: PackRecord): ContentEntityRow {
  return {
    key: `pack:${pack.id}`,
    kind: 'pack',
    json: JSON.stringify(pack),
    updatedAt: pack.updatedAt ?? pack.createdAt,
  }
}

function draftItemContentRow(item: PackItemRecord): ContentEntityRow {
  return {
    key: `pack-item:${item.id}`,
    kind: 'pack-item',
    json: JSON.stringify(item),
    updatedAt: item.createdAt ?? Date.now(),
  }
}

function draftDeletionRow(packId: string): ContentEntityRow {
  return { key: `pack:${packId}`, kind: 'pack', json: 'null', deleted: true }
}

function draftItemDeletionRow(itemId: string): ContentEntityRow {
  return { key: `pack-item:${itemId}`, kind: 'pack-item', json: 'null', deleted: true }
}

function draftWriteFailure(label: string, result: SaveContentEntitiesResult, total: number): ContentWriteError {
  return new ContentWriteError(
    `${label}：内容写入 SQLite 失败（已写 ${result.written}/${total} 条，失败批未回写本地缓存）——${result.error ?? '未知错误'}`,
    'CONTENT_SQLITE_WRITE_FAILED',
  )
}

async function isSqliteContentSource(): Promise<boolean> {
  return (await getContentWriteSource()) === 'sqlite'
}

/** sqlite 模式：先写 content_kv（≤500/批，失败即停）；调用方必须在写 IDB 之前调用 */
async function writeDraftRowsToSqlite(rows: readonly ContentEntityRow[], label: string): Promise<void> {
  const saved = await saveContentEntitiesChunked([...rows])
  if (!saved.ok) throw draftWriteFailure(label, saved, rows.length)
}

interface DraftAppendBuild {
  /** 追加后的完整 pack 行（counts/draft/updatedAt 已更新） */
  pack: PackRecord
  /** 本次新增的 pack-item 记录 */
  records: PackItemRecord[]
  added: number
  /** 追加后的累计条目数 */
  done: number
}

/** 追加的纯计算部分：sqlite / idb 两条路径共用，保证落库内容与最终状态一致 */
function buildDraftAppend(
  pack: PackRecord,
  existing: readonly PackItemRecord[],
  items: readonly GenerationDraftItemInput[],
  now: number,
): DraftAppendBuild {
  const meta = draftMetaOf(pack)
  if (!meta) throw new Error(`内容包不是生成草稿：${pack.id}`)
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
      id: `${pack.id}:${seq}`,
      packId: pack.id,
      seq,
      headword: input.payload.headword || lower,
      headwordLower: lower,
      ...(input.meaningIndex != null ? { meaningIndex: input.meaningIndex } : {}),
      ...(input.wordId ? { wordId: input.wordId } : {}),
      ...(input.deckId ? { deckId: input.deckId } : {}),
      payload: input.payload,
      status: 'pending',
      contentHashes: [],
      createdAt: now,
    })
  }
  const counts = {
    ...pack.counts,
    items: pack.counts.items + records.length,
    pending: pack.counts.pending + records.length,
  }
  return {
    pack: { ...pack, counts, draft: { ...meta, updatedAt: now }, updatedAt: now },
    records,
    added: records.length,
    done: existing.length + records.length,
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
  // 0.14：sqlite 模式先写 content_kv 的完整 pack 行（含 draft 元数据），成功后才写 IDB cache；
  // 失败抛结构化错误，IDB 不落任何草稿（避免双源）
  if (await isSqliteContentSource()) {
    await writeDraftRowsToSqlite([draftContentRow(pack)], '新建生成草稿')
    // IDB cache 由 saveContentEntitiesChunked 在 SQLite 成功后写入（失败不回写）
    return (await toDto(pack))!
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
  if (!draftMetaOf(pack)) throw new Error(`内容包不是生成草稿：${draftId}`)
  if (items.length === 0) {
    return { done: await db.packItems.where('packId').equals(draftId).count(), added: 0 }
  }
  const now = Date.now()
  // 0.14：sqlite 模式下 native contentWrite 不能留在 Dexie rw 事务内。
  // 先构造完整行写 content_kv（失败抛结构化错误且不回写 IDB），成功后再写 IDB cache。
  if (await isSqliteContentSource()) {
    const existing = await db.packItems.where('packId').equals(draftId).toArray()
    const built = buildDraftAppend(pack, existing, items, now)
    await writeDraftRowsToSqlite(
      [draftContentRow(built.pack), ...built.records.map(draftItemContentRow)],
      '追加生成草稿条目',
    )
    // IDB cache（pack 行 + pack-item 行）由 saveContentEntitiesChunked 在 SQLite 成功后写入
    return { done: built.done, added: built.added }
  }
  return db.transaction('rw', [db.packs, db.packItems], async () => {
    const existing = await db.packItems.where('packId').equals(draftId).toArray()
    const built = buildDraftAppend(pack, existing, items, now)
    if (built.records.length > 0) await db.packItems.bulkPut(built.records)
    await db.packs.update(draftId, {
      counts: built.pack.counts,
      draft: built.pack.draft,
      updatedAt: now,
    })
    return { done: built.done, added: built.added }
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
  const nextPack: PackRecord = { ...pack, draft: next, updatedAt: now }
  // 0.14：sqlite 模式先写完整 pack 行（含 draft 断点），成功后才写 IDB cache；失败抛错且不回写 IDB
  if (await isSqliteContentSource()) {
    await writeDraftRowsToSqlite([draftContentRow(nextPack)], '更新生成草稿断点')
    return
  }
  await db.packs.update(draftId, { draft: next, updatedAt: now })
}

export interface GenerationDraftItem {
  id: string
  headwordLower: string
  meaningIndex?: number
  /** task-132：resume 合并/按 deck 分组用 */
  wordId?: string
  deckId?: string
  kind: GenerationKind
  payload: PackItemV1
}

function draftItemKind(payload: PackItemV1): GenerationKind {
  if ((payload.coreSenses ?? []).length > 0 || (payload.meaningMap ?? []).length > 0) return 'semantics'
  if ((payload.mnemonics ?? []).length > 0) return 'mnemonics'
  if ((payload.phrases ?? []).length > 0) return 'phrases'
  return 'examples'
}

/**
 * task-130：读取草稿中已生成但尚未应用的 items（resume 时并入审核/应用）。
 * 按 seq 升序；kind 由 payload 内容推断（生成时每 kind 单独成条）。
 */
export async function listGenerationDraftItems(draftId: string): Promise<GenerationDraftItem[]> {
  const db = getDb()
  const pack = await db.packs.get(draftId)
  if (!pack) throw new Error(`生成草稿不存在：${draftId}`)
  if (!pack.draft) throw new Error(`内容包不是生成草稿：${draftId}`)
  const rows = await db.packItems.where('packId').equals(draftId).toArray()
  rows.sort((a, b) => a.seq - b.seq)
  return rows.map((row) => ({
    id: row.id,
    headwordLower: row.headwordLower,
    ...(row.meaningIndex != null ? { meaningIndex: row.meaningIndex } : {}),
    ...(row.wordId ? { wordId: row.wordId } : {}),
    ...(row.deckId ? { deckId: row.deckId } : {}),
    kind: draftItemKind(row.payload),
    payload: row.payload,
  }))
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
  const db = getDb()
  const pack = await db.packs.get(draftId)
  if (!pack) return
  if (!pack.draft) throw new Error(`内容包不是生成草稿：${draftId}`)
  // 0.14：sqlite 模式先写 tombstone（pack + 全部 pack-item），成功后才删 IDB cache；
  // 失败抛结构化错误，IDB 草稿保持原样
  if (await isSqliteContentSource()) {
    const itemIds = await db.packItems.where('packId').equals(draftId).primaryKeys()
    const rows: ContentEntityRow[] = [
      ...itemIds.map((itemId) => draftItemDeletionRow(String(itemId))),
      draftDeletionRow(draftId),
    ]
    await writeDraftRowsToSqlite(rows, '删除生成草稿')
    // IDB cache（pack/pack-item 删除）由 saveContentEntitiesChunked 在 SQLite 成功后写入
    return
  }
  await db.transaction('rw', [db.packs, db.packItems], async () => {
    await db.packItems.where('packId').equals(draftId).delete()
    await db.packs.delete(draftId)
  })
}
