/**
 * 边界与异常（QA 最易挑的点，对应 docs/CORE-API.md §8「边界与异常」）：
 * 1) encounters=0 的不熟悉度
 * 2) 非学习态（suspended/mastered）被评分
 * 3) 时间回拨（now < lastReviewedAt）
 * 4) 超长间隔（>365 天）
 */
import { describe, expect, it } from 'vitest'
import {
  addDays,
  createSession,
  localDateKey,
  createWordState,
  familiarity,
  familiarityOfMeaning,
  intervalFromRetention,
  isDue,
  openMemory,
  scheduleNext,
  tapBoard,
  tapMemory,
} from '../../src/core'
import type { Rating, WordState } from '../../src/core'
import { DAY, NOW } from './helpers'

function relClose(actual: number, expected: number, tol = 0.01): boolean {
  return Math.abs(actual - expected) <= Math.abs(expected) * tol
}

describe('边界 1 · encounters=0 的不熟悉度', () => {
  it('familiarity(0,0) = null（展示 —），clicks 缺省/key 缺失同样 null', () => {
    expect(familiarity(0, 0)).toBeNull()
    expect(familiarityOfMeaning(undefined, 'w#M1')).toBeNull()
    expect(familiarityOfMeaning({}, 'w#M1')).toBeNull()
    // clicks>0 但 encounters=0 仍不展示百分比（避免 0 除）
    expect(familiarityOfMeaning({ 'w#M1': { clicks: 3, encounters: 0 } }, 'w#M1')).toBeNull()
  })
})

describe('边界 2 · 非学习态（suspended / mastered）被评分', () => {
  it('不抛错、不产生 NaN：按正常评分结算并离开 suspended/mastered', () => {
    for (const phase of ['suspended', 'mastered'] as const) {
      for (const rating of ['familiar', 'vague', 'forgot'] as Rating[]) {
        const prev: WordState = {
          ...createWordState({ wordId: `deck:${phase}`, deckId: 'deck', now: NOW }),
          phase,
          stability: 20,
          difficulty: 5,
          lastReviewedAt: NOW - 7 * DAY,
          firstSeenAt: NOW - 30 * DAY,
          dueAt: NOW,
          nextIntervalDays: 7,
          meaningStats: {},
        }
        const res = scheduleNext(prev, rating, NOW)
        expect(res.longTermUpdate).toBe(true)
        expect(Number.isFinite(res.state.stability)).toBe(true)
        expect(Number.isFinite(res.state.difficulty)).toBe(true)
        expect(res.state.nextIntervalDays).toBeGreaterThanOrEqual(1)
        expect(res.state.nextIntervalDays).toBeLessThanOrEqual(365)
        expect(res.state.dueAt).not.toBeNull()
        // 评分为认识 → review；失败 → lapsed（v1 不产生 mastered；suspended 会被评分解除）
        expect(res.state.phase).toBe(rating === 'familiar' ? 'review' : 'lapsed')
      }
    }
  })

  it('suspended 的 isDue 为 false（不会被每日队列选中）', () => {
    const suspended: WordState = {
      ...createWordState({ wordId: 'deck:s', deckId: 'deck', now: NOW }),
      phase: 'suspended',
      dueAt: NOW - DAY,
      lastReviewedAt: NOW - DAY,
    }
    expect(isDue(suspended, NOW)).toBe(false)
  })
})

describe('边界 3 · 时间回拨（now < lastReviewedAt）', () => {
  it('elapsedDays 截断为 0（p=1），不抛错、不倒退数值：认识不放大 h', () => {
    const prev: WordState = {
      ...createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW }),
      phase: 'review',
      stability: 20,
      difficulty: 5,
      lastReviewedAt: NOW,
      firstSeenAt: NOW - 30 * DAY,
      dueAt: NOW,
      nextIntervalDays: 10,
      meaningStats: {},
    }
    // 回拨 26 小时（本地日期变成前一天 → 视为“当天第一次反馈”，elapsed 截断为 0）
    const earlier = NOW - 26 * 3_600_000
    const res = scheduleNext(prev, 'familiar', earlier)
    expect(Number.isFinite(res.state.stability)).toBe(true)
    // p=1 → (1-p)^0.970 = 0 → 答对增益为 0，h 不被放大
    expect(relClose(res.state.stability, 20, 1e-9)).toBe(true)
    expect(res.state.dueAt).not.toBeNull()
    expect(res.state.nextIntervalDays).toBeGreaterThanOrEqual(1)
    expect(res.state.lastReviewedAt).toBe(earlier)
    expect(Number.isFinite(res.log.elapsedDays)).toBe(true)
    expect(res.log.elapsedDays).toBe(0)
  })

  it('回拨到同一天：走「当天非首次反馈」，长期状态完全不变', () => {
    const prev: WordState = {
      ...createWordState({ wordId: 'deck:b', deckId: 'deck', now: NOW }),
      phase: 'review',
      stability: 20,
      difficulty: 5,
      lastReviewedAt: NOW,
      firstSeenAt: NOW - 30 * DAY,
      dueAt: NOW + DAY,
      nextIntervalDays: 10,
      sameDayCount: 1,
      sameDayDate: localDateKey(NOW),
      meaningStats: {},
    }
    const res = scheduleNext(prev, 'forgot', NOW - 3_600_000)
    expect(res.longTermUpdate).toBe(false)
    expect(res.state.stability).toBe(20)
    expect(res.state.dueAt).toBe(prev.dueAt)
    expect(res.state.sameDayCount).toBe(2)
  })
})

describe('边界 4 · 超长间隔（>365 天）', () => {
  it('intervalFromRetention 封顶 365', () => {
    expect(intervalFromRetention(366, 0.9)).toBe(56) // 366*0.152 = 55.6
    expect(intervalFromRetention(5000, 0.9)).toBe(365)
    expect(intervalFromRetention(1_000_000, 0.9)).toBe(365)
  })

  it('隔了 100000 天才复习：p≈0 但 h 被 clamp 到 stabilityMax、间隔 365、无 Inf', () => {
    const prev: WordState = {
      ...createWordState({ wordId: 'deck:c', deckId: 'deck', now: NOW }),
      phase: 'review',
      stability: 1000,
      difficulty: 5,
      lastReviewedAt: NOW - 100_000 * DAY,
      firstSeenAt: NOW - 120_000 * DAY,
      dueAt: NOW - 100_000 * DAY,
      nextIntervalDays: 365,
      meaningStats: {},
    }
    const res = scheduleNext(prev, 'familiar', NOW)
    expect(res.log.retrievabilityAtReview).toBeCloseTo(0, 12)
    expect(Number.isFinite(res.state.stability)).toBe(true)
    expect(res.state.stability).toBeLessThanOrEqual(4096)
    expect(res.state.nextIntervalDays).toBe(365)
    expect(Number.isFinite(res.state.difficulty)).toBe(true)

    const forgot = scheduleNext(prev, 'forgot', NOW)
    expect(Number.isFinite(forgot.state.stability)).toBe(true)
    // task-26：不再强制次日，按公式 h'≈12.15 → 间隔 2 天
    expect(forgot.state.nextIntervalDays).toBe(2)
    expect(forgot.state.difficulty).toBe(7)
  })

  it('间隔到达 365 后继续复习仍保持 365（官方无“完全记住”概念）', () => {
    let state: WordState = {
      ...createWordState({ wordId: 'deck:d', deckId: 'deck', now: NOW }),
      phase: 'review',
      stability: 4000,
      difficulty: 5,
      lastReviewedAt: NOW,
      firstSeenAt: NOW - 365 * DAY,
      dueAt: addDays(NOW, 365),
      nextIntervalDays: 365,
      meaningStats: {},
    }
    let now = addDays(NOW, 365)
    for (let i = 0; i < 5; i += 1) {
      const res = scheduleNext(state, 'familiar', now)
      expect(res.state.nextIntervalDays).toBe(365)
      state = res.state
      now = addDays(now, 365)
    }
  })
})

describe('边界 5 · 会话动作在错误阶段被调用（幂等）', () => {
  it('白板面直接 tapMemory/advanceMemory、注释面重复 tapBoard → 状态不变', () => {
    const word = {
      wordId: 'deck:e',
      deckId: 'deck',
      headword: 'edge',
      meanings: [{ meaningId: 'deck:e#M1', cn: '边缘' }],
      phrases: [],
    }
    const settings = {
      totalRepeats: 3,
      mode: 'sequential' as const,
      showPhrases: true,
      exampleCount: 2,
      showPhonetic: true,
    }
    const session = createSession({ word, settings, now: NOW })
    expect(tapMemory(session)).toBe(session)
    expect(openMemory(session)).toBe(session)
    const annotation = tapBoard(session)
    expect(tapBoard(annotation)).toBe(annotation)
    expect(annotation.stage).toBe('annotation')
  })
})
