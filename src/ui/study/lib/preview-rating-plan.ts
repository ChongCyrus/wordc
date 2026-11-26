import { scheduleNext } from '../../../core'
import type { Rating, WordState } from '../../../core'
import { applyRatingToPlan } from '../../../data/plan-core'
import type { DailyPlan } from '../../../data'

/**
 * 0.16 实验：三键后先本地推演下一版 plan（不写库）。
 * 与 submitRatingSqlite 的 forceOneMoreRecall/forceRequeueOnRequeuedOccurrence/insertRequeue 对齐。
 */
export function previewRatingPlan(input: {
  plan: DailyPlan
  wordId: string
  rating: Rating
  state: WordState
  now: number
}): { plan: DailyPlan; state: WordState; longTermUpdate: boolean; insertRequeue: boolean } {
  const { plan, wordId, rating, state, now } = input
  const result = scheduleNext(state, rating, now, undefined, { scheduleMode: 'normal' })
  const failedLastTime = state.lastRating === 'vague' || state.lastRating === 'forgot'
  const forceOneMoreRecall =
    result.requeue === 'none' &&
    result.completesToday &&
    !result.longTermUpdate &&
    failedLastTime &&
    (state.todayProgress ?? 0) < 1
  const forceRequeueOnRequeuedOccurrence =
    rating === 'familiar' && !result.longTermUpdate && failedLastTime && plan.sources[wordId] === 'requeue'
  const insertRequeue =
    result.requeue !== 'none' ||
    result.completesToday === false ||
    forceOneMoreRecall ||
    forceRequeueOnRequeuedOccurrence
  return {
    state: result.state,
    plan: applyRatingToPlan(plan, {
      wordId,
      rating,
      reviewedAt: now,
      longTermUpdate: result.longTermUpdate,
      insertRequeue,
    }),
    longTermUpdate: result.longTermUpdate,
    insertRequeue,
  }
}

/** 乐观 plan 与真实 submit 返回 plan 是否等价（只比较推进相关字段，避免引用不同导致误重载） */
export function sameOptimisticPlan(
  a: DailyPlan | null,
  b: DailyPlan | null,
): boolean {
  if (!a || !b) return a === b
  if (a.index !== b.index || a.wordIds.length !== b.wordIds.length) return false
  if (a.ratings.length !== b.ratings.length) return false
  const tail = Math.min(12, b.wordIds.length)
  for (let i = 0; i < tail; i += 1) {
    if (a.wordIds[a.wordIds.length - 1 - i] !== b.wordIds[b.wordIds.length - 1 - i]) return false
  }
  return true
}

/** 失败回滚决策：只有「尚未提交成功 + 已乐观翻页 + 有 pre-plan」才回到上一词 */
export function rollbackPlanAfterFailure<T>(
  planBefore: T | null,
  optimisticApplied: boolean,
  submitted: boolean,
): T | null {
  if (submitted || !optimisticApplied || !planBefore) return null
  return planBefore
}
