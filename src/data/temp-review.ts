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

export interface TempReviewQueueItem {
  wordId: string
  occurrence: number
  /** 是否为本批次内自动重现 */
  isRequeue: boolean
}

export interface TempReviewOutcome {
  wordId: string
  queueIndex: number
  occurrence: number
  isRequeue: boolean
  rating: Rating | null
  durationMs: number
}

export interface TempReviewPracticeRating {
  wordId: string
  /** null=跳过（未自评） */
  rating: Rating | null
  durationMs: number
  selfRated: boolean
}

export interface TempReviewSession {
  id: string
  /** 过滤/去重后的有效词 id（保持输入顺序） */
  wordIds: string[]
  words: Word[]
  recordMode: TempReviewRecordMode
  createdAt: number
  /** practice 模式内存自评（不持久化；rate/rate-only 不用） */
  practiceRatings?: TempReviewPracticeRating[]
  /** 0.3.94/task-280：批次内自动重现开关 */
  autoRequeue?: boolean
  /** 当前批次队列（含自动重现 occurrence；不持久化） */
  queue?: TempReviewQueueItem[]
  /** 已评分 occurrence（不持久化） */
  outcomes?: TempReviewOutcome[]
  /** 是否已把本批应用到 DHP（幂等标记，不持久化） */
  dhpAppliedAt?: number
}

export interface StartTempReviewInput {
  wordIds: readonly string[]
  recordMode: TempReviewRecordMode
  /** 0.3.94/task-280：模糊/忘记在本批次内按 requeue gap 自动重现（不写 DHP） */
  autoRequeue?: boolean
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
    autoRequeue: input.autoRequeue === true,
    queue: words.map((word) => ({ wordId: word.id, occurrence: 1, isRequeue: false })),
    outcomes: [],
    ...(input.recordMode === 'practice' ? { practiceRatings: [] } : {}),
  }
}

/**
 * 批次内推进一次 occurrence：practice/rate/rate-only 通用。
 * - autoRequeue=true 且模糊/忘记 → 按 requeue gap 在队列后插入同词新 occurrence；
 * - 只更新内存 session（不写 DB/DHP）；rate/rate-only 的实际评分仍由 UI 调 rateTempReview。
 */
export function advanceTempReviewBatch(
  session: TempReviewSession,
  input: { queueIndex: number; rating: Rating; durationMs: number },
): TempReviewSession {
  if (input.queueIndex < 0) throw new Error('queueIndex 不合法')
  const queue = [...(session.queue ?? session.wordIds.map((wordId) => ({ wordId, occurrence: 1, isRequeue: false })))]
  const current = queue[input.queueIndex]
  if (!current) throw new Error(`queueIndex 越界：${input.queueIndex}`)
  const outcomes = [
    ...(session.outcomes ?? []),
    {
      wordId: current.wordId,
      queueIndex: input.queueIndex,
      occurrence: current.occurrence,
      isRequeue: current.isRequeue,
      rating: input.rating,
      durationMs: Math.max(0, Math.round(input.durationMs)),
    },
  ]
  if (session.autoRequeue && (input.rating === 'vague' || input.rating === 'forgot')) {
    // use core gap (vague 8 / forgot 4)
    const gap = requeueGapOf(input.rating)
    const insertAt = Math.min(input.queueIndex + 1 + gap, queue.length)
    queue.splice(insertAt, 0, {
      wordId: current.wordId,
      occurrence: current.occurrence + 1,
      isRequeue: true,
    })
  }
  return { ...session, queue, outcomes }
}

/** practice：逐词记录自评（仅内存 session，不写任何库表） */
export function recordPracticeSelfRating(
  session: TempReviewSession,
  input: { wordId: string; rating: Rating; durationMs: number },
): TempReviewSession {
  if (session.recordMode !== 'practice') throw new Error('仅 practice 模式支持逐词自评')
  if (!session.wordIds.includes(input.wordId)) throw new Error(`词不在本次临时复习中：${input.wordId}`)
  const next: TempReviewPracticeRating = {
    wordId: input.wordId,
    rating: input.rating,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    selfRated: true,
  }
  const list = [...(session.practiceRatings ?? [])]
  const index = list.findIndex((item) => item.wordId === input.wordId)
  if (index >= 0) list[index] = next
  else list.push(next)
  return { ...session, practiceRatings: list }
}

/** practice：「下一个」跳过（汇总显示未自评，不写库） */
export function skipPracticeWord(
  session: TempReviewSession,
  input: { wordId: string; durationMs: number },
): TempReviewSession {
  if (session.recordMode !== 'practice') throw new Error('仅 practice 模式支持跳过自评')
  if (!session.wordIds.includes(input.wordId)) throw new Error(`词不在本次临时复习中：${input.wordId}`)
  const next: TempReviewPracticeRating = {
    wordId: input.wordId,
    rating: null,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    selfRated: false,
  }
  const list = [...(session.practiceRatings ?? [])]
  const index = list.findIndex((item) => item.wordId === input.wordId)
  if (index >= 0) list[index] = next
  else list.push(next)
  return { ...session, practiceRatings: list }
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

// ============ 0.3.94/task-278：临时复习结束汇总 ============

import { familiarity, requeueGapOf, resolveCoreSenseStatKey } from '../core'
import type { MeaningStat } from '../core'
import { getEffectiveContent } from './packs.repo'

export interface TempReviewFamiliaritySnapshot {
  wordId: string
  capturedAt: number
  /** meaningId → 不熟悉度（无 encounters 为 null） */
  meaningFamiliarity: Record<string, number | null>
  /** 当前本义 → 不熟悉度（无统计为 null） */
  coreSenseFamiliarity: Array<{ coreSenseIndex: number; label: string; familiarity: number | null }>
  meaningStats: Record<string, MeaningStat>
  coreSenseStats: Record<string, MeaningStat>
}

export interface TempReviewRecordInput {
  wordId: string
  /** null=practice 跳过/未自评 */
  rating: Rating | null
  /** 本词用时（ms） */
  durationMs: number
  /** 评分前快照（captureTempReviewSnapshot）；正式/只记本次均可传 */
  before?: TempReviewFamiliaritySnapshot
}

export interface TempReviewSummaryItem {
  wordId: string
  headword: string
  rating: Rating | null
  durationMs: number
  recordMode: TempReviewRecordMode
  /** 本次是否更新长期 DHP（rate=true；rate-only/practice=false） */
  dhpAffected: boolean
  before: TempReviewFamiliaritySnapshot | null
  after: TempReviewFamiliaritySnapshot | null
}

export interface TempReviewSummary {
  sessionId: string
  recordMode: TempReviewRecordMode
  items: TempReviewSummaryItem[]
  totalDurationMs: number
  /** 0.3.94/task-280：批次 occurrence（含自动重现） */
  occurrences?: TempReviewOutcome[]
}

/** 记录评分前快照（只读；含义级/本义级不熟悉度） */
export async function captureTempReviewSnapshot(wordId: string): Promise<TempReviewFamiliaritySnapshot | null> {
  const db = getDb()
  const [word, state, effective] = await Promise.all([
    db.words.get(wordId),
    db.states.get(wordId),
    getEffectiveContent(wordId).catch(() => null),
  ])
  if (!word) return null
  const meaningStats = state?.meaningStats ?? {}
  const coreSenseStats = state?.coreSenseStats ?? {}
  const meaningFamiliarity: Record<string, number | null> = {}
  for (const meaning of word.meanings) {
    const stat = meaningStats[meaning.id]
    meaningFamiliarity[meaning.id] =
      stat && stat.encounters > 0 ? familiarity(stat.clicks, stat.encounters) : null
  }
  const coreSenseFamiliarity = (effective?.coreSenses ?? []).map((sense) => {
    const key = resolveCoreSenseStatKey(coreSenseStats, { index: sense.index, label: sense.label })
    const stat = key ? coreSenseStats[key] : undefined
    return {
      coreSenseIndex: sense.index,
      label: sense.label,
      familiarity: stat && stat.encounters > 0 ? familiarity(stat.clicks, stat.encounters) : null,
    }
  })
  return {
    wordId,
    capturedAt: Date.now(),
    meaningFamiliarity,
    coreSenseFamiliarity,
    meaningStats: { ...meaningStats },
    coreSenseStats: { ...coreSenseStats },
  }
}

/**
 * 生成结束汇总：每词前/后含义级+本义级不熟悉度、本次评分、是否影响 DHP、用时。
 * practice：完全只读（after=before，不写任何表）。
 */
export async function summarizeTempReview(
  session: TempReviewSession,
  records: readonly TempReviewRecordInput[],
): Promise<TempReviewSummary> {
  const sessionWord = new Map(session.words.map((word) => [word.id, word]))
  const items: TempReviewSummaryItem[] = []
  for (const record of records) {
    const word = sessionWord.get(record.wordId)
    const before = record.before ?? (await captureTempReviewSnapshot(record.wordId))
    const after =
      session.recordMode === 'practice' ? before : await captureTempReviewSnapshot(record.wordId)
    items.push({
      wordId: record.wordId,
      headword: word?.headword ?? before?.wordId ?? record.wordId,
      rating: record.rating,
      durationMs: Math.max(0, Math.round(record.durationMs)),
      recordMode: session.recordMode,
      dhpAffected: session.recordMode === 'rate',
      before: before ?? null,
      after: after ?? null,
    })
  }
  return {
    sessionId: session.id,
    recordMode: session.recordMode,
    items,
    totalDurationMs: items.reduce((sum, item) => sum + item.durationMs, 0),
    ...(session.outcomes && session.outcomes.length > 0 ? { occurrences: session.outcomes } : {}),
  }
}

/**
 * practice 专用：从 session 内存自评生成汇总（零写库）。
 * 未自评/跳过的词也会出现在 items，rating=null、selfRated=false。
 */
export async function summarizePracticeReview(session: TempReviewSession): Promise<TempReviewSummary> {
  if (session.recordMode !== 'practice') throw new Error('summarizePracticeReview 仅用于 practice 模式')
  const ratings = new Map((session.practiceRatings ?? []).map((item) => [item.wordId, item]))
  const records: TempReviewRecordInput[] = []
  for (const wordId of session.wordIds) {
    const item = ratings.get(wordId)
    const before = await captureTempReviewSnapshot(wordId)
    records.push({
      wordId,
      rating: item?.rating ?? null,
      durationMs: item?.durationMs ?? 0,
      ...(before ? { before } : {}),
    })
  }
  return summarizeTempReview(session, records)
}

// ============ 0.3.94/task-280：把本批评分/自评应用到 DHP（幂等） ============

export interface ApplyTempReviewToDhpResult {
  ok: boolean
  applied: number
  skippedAlreadyApplied: number
  skippedNoRating: number
  skippedAlreadyDhp: number
  session: TempReviewSession
  errors: Array<{ wordId: string; error: string }>
}

/**
 * 把本批次“每个词最终一次评分/自评”应用到 DHP：
 * - practice：应用自评（此前零写库）；
 * - rate-only：补写正常 DHP 调度（此前只 skip 记录）；
 * - rate：已应用，跳过不重复；
 * - 幂等：同一 session 标记 dhpAppliedAt，重复点击不再写。
 */
export async function applyTempReviewToDhp(
  session: TempReviewSession,
  records?: readonly TempReviewRecordInput[],
): Promise<ApplyTempReviewToDhpResult> {
  const base = { session }
  if (session.dhpAppliedAt != null) {
    return {
      ok: true,
      applied: 0,
      skippedAlreadyApplied: session.wordIds.length,
      skippedNoRating: 0,
      skippedAlreadyDhp: session.wordIds.length,
      errors: [],
      ...base,
    }
  }
  if (session.recordMode === 'rate') {
    return {
      ok: true,
      applied: 0,
      skippedAlreadyApplied: session.wordIds.length,
      skippedNoRating: 0,
      skippedAlreadyDhp: session.wordIds.length,
      errors: [],
      ...base,
    }
  }
  const latest = new Map<string, { rating: Rating; at: number }>()
  for (const outcome of session.outcomes ?? []) {
    if (!outcome.rating) continue
    const prev = latest.get(outcome.wordId)
    if (!prev || outcome.queueIndex >= (prev.at ?? 0)) latest.set(outcome.wordId, { rating: outcome.rating, at: outcome.queueIndex })
  }
  for (const entry of session.practiceRatings ?? []) {
    if (!entry.rating) continue
    if (!latest.has(entry.wordId)) latest.set(entry.wordId, { rating: entry.rating, at: 0 })
  }
  for (const record of records ?? []) {
    if (!record.rating) continue
    latest.set(record.wordId, { rating: record.rating, at: Number.MAX_SAFE_INTEGER })
  }
  let applied = 0
  let skippedNoRating = 0
  const errors: Array<{ wordId: string; error: string }> = []
  for (const wordId of session.wordIds) {
    const item = latest.get(wordId)
    if (!item) {
      skippedNoRating += 1
      continue
    }
    try {
      await submitRating(wordId, item.rating, Date.now(), { scheduleMode: 'normal' })
      applied += 1
    } catch (error) {
      errors.push({ wordId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  if (errors.length === 0) session.dhpAppliedAt = Date.now()
  return {
    ok: errors.length === 0,
    applied,
    skippedAlreadyApplied: 0,
    skippedNoRating,
    skippedAlreadyDhp: 0,
    session,
    errors,
  }
}
