/**
 * 首页固定 KPI 取值（task-50 修复 QA P1）。
 *
 * 规则（Lead 规格）：
 * - 待复习 = `getHomeStudyData().dueCount`
 * - 待新学：
 *   - **有今日 plan** → `breakdown.new.remaining`（plan 内未学新词）
 *   - **无 plan**（新用户/跨天未开始）→ `newBudget = max(0, goal - dueCount)`
 * - 今日已学 = `getHomeStudyData().todayReviewed`
 *
 * ⚠️ 无 plan 时 data 返回 `emptyBreakdown`，其 `new.remaining = 0`（不是 null），
 * 因此不能用 `??` 直接回退，必须先判断有没有 plan。
 */

export interface PendingNewInput {
  /** 今天是否有 plan（homeData.plan != null） */
  hasPlan: boolean
  /** getTodayBreakdown()/HomeStudyData.breakdown 的 new.remaining（可能为 0） */
  breakdownRemaining?: number | null
  /** getHomeStudyData().newBudget = max(0, goal - dueCount) */
  newBudget?: number | null
  /** 兜底（旧队列 newCount） */
  fallbackNewCount?: number | null
}

function safeCount(value: number | null | undefined, fallback = 0): number {
  const candidate = value ?? fallback
  if (!Number.isFinite(candidate)) return 0
  return Math.max(0, Math.round(candidate))
}

/** 待新学（有 plan 用 plan 内未学新词；无 plan 用 newBudget） */
export function resolvePendingNew(input: PendingNewInput): number {
  const budget = safeCount(input.newBudget, safeCount(input.fallbackNewCount))
  if (!input.hasPlan) return budget
  return safeCount(input.breakdownRemaining, budget)
}

/** 待复习（dueCount，兜底旧队列 due） */
export function resolvePendingReview(
  dueCount: number | null | undefined,
  fallback?: number | null,
): number {
  return safeCount(dueCount, safeCount(fallback))
}
