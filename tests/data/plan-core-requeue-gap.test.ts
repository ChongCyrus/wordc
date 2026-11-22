/** 0.3.94：强制 familiar 回炉使用 vague gap，不紧跟同词 */
import { describe, expect, it } from 'vitest'
import { applyRatingToPlan } from '../../src/data/plan-core'
import type { DailyPlan } from '../../src/core'

function makePlan(wordIds: string[], index = 0): DailyPlan {
  return {
    id: 'plan',
    date: '2026-11-21',
    deckId: 'deck',
    wordIds,
    index,
    sources: Object.fromEntries(wordIds.map((id) => [id, 'goal' as const])),
    goals: { dailyGoal: 10, dueCount: 0, newBudget: 0, extraCount: 0 },
    ratings: [],
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  }
}

describe('0.3.94 · plan-core familiar requeue gap', () => {
  it('强制 familiar 回炉：中途不紧跟同词，插入 index+12（默认 requeueGapFamiliarIncomplete）', () => {
    const plan = makePlan(Array.from({ length: 20 }, (_, i) => String.fromCharCode(97 + i)))
    const next = applyRatingToPlan(plan, {
      wordId: 'a',
      rating: 'familiar',
      reviewedAt: 2,
      longTermUpdate: false,
      insertRequeue: true,
    })
    expect(next.wordIds[1]).toBe('b') // 下一个不是 a
    expect(next.wordIds[next.index]).not.toBe('a')
    expect(next.wordIds.length).toBe(21)
    expect(next.wordIds.indexOf('a', 1)).toBe(13) // index1 + 12
    expect(next.completedAt).toBeNull()
  })

  it('参数可覆盖 gap；vague/forgot 保持 8/4', () => {
    const plan = makePlan(Array.from({ length: 30 }, (_, i) => String.fromCharCode(97 + i)))
    const custom = applyRatingToPlan(plan, {
      wordId: 'a',
      rating: 'familiar',
      reviewedAt: 2,
      longTermUpdate: false,
      insertRequeue: true,
      requeueGap: 3,
    })
    expect(custom.wordIds.indexOf('a', 1)).toBe(4)
    const vague = applyRatingToPlan(plan, {
      wordId: 'a',
      rating: 'vague',
      reviewedAt: 2,
      longTermUpdate: false,
    })
    expect(vague.wordIds.indexOf('a', 1)).toBe(9) // index1 + 8
    const forgot = applyRatingToPlan(plan, {
      wordId: 'a',
      rating: 'forgot',
      reviewedAt: 2,
      longTermUpdate: false,
    })
    expect(forgot.wordIds.indexOf('a', 1)).toBe(5) // index1 + 4
  })

  it('末尾不足 gap：同词紧随，plan 行为一致', () => {
    const plan = makePlan(['a'])
    const next = applyRatingToPlan(plan, {
      wordId: 'a',
      rating: 'familiar',
      reviewedAt: 2,
      longTermUpdate: false,
      insertRequeue: true,
    })
    expect(next.wordIds).toEqual(['a', 'a'])
    expect(next.index).toBe(1)
    expect(next.completedAt).toBeNull()
  })
})
