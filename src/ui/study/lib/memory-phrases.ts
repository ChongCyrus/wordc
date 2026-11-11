/**
 * w-c 记忆页词组过滤（task-43）。
 *
 * 规则：只显示 `phrase.meaningId === 当前含义 id` 的词组；
 * `meaningId` 缺失/null 的视为词级词组 —— **不硬猜，直接隐藏**。
 * 注释面不受影响（仍显示该词全部词组）。
 */
import type { PhraseView } from '../components/types'

export interface PhraseWithMeaning {
  en: string
  cn: string
  /** task-42 起由数据层提供：所属含义 id；null/undefined = 词级，w-c 不显示 */
  meaningId?: string | null
}

/** 返回当前含义对应的词组（最多 limit 条；无匹配返回空数组） */
export function phrasesForMeaning(
  phrases: readonly PhraseWithMeaning[],
  meaningId: string | null | undefined,
  limit = 3,
): PhraseView[] {
  if (!meaningId) return []
  const safeLimit = Math.max(0, Math.floor(limit))
  if (safeLimit === 0) return []
  const result: PhraseView[] = []
  for (const phrase of phrases) {
    if (phrase.meaningId !== meaningId) continue
    result.push({ en: phrase.en, cn: phrase.cn })
    if (result.length >= safeLimit) break
  }
  return result
}
