import { describe, expect, it } from 'vitest'
import {
  addDays,
  computeDailyStats,
  computeFeedbackDistribution,
  computeForgettingCurve,
  computeReviewPressure,
  computeStatsOverview,
  computeStudyStreak,
  computeUnfamiliarTop,
  localDateKey,
  startOfLocalDay,
} from '../../src/core'
import type { Rating, ReviewLog, WordState } from '../../src/core'
import { DAY, NOW, makeReviewed, makeState } from './helpers'

const TODAY = startOfLocalDay(NOW)

function makeLog(overrides: Partial<ReviewLog> & { wordId: string }): ReviewLog {
  return {
    deckId: 'deck',
    rating: 'familiar',
    reviewedAt: TODAY + 10 * 3_600_000,
    stabilityBefore: 1,
    difficultyBefore: 5,
    stabilityAfter: 2,
    difficultyAfter: 5,
    elapsedDays: 1,
    nextIntervalDays: 2,
    retrievabilityAtReview: 0.9,
    longTermUpdate: true,
    ...overrides,
    wordId: overrides.wordId,
  }
}

function rating(r: Rating, overrides: Partial<ReviewLog> & { wordId: string }): ReviewLog {
  return makeLog({ ...overrides, rating: r })
}

describe('core/stats · 连续打卡', () => {
  it('今天/昨天/前天都有记录 → 3 天', () => {
    const logs = [
      makeLog({ wordId: 'deck:a' }),
      makeLog({ wordId: 'deck:b', reviewedAt: addDays(TODAY, -1) + 3_600_000 }),
      makeLog({ wordId: 'deck:c', reviewedAt: addDays(TODAY, -2) + 3_600_000 }),
    ]
    expect(computeStudyStreak(logs, NOW)).toBe(3)
  })

  it('今天还没学但昨天有 → 从昨天起算（不归零）', () => {
    const logs = [
      makeLog({ wordId: 'deck:a', reviewedAt: addDays(TODAY, -1) + 3_600_000 }),
      makeLog({ wordId: 'deck:b', reviewedAt: addDays(TODAY, -2) + 3_600_000 }),
    ]
    expect(computeStudyStreak(logs, NOW)).toBe(2)
  })

  it('中间断一天 → 只算到今天', () => {
    const logs = [
      makeLog({ wordId: 'deck:a' }),
      makeLog({ wordId: 'deck:b', reviewedAt: addDays(TODAY, -3) + 3_600_000 }),
    ]
    expect(computeStudyStreak(logs, NOW)).toBe(1)
  })

  it('没有日志 / 今天以后才有的日志 → 0', () => {
    expect(computeStudyStreak([], NOW)).toBe(0)
    const future = [makeLog({ wordId: 'deck:a', reviewedAt: addDays(TODAY, 2) })]
    expect(computeStudyStreak(future, NOW)).toBe(0)
  })
})

describe('core/stats · 每日学习量', () => {
  it('近 3 天：reviewed 去重、learned 取 firstSeenAt 当天、无记录补 0', () => {
    const states: WordState[] = [
      makeReviewed({ wordId: 'deck:a', firstSeenAt: TODAY + 3_600_000 }),
      makeReviewed({ wordId: 'deck:b', firstSeenAt: TODAY + 3_600_000 }),
      makeReviewed({ wordId: 'deck:c', firstSeenAt: addDays(TODAY, -2) + 3_600_000 }),
    ]
    const logs: ReviewLog[] = [
      makeLog({ wordId: 'deck:a' }),
      makeLog({ wordId: 'deck:b' }),
      // 同日回炉：同词第二次，只算一次 reviewed 且不算 learned
      makeLog({ wordId: 'deck:b', longTermUpdate: false, rating: 'forgot' }),
      makeLog({ wordId: 'deck:c', reviewedAt: addDays(TODAY, -2) + 3_600_000 }),
    ]
    const points = computeDailyStats(logs, NOW, 3, states)
    expect(points).toHaveLength(3)
    expect(points[0]!.date).toBe(localDateKey(addDays(TODAY, -2)))
    expect(points[2]!.date).toBe(localDateKey(TODAY))
    expect(points[2]!.reviewed).toBe(2)
    expect(points[2]!.learned).toBe(2)
    expect(points[0]!.reviewed).toBe(1)
    expect(points[0]!.learned).toBe(1)
    expect(points[1]!.reviewed).toBe(0)
    expect(points[1]!.learned).toBe(0)
  })
})

describe('core/stats · 反馈分布', () => {
  it('默认只统计今天且只计 longTermUpdate', () => {
    const logs = [
      rating('familiar', { wordId: 'deck:a' }),
      rating('vague', { wordId: 'deck:b' }),
      rating('forgot', { wordId: 'deck:c' }),
      rating('forgot', { wordId: 'deck:c', longTermUpdate: false }),
      rating('familiar', { wordId: 'deck:old', reviewedAt: addDays(TODAY, -1) }),
    ]
    expect(computeFeedbackDistribution(logs, NOW)).toEqual({
      familiar: 1,
      vague: 1,
      forgot: 1,
      total: 3,
    })
    expect(computeFeedbackDistribution(logs, NOW, true)).toEqual({
      familiar: 2,
      vague: 1,
      forgot: 1,
      total: 4,
    })
  })
})

describe('core/stats · 遗忘曲线', () => {
  it('按 elapsedDays 分桶统计回忆率（模糊/不认识算失败）', () => {
    const logs = [
      makeLog({ wordId: 'deck:a', elapsedDays: 0.5 }),
      makeLog({ wordId: 'deck:b', elapsedDays: 0.5, rating: 'forgot' }),
      makeLog({ wordId: 'deck:c', elapsedDays: 1.2 }),
      makeLog({ wordId: 'deck:d', elapsedDays: 2.0 }),
      makeLog({ wordId: 'deck:e', elapsedDays: 10, rating: 'vague' }),
      makeLog({ wordId: 'deck:f', elapsedDays: 500 }),
    ]
    const curve = computeForgettingCurve(logs)
    expect(curve).toHaveLength(13)
    const first = curve[0]!
    expect(first.label).toBe('0–1天')
    expect(first.total).toBe(2)
    expect(first.recalled).toBe(1)
    expect(first.retention).toBeCloseTo(0.5, 10)
    expect(curve[1]!.total).toBe(1)
    expect(curve[8]!.label).toBe('8–14天')
    expect(curve[8]!.total).toBe(1)
    expect(curve[8]!.retention).toBe(0)
    const last = curve[12]!
    expect(last.maxDays).toBeNull()
    expect(last.total).toBe(1)
    // 次日回炉日志不计入遗忘曲线
    const withRequeue = computeForgettingCurve([
      ...logs,
      makeLog({ wordId: 'deck:a', elapsedDays: 0.5, longTermUpdate: false }),
    ])
    expect(withRequeue[0]!.total).toBe(2)
  })
})

describe('core/stats · 不熟悉度 Top N', () => {
  it('f 降序、encounters=0 不参与、clamp 到 1', () => {
    const states: WordState[] = [
      makeState({
        wordId: 'deck:a',
        meaningStats: {
          'deck:a#M1': { clicks: 3, encounters: 4 },
          'deck:a#M2': { clicks: 0, encounters: 0 },
        },
      }),
      makeState({
        wordId: 'deck:b',
        meaningStats: {
          'deck:b#M1': { clicks: 9, encounters: 5 },
          'deck:b#M2': { clicks: 1, encounters: 4 },
        },
      }),
    ]
    const top = computeUnfamiliarTop(states, 10)
    expect(top).toHaveLength(3)
    expect(top[0]).toMatchObject({ meaningId: 'deck:b#M1', familiarity: 1, clicks: 9 })
    expect(top[1]).toMatchObject({ meaningId: 'deck:a#M1' })
    expect(top[1]!.familiarity).toBeCloseTo(0.75, 10)
    expect(top[2]!.familiarity).toBeCloseTo(0.25, 10)
    expect(computeUnfamiliarTop(states, 1)).toHaveLength(1)
    expect(computeUnfamiliarTop([], 5)).toEqual([])
  })
})

describe('core/stats · 未来复习压力 / 概览', () => {
  it('按到期日分组 7 天，逾期并入今天', () => {
    const states: WordState[] = [
      makeReviewed({ wordId: 'deck:overdue', dueAt: TODAY - 3 * DAY }),
      makeReviewed({ wordId: 'deck:today', dueAt: TODAY }),
      makeReviewed({ wordId: 'deck:d2', dueAt: addDays(TODAY, 2) }),
      makeReviewed({ wordId: 'deck:d2b', dueAt: addDays(TODAY, 2) }),
      makeReviewed({ wordId: 'deck:d30', dueAt: addDays(TODAY, 30) }),
      makeState({ wordId: 'deck:new', phase: 'new' }),
    ]
    const pressure = computeReviewPressure(states, NOW, 7)
    expect(pressure).toHaveLength(7)
    expect(pressure[0]!.dueCount).toBe(2) // overdue + today
    expect(pressure[2]!.dueCount).toBe(2)
    expect(pressure.reduce((s, p) => s + p.dueCount, 0)).toBe(4) // 30 天后的不计入
  })

  it('computeStatsOverview 组合口径', () => {
    const states: WordState[] = [
      makeReviewed({ wordId: 'deck:a', firstSeenAt: TODAY + 3_600_000, dueAt: NOW - DAY }),
      makeReviewed({ wordId: 'deck:b', firstSeenAt: addDays(TODAY, -5), dueAt: addDays(TODAY, 1) }),
      makeState({ wordId: 'deck:c', phase: 'new' }),
    ]
    const logs: ReviewLog[] = [
      makeLog({ wordId: 'deck:a' }),
      rating('forgot', { wordId: 'deck:b' }),
      makeLog({ wordId: 'deck:b', reviewedAt: addDays(TODAY, -1) }),
    ]
    const overview = computeStatsOverview(states, logs, NOW)
    expect(overview.todayReviewed).toBe(2)
    expect(overview.todayNewLearned).toBe(1)
    expect(overview.totalLearned).toBe(2)
    expect(overview.streakDays).toBe(2)
    expect(overview.totalReviews).toBe(3)
    expect(overview.ratingCounts).toEqual({ familiar: 1, vague: 0, forgot: 1 })
    expect(overview.dueToday).toBe(1)
    expect(overview.dueTomorrow).toBe(1)
    expect(overview.dueNext7Days).toBe(2) // 逾期并入今天 + 明天
  })
})
