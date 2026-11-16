/** task-164 A8：局部词（当前词包含的其它 deck 词，如 marginal→margin / discourse→course） */
import { getDb } from './db'
import { normalizeHeadword } from '../core'

export interface SubwordMeaning {
  id: string
  headword: string
  pos?: string
  cn: string
}

/**
 * 找当前 deck 中「作为目标词子串」的 headword。
 * @param wordOrHeadword 词 id（含 ':'）或 headword
 * @param deckId 目标词库；传 wordId 时缺省用该词 deckId
 * @param limit 默认 20，最大 50
 * 过滤自身、长度 <2；按候选词长度降序再 headword 升序稳定排序。
 */
export async function findSubwordMeanings(
  wordOrHeadword: string,
  deckId?: string,
  limit = 20,
): Promise<SubwordMeaning[]> {
  const db = getDb()
  const isWordId = wordOrHeadword.includes(':')
  const targetWord = isWordId ? await db.words.get(wordOrHeadword) : undefined
  const target = normalizeHeadword(targetWord?.headword ?? wordOrHeadword)
  const targetDeckId = deckId ?? targetWord?.deckId
  if (!targetDeckId) throw new Error('findSubwordMeanings 需要 deckId')
  if (!target) return []
  const words = await db.words.where('deckId').equals(targetDeckId).toArray()
  const results: SubwordMeaning[] = []
  for (const word of words) {
    const lower = word.headwordLower
    if (lower === target) continue
    if (lower.length < 2) continue
    if (!target.includes(lower)) continue
    const meaning = word.meanings[0]
    results.push({
      id: word.id,
      headword: word.headword,
      ...(meaning?.pos ? { pos: meaning.pos } : {}),
      cn: meaning?.cn ?? '',
    })
  }
  results.sort((a, b) => b.headword.length - a.headword.length || a.headword.localeCompare(b.headword))
  const max = Math.max(1, Math.min(50, Math.floor(limit)))
  return results.slice(0, max)
}
