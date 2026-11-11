/**
 * 今日学习计划（SPEC-v2 §3.4 / §6.2 / ARCH-v2 §3.1）—— 纯函数，不查 DB。
 *
 * 数据层负责把 `plan` 与事实（dueCount/dailyGoal/hasDeck/hasLearnableWord/overdueLeft）
 * 查出来传给 `deriveHomeState`；文案例外由 UI 决定（core 只派生 6 态）。
 */

import { clamp } from './params'
import type { DailyPlan, HomeStudyState } from './types'

/** `deriveHomeState` 的输入：数据层只给事实（SPEC-v2 §6.2） */
export interface HomeStateInput {
  /** 当天、当前 deck 的 plan（没有则 null；**不主动建队**） */
  plan: DailyPlan | null
  /** 今日到期复习数（全部，不截断；= reviewQueue.length） */
  dueCount: number
  /** 设置 study.dailyGoal（1–9999） */
  dailyGoal: number
  /** 是否已有词库 */
  hasDeck: boolean
  /** 是否有可学词条（词库词数 > 0） */
  hasLearnableWord: boolean
  /** plan 完成后仍剩余的到期复习数（data 用 countDue 计算；未完成 plan 传 0） */
  overdueLeft: number
}

/**
 * 首页「学习按钮」6 态状态机（SPEC-v2 §6.2）。
 *
 * ```
 * 无词库 → no-deck；有词库但无可学词 → no-words
 * 无今日 plan（或 wordIds 空且未完成）→ fresh{pendingReview=dueCount, pendingNew=max(0,goal-due)}
 * plan 进行中：
 *   index===0 且无有效评分 → fresh
 *   否则 → ongoing{remaining,index,total}
 * plan 已完成：overdueLeft>0 → done-with-overdue{overdue}；否则 → done
 * ```
 */
export function deriveHomeState(input: HomeStateInput): HomeStudyState {
  const { plan } = input
  const goal = Math.max(0, Math.floor(Number.isFinite(input.dailyGoal) ? input.dailyGoal : 0))
  const due = Math.max(0, Math.floor(Number.isFinite(input.dueCount) ? input.dueCount : 0))
  const fresh = (): HomeStudyState => ({
    kind: 'fresh',
    pendingReview: due,
    pendingNew: Math.max(0, goal - due),
  })

  if (!input.hasDeck) return { kind: 'no-deck' }
  if (!input.hasLearnableWord) return { kind: 'no-words' }

  if (plan == null || (plan.wordIds.length === 0 && plan.completedAt == null)) {
    return fresh()
  }

  if (plan.completedAt == null) {
    const remaining = Math.max(0, plan.wordIds.length - clamp(plan.index, 0, plan.wordIds.length))
    const activeRatings = (plan.ratings ?? []).filter((r) => !r.corrected).length
    if (plan.index === 0 && activeRatings === 0) return fresh()
    return {
      kind: 'ongoing',
      remaining,
      index: plan.index,
      total: plan.wordIds.length,
    }
  }

  const overdue = Math.max(0, Math.floor(Number.isFinite(input.overdueLeft) ? input.overdueLeft : 0))
  if (overdue > 0) return { kind: 'done-with-overdue', overdue }
  return { kind: 'done' }
}

/** 当前该学的词（plan.wordIds[index]）；无 plan / 越界 → null（ARCH-v2 §3.1） */
export function getCurrentWordId(plan: DailyPlan | null | undefined): string | null {
  if (!plan) return null
  if (!Number.isInteger(plan.index) || plan.index < 0) return null
  return plan.wordIds[plan.index] ?? null
}
