/**
 * 调度引擎集成测试（重写自 arch 占位版；D37 所有权：dev-algo）。
 *
 * 这里是「对外出口（src/core）的冒烟 + AC1 关键断言」，细粒度用例在 tests/core/*。
 * 任何一条挂掉都说明核心算法 / 队列 / 会话契约被改坏。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAMS,
  advanceMemory,
  createSession,
  createWordState,
  familiarity,
  isDue,
  localDateKey,
  openMemory,
  pickQueue,
  retrievability,
  scheduleNext,
  sessionSnapshot,
  tapBoard,
  tapMemory,
} from '../src/core'
import type { Rating, SessionSettings, WordState } from '../src/core'

const NOW = new Date(2026, 10, 10, 10, 0, 0).getTime()
const DAY = 86_400_000

function addDays(ts: number, days: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

function relClose(actual: number, expected: number, tol = 0.01): boolean {
  return Math.abs(actual - expected) <= Math.abs(expected) * tol
}

describe('调度引擎（AC1 · 与同源 DHP 模型一致，可解释）', () => {
  it('新词首评「认识」= 21 天，之后 DHP：44→88→169→311→365 封顶（候选 A，K=80）', () => {
    let state: WordState = createWordState({ wordId: 'deck:embrace', deckId: 'deck', now: NOW })
    let now = NOW
    const intervals: number[] = []
    for (let i = 0; i < 10; i += 1) {
      const res = scheduleNext(state, 'familiar', now)
      intervals.push(res.state.nextIntervalDays)
      state = res.state
      now = addDays(now, res.state.nextIntervalDays)
    }
    expect(intervals).toEqual([21, 44, 88, 169, 311, 365, 365, 365, 365, 365])
    expect(relClose(state.stability, 4096, 0.01)).toBe(true) // stabilityMax 封顶
    expect(state.difficulty).toBe(DEFAULT_PARAMS.d0)
  })

  it('三条 rating 分支：认识升 h、模糊降 h 不升难度、忘记降 h + 难度+2 + 次日', () => {
    const prev: WordState = {
      ...createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW }),
      phase: 'review',
      stability: 50,
      difficulty: 6,
      lastReviewedAt: NOW - 7 * DAY,
      firstSeenAt: NOW - 7 * DAY,
      dueAt: NOW,
      nextIntervalDays: 7,
      reps: 3,
      meaningStats: {},
    }
    const familiar = scheduleNext(prev, 'familiar', NOW)
    expect(familiar.state.stability).toBeGreaterThan(50)
    expect(familiar.state.difficulty).toBe(6)
    expect(familiar.state.nextIntervalDays).toBe(
      Math.round(-familiar.state.stability * Math.log2(0.9)),
    )

    const vague = scheduleNext(prev, 'vague', NOW)
    expect(vague.state.stability).toBeLessThan(50)
    expect(vague.state.difficulty).toBe(6)
    expect(vague.state.nextIntervalDays).toBeGreaterThanOrEqual(1)

    const forgot = scheduleNext(prev, 'forgot', NOW)
    expect(forgot.state.stability).toBeLessThan(50)
    expect(forgot.state.difficulty).toBe(8)
    expect(forgot.state.nextIntervalDays).toBe(1) // h'=6.69 → 阈值法 1 天（公式结果，非强制）
    expect(forgot.state.dueAt).toBe(
      new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate() + 1).getTime(),
    )
  })

  it('新词首次评分绝不出现 NaN/Infinity（三种 rating）', () => {
    for (const rating of ['familiar', 'vague', 'forgot'] as Rating[]) {
      const fresh = createWordState({ wordId: `deck:${rating}`, deckId: 'deck', now: NOW })
      const res = scheduleNext(fresh, rating, NOW)
      expect(Number.isFinite(res.state.stability)).toBe(true)
      expect(Number.isFinite(res.state.difficulty)).toBe(true)
      expect(res.state.nextIntervalDays).toBeGreaterThanOrEqual(1)
      expect(res.state.nextIntervalDays).toBeLessThanOrEqual(365)
      expect(res.state.dueAt).not.toBeNull()
    }
  })

  it('当天第二次反馈只累计计数、不改长期调度（longTermUpdate=false）', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const first = scheduleNext(fresh, 'familiar', NOW)
    const second = scheduleNext(first.state, 'forgot', NOW + 3_600_000)
    expect(second.longTermUpdate).toBe(false)
    expect(second.state.stability).toBe(first.state.stability)
    expect(second.state.dueAt).toBe(first.state.dueAt)
    expect(second.state.sameDayCount).toBe(2)
  })

  it('到期判定按本地日期 00:00', () => {
    const state = scheduleNext(
      createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW }),
      'familiar',
      NOW,
    ).state
    const dueDay = localDateKey(state.dueAt!)
    const dueStart = addDays(new Date(NOW).setHours(0, 0, 0, 0), state.nextIntervalDays)
    expect(dueDay).toBe(localDateKey(dueStart))
    expect(isDue(state, dueStart)).toBe(true)
    expect(isDue(state, dueStart - 1)).toBe(false)
  })

  it('retrievability 公式 p = 2^(-Δt/h)', () => {
    expect(retrievability(10, 10)).toBeCloseTo(0.5, 12)
  })
})

describe('每日队列 + 不熟悉度（AC2/AC4 冒烟）', () => {
  it('先复习后新学；复习按遗忘程度排序；新学量 = dailyGoal - 复习量', () => {
    const makeReview = (wordId: string, stability: number): WordState => ({
      ...createWordState({ wordId, deckId: 'deck', now: NOW }),
      phase: 'review',
      stability,
      dueAt: NOW - DAY,
      lastReviewedAt: NOW - 10 * DAY,
      nextIntervalDays: 10,
    })
    const states: WordState[] = [
      makeReview('deck:r1', 30),
      makeReview('deck:r2', 5),
      { ...createWordState({ wordId: 'deck:n1', deckId: 'deck', now: NOW }) },
    ]
    const queue = pickQueue(states, { now: NOW, dailyGoal: 3 })
    expect(queue.reviewQueue.map((s) => s.wordId)).toEqual(['deck:r2', 'deck:r1'])
    expect(queue.newQueue.map((s) => s.wordId)).toEqual(['deck:n1'])
    expect(queue.newBudget).toBe(1)
    expect(queue.totalPlanned).toBe(3)
  })

  it('不熟悉度 f = clamp01(clicks/encounters)，0/0 显示 —', () => {
    expect(familiarity(0, 0)).toBeNull()
    expect(familiarity(1, 3)).toBeCloseTo(1 / 3, 10)
    expect(familiarity(7, 5)).toBe(1)
  })
})

describe('学习流程状态机（AC3 冒烟）', () => {
  const settings: SessionSettings = {
    totalRepeats: 3,
    mode: 'sequential',
    showPhrases: true,
    exampleCount: 2,
    showPhonetic: true,
  }
  const word = {
    wordId: 'deck:embrace',
    deckId: 'deck',
    headword: 'embrace',
    meanings: [
      { meaningId: 'deck:embrace#M1', pos: 'n.', cn: '拥抱' },
      { meaningId: 'deck:embrace#M2', pos: 'vt.', cn: '包含' },
    ],
    phrases: [{ en: 'embrace the change', cn: '拥抱变化' }],
  }

  it('白板→注释→记忆（按 c 顺序、各 3 次）→回注释面', () => {
    let s = createSession({ word, settings, now: NOW })
    expect(s.stage).toBe('board')
    s = tapBoard(s)
    expect(s.stage).toBe('annotation')
    s = openMemory(s)
    expect(s.activeMeaningId).toBe('deck:embrace#M1')
    const seen: string[] = [s.activeMeaningId!]
    for (let guard = 0; guard < 20 && s.stage === 'memory'; guard += 1) {
      s = tapMemory(s)
      if (s.needsAdvance) {
        s = advanceMemory(s, () => 0)
        if (s.stage === 'memory') seen.push(s.activeMeaningId!)
      }
    }
    expect(seen).toEqual(['deck:embrace#M1', 'deck:embrace#M2'])
    expect(s.stage).toBe('annotation')
    expect(s.wcCounts['deck:embrace#M1']).toBe(3)
    expect(s.wcCounts['deck:embrace#M2']).toBe(3)
    const snap = sessionSnapshot(s, NOW)
    expect(snap.wcCounts).toEqual(s.wcCounts)
    expect(snap.stage).toBe('annotation')
  })
})
