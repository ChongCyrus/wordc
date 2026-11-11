import { describe, expect, it } from 'vitest'
import { resolvePendingNew, resolvePendingReview } from '../../src/ui/home/home-kpi'

describe('首页固定 KPI 取值（task-50 / QA P1）', () => {
  it('无 plan 且 due>0：待新学 = newBudget = goal − due', () => {
    // goal 30、due 2 → 28
    expect(
      resolvePendingNew({
        hasPlan: false,
        breakdownRemaining: 0, // emptyBreakdown 的 0 不能被当作有效值
        newBudget: 28,
        fallbackNewCount: 0,
      }),
    ).toBe(28)
  })

  it('无 plan 且 due=0：待新学 = goal', () => {
    expect(
      resolvePendingNew({ hasPlan: false, breakdownRemaining: 0, newBudget: 30 }),
    ).toBe(30)
  })

  it('有 plan：待新学 = breakdown.new.remaining（不能回退 newBudget）', () => {
    expect(
      resolvePendingNew({ hasPlan: true, breakdownRemaining: 5, newBudget: 28 }),
    ).toBe(5)
    // 有 plan 但 remaining 为 0（计划内新词都学完了）→ 0
    expect(
      resolvePendingNew({ hasPlan: true, breakdownRemaining: 0, newBudget: 28 }),
    ).toBe(0)
  })

  it('兜底/脏数据：缺失用 fallback，负数与 NaN 收敛为 0', () => {
    expect(
      resolvePendingNew({ hasPlan: false, newBudget: undefined, fallbackNewCount: 12 }),
    ).toBe(12)
    expect(resolvePendingNew({ hasPlan: false, newBudget: -5 })).toBe(0)
    expect(resolvePendingNew({ hasPlan: false, newBudget: Number.NaN })).toBe(0)
    expect(resolvePendingNew({ hasPlan: true, breakdownRemaining: undefined, newBudget: 7 })).toBe(7)
  })

  it('待复习 = dueCount（缺失用旧队列兜底）', () => {
    expect(resolvePendingReview(2, 0)).toBe(2)
    expect(resolvePendingReview(undefined, 3)).toBe(3)
    expect(resolvePendingReview(undefined, undefined)).toBe(0)
    expect(resolvePendingReview(-1)).toBe(0)
  })
})
