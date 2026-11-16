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
