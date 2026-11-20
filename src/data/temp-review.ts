/**
 * task-254（0.3.89）：临时复习（一次性 session，不进入今日计划）。
 *
 * 选择模式：加入今日计划（现有）| 立即复习；立即复习再选记录方式：
 * - practice：只练不记录（**完全不写库**：state/reviewLogs/meaningStats/plan 都不写）
 * - rate：正常评分并更新复习计划（本词 DHP），但不动今日 DailyPlan
 * - rate-only：评分但**不改复习时间**（scheduleMode='skip'，只写 reviewLog + updatedAt）
 *
 * temp session 不持久化（一次性内存）；杀进程丢失可接受。
 */
import type { Rating, Word } from '../core'
import { getDb } from './db'
import { submitRating, type SubmitRatingResult } from './study.repo'

export type TempReviewRecordMode = 'practice' | 'rate' | 'rate-only'

export interface TempReviewSession {
  id: string
  /** 过滤/去重后的有效词 id（保持输入顺序） */
  wordIds: string[]
  words: Word[]
  recordMode: TempReviewRecordMode
  createdAt: number
}

export interface StartTempReviewInput {
  wordIds: readonly string[]
  recordMode: TempReviewRecordMode
}

const RECORD_MODES: ReadonlySet<string> = new Set(['practice', 'rate', 'rate-only'])

function assertRecordMode(mode: string): asserts mode is TempReviewRecordMode {
  if (!RECORD_MODES.has(mode)) throw new Error(`未知临时复习记录方式：${mode}`)
}

/**
 * 创建一次性临时复习 session：去重/过滤不存在词；**不创建/修改 DailyPlan，不写 states/logs**。
 * 返回带 Word 列表，供 StudyPage tempMode 队列使用。
 */
export async function startTempReview(input: StartTempReviewInput): Promise<TempReviewSession> {
  assertRecordMode(input.recordMode)
  const ids = [...new Set((input.wordIds ?? []).filter((id): id is string => typeof id === 'string' && id.length > 0))]
  if (ids.length === 0) throw new Error('没有可复习的词')
  const db = getDb()
  const rows = await db.words.bulkGet(ids)
  const words: Word[] = []
  for (const row of rows) if (row) words.push(row)
  if (words.length === 0) throw new Error('所选词条不存在')
  const now = Date.now()
  return {
    id: `temp:${now}:${words.length}`,
    wordIds: words.map((word) => word.id),
    words,
    recordMode: input.recordMode,
    createdAt: now,
  }
}

export interface RateTempReviewInput {
  wordId: string
  rating: Rating
  recordMode: TempReviewRecordMode
  now?: number
}

/**
 * 临时复习评分：
 * - practice：返回 null，**零写库**；
 * - rate：正常 submitRating（不传 planId，不推进今日计划）；
 * - rate-only：submitRating({scheduleMode:'skip'})，调度字段全部保留，只写 reviewLog/updatedAt。
 */
export async function rateTempReview(input: RateTempReviewInput): Promise<SubmitRatingResult | null> {
  assertRecordMode(input.recordMode)
  const now = input.now ?? Date.now()
  if (input.recordMode === 'practice') return null
  if (input.recordMode === 'rate-only') {
    return submitRating(input.wordId, input.rating, now, { scheduleMode: 'skip' })
  }
  // rate：只在临时 session 内评分；不传 planId，天然不动今日 plan
  return submitRating(input.wordId, input.rating, now)
}
