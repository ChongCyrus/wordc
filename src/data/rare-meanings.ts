/** 0.3.61：不常考含义标记 + 学习/记忆过滤。注释面仍显示全部，只有记忆/加权记忆可隐藏。 */
import { getDb } from './db'
import type { Meaning, Word } from '../core/types'

async function getWordOrThrow(wordId: string): Promise<Word> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  return word
}

export async function getRareMeaningIds(wordId: string): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  const valid = new Set(word.meanings.map((meaning) => meaning.id))
  return (word.rareMeaningIds ?? []).filter((id) => valid.has(id))
}

/** 设置 rare 含义 id（去重/过滤非法；空数组=清空）；返回保存值 */
export async function setRareMeaningIds(wordId: string, meaningIds: string[]): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  const valid = new Set(word.meanings.map((meaning) => meaning.id))
  const next = [...new Set(meaningIds)].filter((id) => valid.has(id))
  if (next.length > 0) word.rareMeaningIds = next
  else delete word.rareMeaningIds
  await getDb().words.put(word)
  return next
}

/** AI 输出 rareMeaningIndexes（1 起）→ 含义 id 后保存；方便批量标记调用 */
export async function setRareMeaningIndexes(wordId: string, indexes: number[]): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  const ids = indexes
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= word.meanings.length)
    .map((index) => word.meanings[index - 1]!.id)
  return setRareMeaningIds(wordId, ids)
}

/** 用户手动切换某含义的 rare 标记（dev-ui 点按用；与 AI 批量应用同一套规范化） */
export async function toggleRareMeaningId(wordId: string, meaningId: string, rare?: boolean): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  if (!word.meanings.some((meaning) => meaning.id === meaningId)) {
    throw new Error(`含义不存在：${meaningId}`)
  }
  const current = new Set(word.rareMeaningIds ?? [])
  const next = rare ?? !current.has(meaningId)
  if (next) current.add(meaningId)
  else current.delete(meaningId)
  return setRareMeaningIds(wordId, [...current])
}

export async function clearRareMeaningIds(wordId: string): Promise<void> {
  await setRareMeaningIds(wordId, [])
}

/** 纯函数：hideRareMeanings=true 时过滤 rareMeaningIds 对应 c；否则原样返回 */
export function filterStudyMeanings(word: Word, hideRareMeanings = true): Meaning[] {
  if (!hideRareMeanings || !word.rareMeaningIds || word.rareMeaningIds.length === 0) return word.meanings
  const rare = new Set(word.rareMeaningIds)
  return word.meanings.filter((meaning) => !rare.has(meaning.id))
}

/** 异步便捷版（useStudySession/记忆队列用） */
export async function getStudyMeanings(wordId: string, hideRareMeanings = true): Promise<Meaning[]> {
  const word = await getWordOrThrow(wordId)
  return filterStudyMeanings(word, hideRareMeanings)
}

// ============ 0.3.69：不常考「本义」（coreSenses）标记 ============

import { getEffectiveContent } from './packs.repo'
import type { RareCoreSense } from '../core/types'

export type { RareCoreSense } from '../core/types'

export interface RareCoreSenseView {
  coreSenseIndex: number
  label: string
  gloss?: string
  origin?: string
  marked: boolean
  match?: 'label' | 'index'
}

export interface RareCoreSenseViews {
  current: RareCoreSenseView[]
  /** 对不上当前 coreSenses 的旧标记（本义被替换/删除；保留可见可清） */
  stale: RareCoreSense[]
}

export async function listRareCoreSenses(wordId: string): Promise<RareCoreSense[]> {
  const word = await getWordOrThrow(wordId)
  return word.rareCoreSenses ?? []
}

/** 当前 coreSenses 与 marked 视图；label 优先、index 兜底；对不上→stale */
export async function listRareCoreSenseViews(wordId: string): Promise<RareCoreSenseViews> {
  const word = await getWordOrThrow(wordId)
  const effective = await getEffectiveContent(wordId)
  const coreSenses = effective?.coreSenses ?? []
  const entries = [...(word.rareCoreSenses ?? [])]
  const used = new Set<RareCoreSense>()
  const matchedByIndex = new Array<{ entry: RareCoreSense; match: 'label' | 'index' } | null>(coreSenses.length).fill(null)
  // 1) label 优先（一次性先占位，避免 index 兜底把 label 匹配项抢走）
  coreSenses.forEach((sense, senseIndex) => {
    const byLabel = entries.find((entry) => !used.has(entry) && entry.label === sense.label)
    if (byLabel) {
      used.add(byLabel)
      matchedByIndex[senseIndex] = { entry: byLabel, match: 'label' }
    }
  })
  // 2) index 兜底（仅对还没有 label 匹配的当前本义）
  coreSenses.forEach((sense, senseIndex) => {
    if (matchedByIndex[senseIndex]) return
    const byIndex = entries.find((entry) => !used.has(entry) && entry.coreSenseIndex === sense.index)
    if (byIndex) {
      used.add(byIndex)
      matchedByIndex[senseIndex] = { entry: byIndex, match: 'index' }
    }
  })
  const current: RareCoreSenseView[] = coreSenses.map((sense, senseIndex) => {
    const matched = matchedByIndex[senseIndex]
    return {
      coreSenseIndex: sense.index,
      label: sense.label,
      ...(sense.note ? { gloss: sense.note } : {}),
      ...(sense.origin ? { origin: sense.origin } : {}),
      marked: Boolean(matched),
      ...(matched ? { match: matched.match } : {}),
    }
  })
  return { current, stale: entries.filter((entry) => !used.has(entry)) }
}

/** 当前匹配上的本义序号（badge 用；stale 不含） */
export async function getRareCoreSenseIndexes(wordId: string): Promise<number[]> {
  const views = await listRareCoreSenseViews(wordId)
  return views.current.filter((view) => view.marked).map((view) => view.coreSenseIndex)
}

/** 手动设置标记（label 快照；过滤非法/去重） */
export async function setRareCoreSenses(
  wordId: string,
  entries: Array<{ coreSenseIndex: number; label: string; updatedAt?: number }>,
): Promise<RareCoreSense[]> {
  const word = await getWordOrThrow(wordId)
  const seen = new Set<number>()
  const list: RareCoreSense[] = []
  for (const entry of entries) {
    const label = String(entry.label ?? '').trim()
    if (!label || !Number.isInteger(entry.coreSenseIndex) || entry.coreSenseIndex < 1) continue
    if (seen.has(entry.coreSenseIndex)) continue
    seen.add(entry.coreSenseIndex)
    list.push({
      coreSenseIndex: entry.coreSenseIndex,
      label,
      updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    })
  }
  if (list.length > 0) word.rareCoreSenses = list
  else delete word.rareCoreSenses
  await getDb().words.put(word)
  return list
}

/** AI 输出 rareCoreSenseIndexes（1 起）→ 当前 coreSenses label 快照后落库；非法索引过滤 */
export async function setRareCoreSenseIndexes(wordId: string, indexes: number[]): Promise<RareCoreSense[]> {
  const effective = await getEffectiveContent(wordId)
  const coreSenses = effective?.coreSenses ?? []
  if (indexes.length === 0) {
    await setRareCoreSenses(wordId, [])
    return []
  }
  const entries = [...new Set(indexes)]
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= coreSenses.length)
    .map((index) => ({ coreSenseIndex: index, label: coreSenses[index - 1]!.label }))
  return setRareCoreSenses(wordId, entries)
}

export async function clearRareCoreSenses(wordId: string): Promise<void> {
  await setRareCoreSenses(wordId, [])
}
