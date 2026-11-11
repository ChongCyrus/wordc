/**
 * 今日计划的纯函数（不碰 DB）——给 `study.repo.submitRating` 与 `plans.repo` 共用，
 * 保证「评分 → 索引推进 → 回炉插入 → 完成判定」只有一套逻辑（SPEC-v2 §3.4 / §6）。
 */

import { requeueGapOf } from '../core'
import type { AlgoParams } from '../core'
import type { Rating } from '../core'
import type { DailyPlan, PlanRating } from './plan.types'

/** plan 主键：`${date}:${deckId}` */
export function planIdOf(date: string, deckId: string): string {
  return `${date}:${deckId}`
}

/** 当前应学习的词 id（index 越界 → null，表示队列已完成） */
export function currentWordIdOf(plan: DailyPlan): string | null {
  if (plan.index < 0 || plan.index >= plan.wordIds.length) return null
  return plan.wordIds[plan.index] ?? null
}

/** 未撤销的评分记录 */
export function effectiveRatings(plan: DailyPlan): PlanRating[] {
  return plan.ratings.filter((rating) => rating.corrected !== true)
}

/** 已评分去重词数（撤销的不算） */
export function ratedWordCount(plan: DailyPlan): number {
  return new Set(effectiveRatings(plan).map((rating) => rating.wordId)).size
}

export interface ApplyRatingInput {
  wordId: string
  rating: Rating
  reviewedAt: number
  longTermUpdate: boolean
  /** 是否按 rating 插入当日回炉（认识不插；模糊/忘记插；默认 true） */
  insertRequeue?: boolean
  params?: Partial<AlgoParams>
}

/**
 * 应用一次评分到 plan（**返回新对象，不改入参**）：
 * - `ratings` 追加；
 * - `index + 1`；
 * - 模糊/忘记 → 同 wordId 插入到 `index + gap` 位置（允许重复），`sources` 记 requeue；
 * - index 走完 → `completedAt = reviewedAt`。
 */
export function applyRatingToPlan(plan: DailyPlan, input: ApplyRatingInput): DailyPlan {
  const wordIds = [...plan.wordIds]
  const sources: DailyPlan['sources'] = { ...plan.sources }
  const next: DailyPlan = {
    ...plan,
    wordIds,
    sources,
    ratings: [
      ...plan.ratings,
      {
        wordId: input.wordId,
        rating: input.rating,
        reviewedAt: input.reviewedAt,
        longTermUpdate: input.longTermUpdate,
      },
    ],
    index: Math.min(plan.index + 1, wordIds.length),
    updatedAt: input.reviewedAt,
  }
  if (input.insertRequeue !== false && input.rating !== 'familiar') {
    const gap = requeueGapOf(input.rating, input.params)
    const position = Math.min(next.index + Math.max(0, gap), wordIds.length)
    wordIds.splice(position, 0, input.wordId)
    sources[input.wordId] = 'requeue'
  }
  if (next.index >= wordIds.length) {
    next.index = wordIds.length
    next.completedAt = input.reviewedAt
  } else {
    next.completedAt = null
  }
  return next
}

/** 插入一条当日回炉（不推进 index） */
export function insertRequeueIntoPlan(
  plan: DailyPlan,
  input: { wordId: string; gap: number; reviewedAt: number },
): DailyPlan {
  const wordIds = [...plan.wordIds]
  const position = Math.min(plan.index + Math.max(0, input.gap), wordIds.length)
  wordIds.splice(position, 0, input.wordId)
  return {
    ...plan,
    wordIds,
    sources: { ...plan.sources, [input.wordId]: 'requeue' },
    updatedAt: input.reviewedAt,
  }
}

export interface UndoInPlanInput {
  wordId: string
  /** 要撤销的评分时间（用于精确定位 ratings 项；缺省取该词最后一条未撤销记录） */
  reviewedAt?: number
}

export interface UndoInPlanResult {
  plan: DailyPlan
  /** 被撤销的 rating 记录（找不到时返回 null） */
  removed: PlanRating | null
  /** 回退后的 index */
  index: number
}

/**
 * 撤销 plan 里某词最近一次未撤销的评分（**纯函数**）：
 * - 该 rating 标 `corrected: true`（不删）；
 * - index 回退到该词在 wordIds 中「最近一次出现」的位置（重复回炉时撤销最近一次）；
 * - 删除该次评分产生的回炉插入（wordIds 中该词最后一个重复项）；
 * - `completedAt = null`。
 * 找不到可撤销记录时原样返回（removed=null）。
 */
export function undoInPlan(plan: DailyPlan, input: UndoInPlanInput): UndoInPlanResult {
  const ratings = plan.ratings.map((item) => ({ ...item }))
  let targetIndex = -1
  for (let i = ratings.length - 1; i >= 0; i -= 1) {
    const item = ratings[i]!
    if (item.wordId !== input.wordId || item.corrected === true) continue
    if (input.reviewedAt != null && item.reviewedAt !== input.reviewedAt) continue
    targetIndex = i
    break
  }
  if (targetIndex < 0) return { plan, removed: null, index: plan.index }
  const target = ratings[targetIndex]!
  ratings[targetIndex] = { ...target, corrected: true }

  const wordIds = [...plan.wordIds]
  // 回退到该词最近一次出现的位置（index 之前）
  let position = -1
  for (let i = Math.min(plan.index, wordIds.length) - 1; i >= 0; i -= 1) {
    if (wordIds[i] === input.wordId) {
      position = i
      break
    }
  }
  if (position < 0) {
    // 理论上不会发生；保守回退到 0
    position = 0
  }
  // 删除该次评分产生的回炉插入（该词在 position 之后的最后一次出现）
  const nextIndex = wordIds.indexOf(input.wordId, position + 1)
  if (nextIndex >= 0) wordIds.splice(nextIndex, 1)

  return {
    plan: {
      ...plan,
      wordIds,
      ratings,
      index: position,
      completedAt: null,
      updatedAt: Math.max(plan.updatedAt, target.reviewedAt),
    },
    removed: target,
    index: position,
  }
}
