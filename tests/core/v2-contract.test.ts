/**
 * SPEC-v2 / ARCH-v2 契约：撤销/改判类型、今日 plan 类型、首页 6 态、completesToday、
 * allowVagueComplete、labelSwitch、previewNext v2。
 */
import { describe, expect, it } from 'vitest'
import {
  createWordState,
  deriveHomeState,
  getCurrentWordId,
  isFirstShow,
  localDateKey,
  predictAll,
  previewNext,
  scheduleNext,
} from '../../src/core'
import type {
  DailyPlan,
  HomeStudyState,
  PlanRating,
  PlanWordSource,
  ReviewLog,
  WordState,
} from '../../src/core'
import type { HomeStateInput } from '../../src/core'
import { DAY, NOW, makeReviewed } from './helpers'

const TODAY = localDateKey(NOW)

function plan(overrides: Partial<DailyPlan> = {}): DailyPlan {
  return {
    id: `${TODAY}:deck`,
    date: TODAY,
    deckId: 'deck',
    wordIds: ['deck:a', 'deck:b', 'deck:c'],
    index: 0,
    sources: { 'deck:a': 'goal', 'deck:b': 'goal', 'deck:c': 'requeue' } satisfies Record<string, PlanWordSource>,
    goals: { dailyGoal: 3, dueCount: 0, newBudget: 3, extraCount: 0 },
    ratings: [],
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: null,
    ...overrides,
  }
}

function rating(overrides: Partial<PlanRating> = {}): PlanRating {
  return {
    wordId: 'deck:a',
    rating: 'familiar',
    reviewedAt: NOW,
    longTermUpdate: true,
    ...overrides,
  }
}

describe('SPEC-v2 §3.3 · ReviewLog 撤销/改判可选字段', () => {
  it('可携带 stateBefore / corrected / correctedBy，旧日志缺失按未撤销处理', () => {
    const before = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const log: ReviewLog = {
      wordId: 'deck:a',
      deckId: 'deck',
      rating: 'familiar',
      reviewedAt: NOW,
      stabilityBefore: before.stability,
      difficultyBefore: before.difficulty,
      stabilityAfter: 176.35,
      difficultyAfter: 5,
      elapsedDays: 0,
      nextIntervalDays: 27,
      retrievabilityAtReview: 1,
      longTermUpdate: true,
      stateBefore: before,
      corrected: false,
    }
    expect(log.stateBefore).toBe(before)
    expect(log.corrected).toBe(false)
    expect(log.correctedBy).toBeUndefined()
    // 旧日志：字段 undefined = 不可撤销 / 未撤销
    const oldLog: ReviewLog = {
      wordId: 'deck:b',
      deckId: 'deck',
      rating: 'forgot',
      reviewedAt: NOW,
      stabilityBefore: 1,
      difficultyBefore: 5,
      stabilityAfter: 1,
      difficultyAfter: 7,
      elapsedDays: 0,
      nextIntervalDays: 1,
      retrievabilityAtReview: 1,
      longTermUpdate: true,
    }
    expect(oldLog.stateBefore).toBeUndefined()
    expect(oldLog.corrected).toBeUndefined()
    expect(oldLog.corrected).toBeFalsy() // 统计过滤口径
  })

  it('scheduleNext 返回的 log 不带 stateBefore（由 data 层补快照）', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const res = scheduleNext(fresh, 'familiar', NOW)
    expect(res.log.stateBefore).toBeUndefined()
    expect(res.log.corrected).toBeUndefined()
  })
})

describe('SPEC-v2 §3.4 · DailyPlan / getCurrentWordId', () => {
  it('getCurrentWordId：按 index 取词；越界/null plan → null', () => {
    expect(getCurrentWordId(null)).toBeNull()
    expect(getCurrentWordId(undefined)).toBeNull()
    expect(getCurrentWordId(plan({ index: 0 }))).toBe('deck:a')
    expect(getCurrentWordId(plan({ index: 2 }))).toBe('deck:c')
    expect(getCurrentWordId(plan({ index: 3 }))).toBeNull()
    expect(getCurrentWordId(plan({ wordIds: [], index: 0 }))).toBeNull()
  })

  it('plan 允许重复 wordId（回炉）且 sources/ratings 结构可用', () => {
    const p = plan({
      wordIds: ['deck:a', 'deck:b', 'deck:a'],
      index: 1,
      sources: { 'deck:a': 'requeue', 'deck:b': 'goal' },
      ratings: [rating(), rating({ wordId: 'deck:b', rating: 'vague', corrected: true, correctedBy: 9 })],
    })
    expect(p.wordIds.filter((id) => id === 'deck:a')).toHaveLength(2)
    expect(getCurrentWordId(p)).toBe('deck:b')
    expect(p.ratings.filter((r) => !r.corrected)).toHaveLength(1)
  })
})

describe('SPEC-v2 §6.2 · deriveHomeState 6 态', () => {
  const base: HomeStateInput = {
    plan: null,
    dueCount: 0,
    dailyGoal: 30,
    hasDeck: true,
    hasLearnableWord: true,
    overdueLeft: 0,
  }
  const expectState = (input: Partial<HomeStateInput>, expected: HomeStudyState) => {
    expect(deriveHomeState({ ...base, ...input })).toEqual(expected)
  }

  it('no-deck / no-words 优先', () => {
    expectState({ hasDeck: false, hasLearnableWord: false }, { kind: 'no-deck' })
    expectState({ hasLearnableWord: false }, { kind: 'no-words' })
  })

  it('无 plan → fresh：pendingReview=dueCount、pendingNew=max(0,goal-due)', () => {
    expectState({ dueCount: 12 }, { kind: 'fresh', pendingReview: 12, pendingNew: 18 })
    expectState({ dueCount: 50 }, { kind: 'fresh', pendingReview: 50, pendingNew: 0 })
    expectState({}, { kind: 'fresh', pendingReview: 0, pendingNew: 30 })
  })

  it('plan 存在但 index=0 且无有效评分 → fresh', () => {
    expectState({ plan: plan({ index: 0, ratings: [] }), dueCount: 5 }, {
      kind: 'fresh',
      pendingReview: 5,
      pendingNew: 25,
    })
    // 只有被撤销的评分也算「未开始」
    expectState(
      { plan: plan({ index: 0, ratings: [rating({ corrected: true })] }), dueCount: 5 },
      { kind: 'fresh', pendingReview: 5, pendingNew: 25 },
    )
    // wordIds 空且未完成 → fresh
    expectState({ plan: plan({ wordIds: [], index: 0 }) }, {
      kind: 'fresh',
      pendingReview: 0,
      pendingNew: 30,
    })
  })

  it('进行中 → ongoing{remaining,index,total}', () => {
    expectState(
      { plan: plan({ index: 1, ratings: [rating()] }) },
      { kind: 'ongoing', remaining: 2, index: 1, total: 3 },
    )
    expectState(
      { plan: plan({ wordIds: ['deck:a'], index: 1, ratings: [rating()] }) },
      { kind: 'ongoing', remaining: 0, index: 1, total: 1 },
    )
  })

  it('已完成 → done / done-with-overdue', () => {
    expectState({ plan: plan({ index: 3, completedAt: NOW }) }, { kind: 'done' })
    expectState(
      { plan: plan({ index: 3, completedAt: NOW }), overdueLeft: 7 },
      { kind: 'done-with-overdue', overdue: 7 },
    )
    // plan 完成后有逾期，即使 dueCount=0 也保留入口
    expectState({ plan: plan({ completedAt: NOW }), overdueLeft: 2 }, {
      kind: 'done-with-overdue',
      overdue: 2,
    })
  })
})

describe('SPEC-v2 §1.3 / §2 · completesToday 与 allowVagueComplete', () => {
  it('当期首评：认识=完成当日；模糊/忘记=未完成', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', difficulty: 1, now: NOW })
    expect(scheduleNext(fresh, 'familiar', NOW).completesToday).toBe(true)
    expect(scheduleNext(fresh, 'vague', NOW).completesToday).toBe(false)
    expect(scheduleNext(fresh, 'forgot', NOW).completesToday).toBe(false)
  })

  it('同日回炉：认识在 P>=0.6 时完成；模糊默认封顶 80%；忘记永不完成', () => {
    const atP = (p: number): WordState => ({
      ...makeReviewed({
        stability: 30,
        difficulty: 5,
        lastReviewedAt: NOW,
        nextIntervalDays: 5,
      }),
      sameDayCount: 2,
      sameDayDate: TODAY,
      todayProgress: p,
      todayProgressDate: TODAY,
    })
    // 以下断言 v1 单标量模型（默认已切 v2，显式回滚验证）
    const V1 = { progressModelMode: 'v1-20pp' } as const
    // P=0.4 + 认识 0.4 = 0.8 → 未完成；P=0.6 + 0.4 = 1 → 完成
    expect(scheduleNext(atP(0.4), 'familiar', NOW + 1000, V1).completesToday).toBe(false)
    expect(scheduleNext(atP(0.6), 'familiar', NOW + 1000, V1).completesToday).toBe(true)
    // 模糊默认：0.8+0.2 封顶 0.8 → 未完成
    expect(scheduleNext(atP(0.8), 'vague', NOW + 1000, V1).completesToday).toBe(false)
    // allowVagueComplete：0.8+0.2 → 1 → 完成
    expect(
      scheduleNext(atP(0.8), 'vague', NOW + 1000, { ...V1, allowVagueComplete: true }).completesToday,
    ).toBe(true)
    // 忘记永不完成
    expect(scheduleNext(atP(0.8), 'forgot', NOW + 1000, V1).completesToday).toBe(false)
  })

  it('predictAll 投影受 allowVagueComplete 影响（P=0.8 时模糊：1 vs 0.8）', () => {
    const state: WordState = {
      ...makeReviewed({ stability: 30, difficulty: 5, lastReviewedAt: NOW, nextIntervalDays: 5 }),
      sameDayCount: 2,
      sameDayDate: TODAY,
      todayProgress: 0.8,
      todayProgressDate: TODAY,
    }
    // v1 单标量模型（默认已切 v2，显式回滚验证）
    const V1 = { progressModelMode: 'v1-20pp' } as const
    expect(predictAll(state, NOW + 1000, V1).vague.progress).toBeCloseTo(0.8, 10)
    expect(
      predictAll(state, NOW + 1000, { ...V1, allowVagueComplete: true }).vague.progress,
    ).toBeCloseTo(1, 10)
  })

  it('labelSwitch：默认 firstEver；firstToday 需传 now 且跨天首显也为 true', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    expect(isFirstShow(fresh)).toBe(true)

    const reviewed = makeReviewed({ lastReviewedAt: NOW - DAY, firstSeenAt: NOW - 10 * DAY })
    expect(isFirstShow(reviewed)).toBe(false) // 默认 firstEver
    expect(isFirstShow(reviewed, { labelSwitch: 'firstToday' }, NOW)).toBe(true) // 跨天首显
    // 同日已评过 → firstToday 也为 false
    expect(
      isFirstShow(makeReviewed({ lastReviewedAt: NOW, firstSeenAt: NOW - 10 * DAY }), { labelSwitch: 'firstToday' }, NOW),
    ).toBe(false)
    // 不传 now 时回落 firstEver（保持纯函数）
    expect(isFirstShow(reviewed, { labelSwitch: 'firstToday' })).toBe(false)
  })
})

describe('SPEC-v2 §2 · previewNext v2 兼容字段', () => {
  it('返回 longTermDays/todayRequeue/first/todayProgress/completesToday', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', difficulty: 1, now: NOW })
    const p = previewNext('familiar', fresh, NOW)
    expect(p.todayRequeue).toBe('none')
    expect(p.first).toBe(true)
    expect(p.todayProgress).toBe(1)
    expect(p.completesToday).toBe(true)
    expect(Math.abs(p.longTermDays - 63)).toBeLessThanOrEqual(1) // d=1 K=80

    const vague = previewNext('vague', fresh, NOW)
    expect(vague.todayRequeue).toBe('requeue-vague')
    expect(vague.completesToday).toBe(false)

    const forgot = previewNext('forgot', fresh, NOW)
    expect(forgot.todayRequeue).toBe('requeue-forgot')
    expect(forgot.todayProgress).toBeCloseTo(0.2, 10)
  })

  it('同日回炉时 longTermDays 保持当前 nextIntervalDays', () => {
    const state: WordState = {
      ...makeReviewed({ lastReviewedAt: NOW, nextIntervalDays: 78 }),
      sameDayDate: TODAY,
      todayProgress: 0.4,
      todayProgressDate: TODAY,
    }
    expect(previewNext('familiar', state, NOW + 1000).longTermDays).toBe(78)
    expect(previewNext('vague', state, NOW + 1000).longTermDays).toBe(78)
    expect(previewNext('familiar', state, NOW + 1000).first).toBe(false)
  })
})
