import { describe, expect, it } from 'vitest'

import { createWordState, pickQueue, startOfLocalDay } from '../../src/core'
import type { WordState } from '../../src/core'

const NOW = new Date(2026, 11, 3, 10, 0, 0).getTime()

function makeDueStates(count: number, deckId = 'd', spread = 0): WordState[] {
  return Array.from({ length: count }, (_, index) => {
    const state = createWordState({ wordId: `${deckId}:w${index}`, deckId, now: NOW - 86_400_000 })
    state.phase = 'review'
    state.firstSeenAt = NOW - 86_400_000
    state.lastReviewedAt = NOW - 86_400_000 - index * spread
    state.dueAt = startOfLocalDay(NOW) - 1
    state.stability = 5 + index * spread
    state.nextIntervalDays = 1
    return state
  })
}

function makeNewStates(count: number, deckId = 'd'): WordState[] {
  return Array.from({ length: count }, (_, index) => {
    const state = createWordState({ wordId: `${deckId}:n${index}`, deckId, now: NOW })
    state.phase = 'new'
    return state
  })
}

function orderOf(states: WordState[]): Record<string, number> {
  return Object.fromEntries(states.map((state, index) => [state.wordId, index]))
}

describe('pickQueue reviewCap（task-51 每日复习上限）', () => {
  it('due=459, cap=50, goal=30 → 入队 50、新学 0、dueTotal=459', () => {
    const due = makeDueStates(459, 'd', 1)
    const queue = pickQueue(due, { now: NOW, dailyGoal: 30, deckId: 'd', reviewCap: 50, orderOf: orderOf(due) })
    expect(queue.reviewQueue).toHaveLength(50)
    expect(queue.dueCount).toBe(50)
    expect(queue.dueTotal).toBe(459)
    expect(queue.newBudget).toBe(0)
    expect(queue.newQueue).toHaveLength(0)
    expect(queue.totalPlanned).toBe(50)
  })

  it('due=20, cap=50, goal=30 → 复习 20 / 新学 10', () => {
    const due = makeDueStates(20, 'd')
    const news = makeNewStates(30)
    const queue = pickQueue([...due, ...news], {
      now: NOW,
      dailyGoal: 30,
      deckId: 'd',
      reviewCap: 50,
      orderOf: orderOf(news),
    })
    expect(queue.reviewQueue).toHaveLength(20)
    expect(queue.dueTotal).toBe(20)
    expect(queue.newBudget).toBe(10)
    expect(queue.newQueue).toHaveLength(10)
  })

  it('cap=0 / 缺省 = 不限（现有行为不变）', () => {
    const due = makeDueStates(459)
    const zero = pickQueue(due, { now: NOW, dailyGoal: 30, reviewCap: 0, orderOf: orderOf(due) })
    const absent = pickQueue(due, { now: NOW, dailyGoal: 30, orderOf: orderOf(due) })
    expect(zero.reviewQueue).toHaveLength(459)
    expect(zero.dueCount).toBe(459)
    expect(zero.dueTotal).toBe(459)
    expect(absent.reviewQueue).toHaveLength(459)
    expect(zero.newBudget).toBe(0)
  })

  it('cap 防御性归一：负数/小数/超大 → 0 或 min(9999) 且 cap>0 才截断', () => {
    const due = makeDueStates(10)
    const negative = pickQueue(due, { now: NOW, dailyGoal: 30, reviewCap: -5, orderOf: orderOf(due) })
    expect(negative.reviewQueue).toHaveLength(10)
    const fractional = pickQueue(due, { now: NOW, dailyGoal: 30, reviewCap: 2.7, orderOf: orderOf(due) })
    expect(fractional.reviewQueue).toHaveLength(2)
    const huge = pickQueue(due, { now: NOW, dailyGoal: 30, reviewCap: 100_000, orderOf: orderOf(due) })
    expect(huge.reviewQueue).toHaveLength(10) // min(9999) 但只有 10 个到期
  })

  it('排序保持「遗忘度低→高」：cap 取的是最该复习的前 N 个（tie 按 dueAt/wordId 稳定）', () => {
    // 制造 retrievability 差异：stability 越小、elapsed 越长 → retrievability 越低
    const first = makeDueStates(3, 'd')
    // 全部 dueAt/stability 相同 → 应按 wordId 字典序稳定
    const queue = pickQueue(first, { now: NOW, dailyGoal: 30, reviewCap: 2, orderOf: orderOf(first) })
    expect(queue.reviewQueue.map((state) => state.wordId)).toEqual(['d:w0', 'd:w1'])
  })

  it('手动加学不受 cap 限制（追加且不计 budget）', () => {
    const due = makeDueStates(30)
    const news = makeNewStates(5)
    const extraState = news[4]!
    const queue = pickQueue([...due, ...news], {
      now: NOW,
      dailyGoal: 7, // review 5 → newBudget 2；加学词排在第 5 位，不会被预算选中
      deckId: 'd',
      reviewCap: 5,
      extraNewWordIds: [extraState.wordId],
      orderOf: orderOf(news),
    })
    expect(queue.reviewQueue).toHaveLength(5)
    expect(queue.newBudget).toBe(2)
    expect(queue.newQueue.map((state) => state.wordId)).toContain(extraState.wordId)
    expect(queue.extraCount).toBe(1)
  })
})
