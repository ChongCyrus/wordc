/** task-164：nc（用户标记“不能从生成元直接理解”的含义）。存 Word 字段，不进 packItems，AI apply 不覆盖。 */
import { getDb } from './db'
import type { Word } from '../core/types'

async function getWordOrThrow(wordId: string): Promise<Word> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  return word
}

/** 读取 nc 含义 id 列表（按 Word.meanings 顺序返回，过滤已不存在的 id） */
export async function getNcMeaningIds(wordId: string): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  const order = new Map(word.meanings.map((meaning) => [meaning.id, meaning.id]))
  return (word.ncMeaningIds ?? []).filter((id) => order.has(id))
}

/** 设置 nc（去重/过滤非法含义 id；传空数组 = 清空）；返回保存后的列表 */
export async function setNcMeaningIds(wordId: string, meaningIds: string[]): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  const valid = new Set(word.meanings.map((meaning) => meaning.id))
  const next = [...new Set(meaningIds)].filter((id) => valid.has(id))
  if (next.length > 0) word.ncMeaningIds = next
  else delete word.ncMeaningIds
  await getDb().words.put(word)
  return next
}

export async function clearNcMeaningIds(wordId: string): Promise<void> {
  await setNcMeaningIds(wordId, [])
}

// 兼容简短 API 名（dev-ui 可直接用）
export const getNc = getNcMeaningIds
export const setNc = setNcMeaningIds
export const clearNc = clearNcMeaningIds
