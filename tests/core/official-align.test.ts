/**
 * task-26 · 核心对齐官方前端（research 04）：
 * A. 三键预测 `predictAll`（官方 Predict{first,days,progress} + 20pp 进度模型）
 * B. 新词首评间隔（候选 A：认识 7–90 天 / 模糊 1–7 天 / 忘记 1 天）
 * D. 每日队列不硬截断（复习全量、新学 = max(0, goal - due)）
 *
 * 截图锚点（docs/research/assets/official-5/）：
 *  02 dog 新词首次   认识 78天后 / 不确定 今日·3天后 / 不认识 今日·1天后
 *  01 dog 回炉 P=20% 认识 60% / 模糊 40% / 忘记 20%
 *  05 dog 回炉 P=40% 认识 80% / 模糊 60% / 忘记 40%
 *  04 dog 回炉 P=80% 认识 1天后 / 模糊 80% / 忘记 80%
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAMS,
  addDays,
  createWordState,
  firstFamiliarDays,
  firstForgetDays,
  firstVagueDays,
  isFirstShow,
  pickQueue,
  predictAll,
  scheduleNext,
} from '../../src/core'
import type { Rating, WordState } from '../../src/core'
import { DAY, NOW, makeReviewed } from './helpers'


/** 官方副标题格式化（逐字对齐 research 04 §3.2；仅测试用，core 只出数据） */
function fmt(p: { first: boolean; days: number; progress: number }): string {
  if (p.progress >= 1) return `${p.days} 天后`
  if (p.first) return `今日 / ${p.days} 天后`
  return `今日进度${Math.round(100 * p.progress)}%`
}

describe('task-26 B · 新词首评间隔（候选 A，±1 天）', () => {
  it('firstFamiliarDays（K=80）：d=1→63、d=2→44、d=3→33、d=5→21、d=10→10（±1）', () => {
    const expectDays: Array<[number, number]> = [
      [1, 63],
      [2, 44],
      [3, 33],
      [5, 21],
      [10, 10],
    ]
    for (const [d, days] of expectDays) {
      expect(Math.abs(firstFamiliarDays(d) - days), `d=${d}`).toBeLessThanOrEqual(1)
    }
  })

  it('firstVagueDays（K_v=100，与认识 K=80 解耦）：d=1→3、d=2→2、d=3→2、d=5→2、d=10→1（±1；官方 d=1 实测 4/5 为 3 天）', () => {
    const expectDays: Array<[number, number]> = [
      [1, 3],
      [2, 2],
      [3, 2],
      [5, 2],
      [10, 1],
    ]
    for (const [d, days] of expectDays) {
      expect(Math.abs(firstVagueDays(d) - days), `d=${d}`).toBeLessThanOrEqual(1)
    }
  })

  it('firstForgetDays 固定 1 天；首评三种 rating 的实际 nextIntervalDays 与之一致', () => {
    expect(firstForgetDays()).toBe(1)
    const table: Array<[number, Rating, number]> = [
      [1, 'familiar', 63],
      [1, 'vague', 3],
      [1, 'forgot', 1],
      [2, 'familiar', 44],
      [2, 'vague', 2],
      [5, 'familiar', 21],
      [5, 'vague', 2],
      [10, 'familiar', 10],
      [10, 'vague', 1],
    ]
    for (const [d, rating, expected] of table) {
      const fresh = createWordState({ wordId: `deck:d${d}`, deckId: 'deck', difficulty: d, now: NOW })
      const res = scheduleNext(fresh, rating, NOW)
      expect(res.longTermUpdate).toBe(true)
      expect(Math.abs(res.state.nextIntervalDays - expected), `d=${d} ${rating}`).toBeLessThanOrEqual(1)
      expect(Number.isFinite(res.state.stability)).toBe(true)
    }
  })

  it('首评「认识」不是 1 天（用户 bug 根因已修复）；d 越大间隔越短（单调）', () => {
    const days = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((d) => firstFamiliarDays(d))
    expect(days[0]!).toBeGreaterThanOrEqual(7)
    for (let i = 1; i < days.length; i += 1) {
      expect(days[i]!).toBeLessThanOrEqual(days[i - 1]!)
    }
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    expect(scheduleNext(fresh, 'familiar', NOW).state.nextIntervalDays).toBe(
      firstFamiliarDays(DEFAULT_PARAMS.d0),
    )
  })

  it('首评忘记：间隔 1 天、难度 +2、h 回到初始半衰期', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', difficulty: 5, now: NOW })
    const res = scheduleNext(fresh, 'forgot', NOW)
    expect(res.state.nextIntervalDays).toBe(1)
    expect(res.state.difficulty).toBe(7)
    expect(res.state.stability).toBeCloseTo(1.7635, 3)
  })
})

describe('task-26 A · predictAll（官方 Predict 结构）', () => {
  it('新词首次显示：first 全 true；认识 progress=1、模糊/忘记=20%（d=1：认识 63、模糊 3、忘记 1）', () => {
    const fresh = createWordState({ wordId: 'deck:dog', deckId: 'deck', difficulty: 1, now: NOW })
    expect(isFirstShow(fresh)).toBe(true)
    const p = predictAll(fresh, NOW)
    expect(p.familiar.first).toBe(true)
    expect(p.vague.first).toBe(true)
    expect(p.forgot.first).toBe(true)
    expect(p.familiar.progress).toBe(1)
    expect(p.vague.progress).toBeCloseTo(0.2, 10)
    expect(p.forgot.progress).toBeCloseTo(0.2, 10)
    // 官方同难度实测 56–78（分散，无法逐词复刻）；K=80 给 63，落在区间内
    expect(Math.abs(p.familiar.days - 63)).toBeLessThanOrEqual(1)
    expect(p.vague.days).toBe(3) // 官方 d=1 实测 4/5 为 3 天（K_v=100）
    expect(p.forgot.days).toBe(1)
    expect(fmt(p.familiar)).toBe(`${p.familiar.days} 天后`)
    expect(fmt(p.vague)).toBe('今日 / 3 天后')
    expect(fmt(p.forgot)).toBe('今日 / 1 天后')
  })

  it('复习日首评（已学词跨天）：first 全 true，认识 progress=1，间隔来自 DHP', () => {
    const prev: WordState = {
      ...makeReviewed({ stability: 176.35, difficulty: 1, lastReviewedAt: NOW - DAY }),
      nextIntervalDays: 27,
    }
    // 复习日首评 = 上次评分在昨天
    const p = predictAll(prev, addDays(NOW, 0) + 1000)
    expect(p.familiar.first).toBe(true)
    expect(p.familiar.progress).toBe(1)
    expect(p.familiar.days).toBe(scheduleNext(prev, 'familiar', NOW + 1000).state.nextIntervalDays)
    expect(p.vague.first).toBe(true)
    expect(p.forgot.first).toBe(true)
    expect(isFirstShow(prev)).toBe(false) // 已学过的词 → 标签用「模糊/忘记」
  })

})

describe('task-26 D · pickQueue 不硬截断', () => {
  function dueStates(n: number): WordState[] {
    const arr: WordState[] = []
    for (let i = 0; i < n; i += 1) {
      arr.push(
        makeReviewed({
          wordId: `deck:r${String(i).padStart(2, '0')}`,
          stability: 1 + (i % 20),
          lastReviewedAt: NOW - 10 * DAY,
        }),
      )
    }
    return arr
  }
  function newStates(n: number): WordState[] {
    const arr: WordState[] = []
    for (let i = 0; i < n; i += 1) {
      arr.push(createWordState({ wordId: `deck:n${i}`, deckId: 'deck', now: NOW }))
    }
    return arr
  }

  it('due 50 + goal 30 → reviewQueue=50、newQueue=0、totalPlanned=50', () => {
    const q = pickQueue([...dueStates(50), ...newStates(40)], { now: NOW, dailyGoal: 30 })
    expect(q.dueCount).toBe(50)
    expect(q.reviewQueue).toHaveLength(50)
    expect(q.newBudget).toBe(0)
    expect(q.newQueue).toHaveLength(0)
    expect(q.totalPlanned).toBe(50)
  })

  it('due 10 + goal 30 → reviewQueue=10、newQueue=20、totalPlanned=30', () => {
    const q = pickQueue([...dueStates(10), ...newStates(40)], {
      now: NOW,
      dailyGoal: 30,
      orderOf: Object.fromEntries(newStates(40).map((s, i) => [s.wordId, i])),
    })
    expect(q.dueCount).toBe(10)
    expect(q.reviewQueue).toHaveLength(10)
    expect(q.newBudget).toBe(20)
    expect(q.newQueue).toHaveLength(20)
    expect(q.totalPlanned).toBe(30)
  })

  it('复习顺序仍按遗忘程度（retrievability 升序），不因不截断而乱序', () => {
    const q = pickQueue([...dueStates(50), ...newStates(5)], { now: NOW, dailyGoal: 10 })
    const rs = q.reviewQueue.map((s) =>
      s.lastReviewedAt == null ? 1 : Math.pow(2, -((NOW - s.lastReviewedAt) / DAY) / s.stability),
    )
    expect(rs).toEqual([...rs].sort((a, b) => a - b))
  })
})
