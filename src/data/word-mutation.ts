/** 0.10.0：词表替换只做 diff（upsert + 仅删多余），避免 words 短暂整段空缺/误清库 */
import type { Word } from '../core/types'
import { getDb } from './db'

export interface WordDiffResult {
  upserted: number
  removed: number
  plansTouched: number
  statesRemoved: number
  logsRemoved: number
}

/** 在调用方事务内执行；newWords 为该 deck 的完整新词表 */
export async function diffReplaceDeckWords(
  deckId: string,
  newWords: readonly Word[],
  reason: string,
): Promise<WordDiffResult> {
  const table = getDb()
  const oldIds = (await table.words.where('deckId').equals(deckId).primaryKeys()) as string[]
  const newIds = new Set(newWords.map((word) => word.id))
  const removed = oldIds.filter((wordId) => !newIds.has(wordId))
  // 1) 先 upsert 新词（任何时刻不出现整段空缺；同 wordId 的 states 保留）
  const CHUNK = 500
  for (let i = 0; i < newWords.length; i += CHUNK) {
    await table.words.bulkPut(newWords.slice(i, i + CHUNK))
  }
  if (removed.length === 0) {
    await appendMutationDiag(table, { reason, deckId, upserted: newWords.length, removed: 0, at: Date.now() })
    return { upserted: newWords.length, removed: 0, plansTouched: 0, statesRemoved: 0, logsRemoved: 0 }
  }
  // 2) 只删除新词表不存在的旧词，并清理其 states/logs；plans 重映射
  await table.words.bulkDelete(removed)
  const statesRemoved = await table.states.where('wordId').anyOf(removed).delete()
  let logsRemoved = 0
  try {
    logsRemoved = await table.reviewLogs.where('wordId').anyOf(removed).delete()
  } catch {
    /* 旧库缺索引时跳过日志清理，不阻塞 */
  }
  const plansTouched = await scrubPlansForRemovedWords(removed, { deckId, now: Date.now() })
  await appendMutationDiag(table, {
    reason,
    deckId,
    upserted: newWords.length,
    removed: removed.length,
    plansTouched,
    statesRemoved,
    logsRemoved,
    at: Date.now(),
  })
  return { upserted: newWords.length, removed: removed.length, plansTouched, statesRemoved, logsRemoved }
}

async function appendMutationDiag(
  table: ReturnType<typeof getDb>,
  value: Record<string, unknown>,
): Promise<void> {
  try {
    await table.meta.put({ key: 'diag.lastWordMutation', value, updatedAt: Date.now() })
  } catch {
    /* 诊断失败不阻塞 */
  }
}

/** 0.10.0：统一计划压缩——移除不存在/被删 wordId，重映射 sources/index/ratings/completedAt */
export async function scrubPlansForRemovedWords(
  removedIds: readonly string[],
  opts: { deckId?: string; now?: number } = {},
): Promise<number> {
  if (removedIds.length === 0) return 0
  const table = getDb()
  const removed = new Set(removedIds)
  const plans = opts.deckId
    ? await table.plans.where('deckId').equals(opts.deckId).toArray()
    : await table.plans.toArray()
  let touched = 0
  for (const plan of plans) {
    if (!plan.wordIds.some((wordId) => removed.has(wordId))) continue
    const kept = plan.wordIds.filter((wordId) => !removed.has(wordId))
    const sources = { ...plan.sources }
    for (const wordId of removed) delete sources[wordId]
    let index = 0
    for (let i = 0; i < Math.min(plan.index, plan.wordIds.length); i += 1) {
      if (!removed.has(plan.wordIds[i]!)) index += 1
    }
    await table.plans.put({
      ...plan,
      wordIds: kept,
      sources,
      index,
      ratings: plan.ratings.filter((rating) => !removed.has(rating.wordId)),
      completedAt: kept.length > 0 && index >= kept.length ? plan.completedAt : null,
      updatedAt: opts.now ?? Date.now(),
    })
    touched += 1
  }
  return touched
}
