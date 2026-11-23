/**
 * task-138 B2 · 同一 deck 的 AI 生成内容合并到 **1 个 AI 内容包**。
 *
 * 解决：AiGeneratePanel 每次生成都 import 一个新 pack，列表出现大量「AI 生成 1/1」。
 * - `appendAiPack(input)`：新生成内容优先追加/合并到该 deck 已有的 AI pack（source='ai'，非 semantics），
 *   没有才新建；默认补审+应用（只补缺、幂等）。
 * - `mergeDuplicateAiPacks()`：把同一 deck 的重复 AI pack 合并成一个（union items），删除多余 pack 记录
 *   （已落库到 Word 的内容不受影响），内容包管理可一键调用。
 */
import { getDb } from './db'
import { computeChecksum } from './checksum'
import { packChecksumPayload } from './packs/schema'
import type { PackCounts, PackItemRecord, PackItemV1, PackRecord } from './packs/schema'
import { applyApproved, approveItems, deletePacks, importPack, listPackItems } from './packs.repo'

export interface AppendAiPackResult {
  packId: string
  /** true = 追加进已有 AI 包（未新建） */
  merged: boolean
  /** 本次新增/合并的 item 数 */
  imported: number
  applied: number
  skipped: number
  /** 合并后的包 item 数 */
  total: number
}

function itemKey(item: { headwordLower: string; meaningIndex?: number }): string {
  return `${item.headwordLower.toLowerCase()}#${item.meaningIndex ?? 0}`
}

function dataKey(kind: 'examples' | 'phrases' | 'mnemonics', value: { en?: string; type?: string; text?: string }): string {
  if (kind === 'mnemonics') return `${String(value.type ?? '')}:${String(value.text ?? '').trim().toLowerCase()}`
  return String(value.en ?? '').trim().toLowerCase()
}

function unionContent(base: PackItemV1, extra: PackItemV1): PackItemV1 {
  const next: PackItemV1 = { ...base }
  for (const kind of ['examples', 'phrases', 'mnemonics'] as const) {
    const current = Array.isArray(base[kind]) ? base[kind]! : []
    const incoming = Array.isArray(extra[kind]) ? extra[kind]! : []
    if (incoming.length === 0) continue
    const seen = new Set(current.map((entry) => dataKey(kind, entry as { en?: string; type?: string; text?: string })))
    const merged = [...current]
    for (const entry of incoming) {
      const key = dataKey(kind, entry as { en?: string; type?: string; text?: string })
      if (!key || seen.has(key)) continue
      seen.add(key)
      merged.push(entry)
    }
    if (merged.length > 0) {
      ;(next as Record<string, unknown>)[kind] = merged
    }
  }
  return next
}

function countStatuses(records: PackItemRecord[]): PackCounts {
  const counts: PackCounts = { items: records.length, pending: 0, approved: 0, applied: 0, rejected: 0, skipped: 0 }
  for (const record of records) counts[record.status] += 1
  return counts
}

async function refreshAiPackChecksum(packId: string): Promise<void> {
  const db = getDb()
  const pack = await db.packs.get(packId)
  if (!pack) return
  const records = await db.packItems.where('packId').equals(packId).toArray()
  const items = records.sort((a, b) => a.seq - b.seq).map((record) => record.payload)
  const checksum = (await computeChecksum(
    packChecksumPayload({ format: 'momo-pack', formatVersion: 1, kind: pack.kind, items }),
  )).hex
  await db.packs.update(packId, { checksum, counts: countStatuses(records), updatedAt: Date.now() })
}

/** 把 source pack 的 items 合并进 target pack（同 headwordLower+meaningIndex 合并内容，其余新增） */
async function mergePackItemsInto(targetId: string, sourceId: string): Promise<{ added: number; merged: number; total: number }> {
  const db = getDb()
  return db.transaction('rw', [db.packs, db.packItems], async () => {
    const target = await db.packs.get(targetId)
    const source = await db.packs.get(sourceId)
    if (!target || !source) throw new Error('合并失败：内容包不存在')
    const targetItems = await db.packItems.where('packId').equals(targetId).toArray()
    const sourceItems = await db.packItems.where('packId').equals(sourceId).toArray()
    const byKey = new Map(targetItems.map((item) => [itemKey(item), item]))
    let seq = targetItems.reduce((max, item) => Math.max(max, item.seq), 0)
    const now = Date.now()
    let added = 0
    let merged = 0
    const records: PackItemRecord[] = []
    for (const item of sourceItems) {
      const key = itemKey(item)
      const existing = byKey.get(key)
      if (existing) {
        merged += 1
        const payload = unionContent(existing.payload, item.payload)
        const next: PackItemRecord = {
          ...existing,
          payload,
          status: 'pending', // 合并后重新审核/应用，只补缺
          contentHashes: [...new Set([...(existing.contentHashes ?? []), ...(item.contentHashes ?? [])])],
          ...(item.wordId ? { wordId: item.wordId } : {}),
          ...(item.meaningId ? { meaningId: item.meaningId } : {}),
          ...(item.deckId ? { deckId: item.deckId } : {}),
        }
        records.push(next)
        byKey.set(key, next)
      } else {
        seq += 1
        const next: PackItemRecord = {
          ...item,
          id: `${targetId}:${seq}`,
          packId: targetId,
          seq,
          status: 'pending',
          createdAt: now,
        }
        records.push(next)
        byKey.set(key, next)
        added += 1
      }
    }
    if (records.length > 0) await db.packItems.bulkPut(records)
    const all = await db.packItems.where('packId').equals(targetId).toArray()
    await db.packs.update(targetId, {
      counts: countStatuses(all),
      status: 'reviewing',
      updatedAt: now,
    })
    return { added, merged, total: all.length }
  }).then(async (result) => {
    await refreshAiPackChecksum(targetId)
    return result
  })
}

function isAiContentPack(pack: PackRecord): boolean {
  return pack.source === 'ai' && pack.kind !== 'semantics' && !pack.draft
}

/**
 * 追加一次 AI 生成结果：优先合并到同 deck 已有 AI 内容包；没有则新建。
 * @param input 生成后的 momo-pack JSON（与 importContentPack 相同）
 */
export async function appendAiPack(
  input: string | Blob,
  opts: { apply?: boolean; name?: string } = {},
): Promise<AppendAiPackResult> {
  const imported = await importPack(input, { resolveAllDecks: true })
  if (!imported.ok || !imported.packId) {
    throw new Error(imported.issues[0]?.message ?? 'AI 内容包导入失败')
  }
  const tempPack = await getDb().packs.get(imported.packId)
  if (!tempPack) throw new Error('AI 内容包导入后丢失')
  if (opts.name && !tempPack.name) await getDb().packs.update(tempPack.id, { name: opts.name })
  const packs = await getDb().packs.toArray()
  const existing = packs
    .filter((pack) => pack.id !== tempPack.id && isAiContentPack(pack) && pack.deckId === tempPack.deckId)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  if (!existing) {
    if (opts.apply !== false) {
      const items = await listPackItems(tempPack.id)
      const pending = items.filter((item) => item.status === 'pending').map((item) => item.id)
      if (pending.length > 0) await approveItems(tempPack.id, pending)
      const applied = await applyApproved(tempPack.id, { allowOverLimit: true })
      const after = await getDb().packs.get(tempPack.id)
      return {
        packId: tempPack.id,
        merged: false,
        imported: items.length,
        applied: applied.applied,
        skipped: applied.skipped,
        total: after?.counts.items ?? items.length,
      }
    }
    return {
      packId: tempPack.id,
      merged: false,
      imported: imported.preview.counts.matched,
      applied: 0,
      skipped: 0,
      total: tempPack.counts.items,
    }
  }
  const merged = await mergePackItemsInto(existing.id, tempPack.id)
  await deletePacks([tempPack.id])
  const items = await listPackItems(existing.id)
  const pending = items.filter((item) => item.status === 'pending').map((item) => item.id)
  if (pending.length > 0) await approveItems(existing.id, pending)
  const applied = opts.apply === false ? { applied: 0, skipped: 0 } : await applyApproved(existing.id, { allowOverLimit: true })
  const after = await getDb().packs.get(existing.id)
  return {
    packId: existing.id,
    merged: true,
    imported: merged.added + merged.merged,
    applied: applied.applied,
    skipped: applied.skipped,
    total: after?.counts.items ?? merged.total,
  }
}

/**
 * 把刚导入的临时 AI pack 吸收到同 deck 已有 AI 包；没有已有包则保留临时包。
 * 返回应继续审核/应用的 packId。用于 AiGeneratePanel 保存时避免 1/1 新包。
 */
export async function absorbAiPack(packId: string): Promise<string> {
  const db = getDb()
  const temp = await db.packs.get(packId)
  if (!temp) throw new Error('AI 内容包不存在')
  const packs = await db.packs.toArray()
  const existing = packs
    .filter((pack) => pack.id !== temp.id && isAiContentPack(pack) && pack.deckId === temp.deckId)
    .sort((a, b) => a.createdAt - b.createdAt)[0]
  if (!existing) return temp.id
  await mergePackItemsInto(existing.id, temp.id)
  await deletePacks([temp.id])
  return existing.id
}

/** 合并/清理同 deck 的重复 AI 内容包（保留最早的一个；已落库 Word 内容不受影响） */
export async function mergeDuplicateAiPacks(): Promise<{
  groups: number
  removed: number
  kept: string[]
  mergedItems: number
}> {
  const packs = (await getDb().packs.toArray()).filter(isAiContentPack)
  const groups = new Map<string, PackRecord[]>()
  for (const pack of packs) {
    const key = pack.deckId ?? '__no_deck__'
    const list = groups.get(key) ?? []
    list.push(pack)
    groups.set(key, list)
  }
  let removed = 0
  let mergedItems = 0
  const kept: string[] = []
  for (const list of groups.values()) {
    if (list.length <= 1) {
      if (list[0]) kept.push(list[0].id)
      continue
    }
    list.sort((a, b) => b.counts.applied - a.counts.applied || a.createdAt - b.createdAt)
    const keeper = list[0]!
    kept.push(keeper.id)
    for (const other of list.slice(1)) {
      const result = await mergePackItemsInto(keeper.id, other.id)
      mergedItems += result.added + result.merged
      await deletePacks([other.id])
      removed += 1
    }
  }
  return { groups: groups.size, removed, kept, mergedItems }
}
