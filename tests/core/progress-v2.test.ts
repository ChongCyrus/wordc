/**
 * 进度模型 v2 · 5 档状态机（Lead 2026-11-11 实机 face/cat/yellow 三词交叉验证，D 级推算）
 * + 首评常数 K=80 基准。
 *
 * 档位 =（V, W；认识显示）：
 *   L1a(1) = (0.6, 0.2; F=80%)   ← 当日首评「不确定」
 *   L1b(2) = (0.4, 0.2; F=60%)   ← 当日首评「不认识」
 *   L2(3)  = (0.6, 0.4; F=N天后，可完成)
 *   L3(4)  = (0.8, 0.6; F=N天后，可完成)
 *   L4(5)  = (0.8, 0.8; F=N天后，可完成)
 *
 * 默认 `progressModelMode='v2-levels'`；v1-20pp 保留做 A/B/回滚。
 * N（days）用首次反馈算出的长期间隔（不另算）——下文 `${N} 天后` 中的 N 均取自 state.nextIntervalDays。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAMS,
  createWordState,
  firstFamiliarDays,
  firstVagueDays,
  localDateKey,
  predictAll,
  scheduleNext,
} from '../../src/core'
import type { Predict, Rating, WordState } from '../../src/core'
import { NOW, makeReviewed } from './helpers'

const TODAY = localDateKey(NOW)
const HOUR = 3_600_000
const V2 = { progressModelMode: 'v2-levels' } as const

/** 官方三态格式化（与 UI next-hint 一致；仅测试用） */
function fmt(p: Predict): string {
  if (p.progress >= 1) return `${p.days} 天后`
  if (p.first) return `今日 / ${p.days} 天后`
  return `今日进度${Math.round(100 * p.progress)}%`
}

function triplet(state: WordState, now = NOW + HOUR): [string, string, string] {
  const p = predictAll(state, now)
  return [fmt(p.familiar), fmt(p.vague), fmt(p.forgot)]
}

/** 新词首评后的状态 */
function afterFirst(rating: Rating, difficulty = 1): WordState {
  const fresh = createWordState({ wordId: 'deck:w', deckId: 'deck', difficulty, now: NOW })
  return scheduleNext(fresh, rating, NOW).state
}

/** 构造同日回炉状态（指定 level） */
function atLevel(level: number, overrides: Partial<WordState> = {}): WordState {
  return {
    ...makeReviewed({ stability: 30, difficulty: 5, lastReviewedAt: NOW, nextIntervalDays: 3 }),
    sameDayCount: 2,
    sameDayDate: TODAY,
    todayProgressDate: TODAY,
    todayProgressLevel: level,
    ...overrides,
  }
}

describe('首评常数 K=80（保持不变）', () => {
  it('默认 firstIntervalK=80；认识 d=1→63、d=2→44、d=3→33、d=5→21、d=10→10（±1）', () => {
    expect(DEFAULT_PARAMS.firstIntervalK).toBe(80)
    const expected: Array<[number, number]> = [
      [1, 63],
      [2, 44],
      [3, 33],
      [5, 21],
      [10, 10],
    ]
    for (const [d, days] of expected) {
      expect(Math.abs(firstFamiliarDays(d) - days), `d=${d}`).toBeLessThanOrEqual(1)
    }
    // 模糊独立 K_v=100（与认识 K=80 解耦）：d=1→3（官方 d=1 实测 4/5 为 3 天）
    expect(DEFAULT_PARAMS.firstVagueIntervalK).toBe(100)
    for (const [d, days] of [
      [1, 3],
      [2, 2],
      [3, 2],
      [5, 2],
      [10, 1],
    ] as Array<[number, number]>) {
      expect(Math.abs(firstVagueDays(d) - days), `vague d=${d}`).toBeLessThanOrEqual(1)
    }
  })

  it('官方同难度实测 56/62/78 分散 → 只保证区间内（不可逐词复刻）', () => {
    expect(firstFamiliarDays(1)).toBe(63)
    expect(firstFamiliarDays(1)).toBeGreaterThanOrEqual(7)
    expect(firstFamiliarDays(1)).toBeLessThanOrEqual(90)
  })
})

describe('v2 5 档默认表（V/W/F 映射）', () => {
  it.each([
    [1, 'L1a', 0.6, 0.2, 0.8],
    [2, 'L1b', 0.4, 0.2, 0.6],
    [3, 'L2', 0.6, 0.4, 1],
    [4, 'L3', 0.8, 0.6, 1],
    [5, 'L4', 0.8, 0.8, 1],
  ])('level%i（%s）：V=%f / W=%f / F=%f', (level, name, vague, forget, familiar) => {
    expect(DEFAULT_PARAMS.progressLevels[level - 1]!.name).toBe(name)
    const p = predictAll(atLevel(level), NOW + HOUR, V2)
    expect(p.familiar.first).toBe(false)
    expect(p.vague.progress).toBeCloseTo(vague, 10)
    expect(p.forgot.progress).toBeCloseTo(forget, 10)
    expect(p.familiar.progress).toBeCloseTo(familiar, 10)
    expect(p.familiar.days).toBe(3) // 同日不改长期；N 取 nextIntervalDays
  })

  it('默认模式已切 v2-levels（Lead 拍板）；v1-20pp 仍可显式回滚', () => {
    expect(DEFAULT_PARAMS.progressModelMode).toBe('v2-levels')
    expect(DEFAULT_PARAMS.canFinishMode).toBe('table')
    // 默认 = v2：L1a 同一天显示 80/60/20
    expect(triplet(atLevel(1))).toEqual(['今日进度80%', '今日进度60%', '今日进度20%'])
    // 显式 v1：单标量 P=0.2 → 60/40/20
    const state = { ...atLevel(1), todayProgress: 0.2 }
    const v1 = predictAll(state, NOW + HOUR, { progressModelMode: 'v1-20pp' })
    expect([fmt(v1.familiar), fmt(v1.vague), fmt(v1.forgot)]).toEqual([
      '今日进度60%',
      '今日进度40%',
      '今日进度20%',
    ])
  })

  it('canFinishMode=never 可覆盖：F 回落到档位表百分比（L2+ 未观测暂按天后）', () => {
    expect(
      predictAll(atLevel(1), NOW + HOUR, { ...V2, canFinishMode: 'never' }).familiar.progress,
    ).toBeCloseTo(0.8, 10)
    expect(
      predictAll(atLevel(2), NOW + HOUR, { ...V2, canFinishMode: 'never' }).familiar.progress,
    ).toBeCloseTo(0.6, 10)
    // L2/L3/L4 表中 familiar='days'；never 时该显示未观测 → 暂按天后（progress=1）
    expect(
      predictAll(atLevel(3), NOW + HOUR, { ...V2, canFinishMode: 'never' }).familiar.progress,
    ).toBe(1)
  })
})

describe('v2 转移表：实测 + inferred 标注', () => {
  it('转移：模糊 L1a→L2、L2→L3、L3→L3、L4→L3；忘记 L3→L2、L2→L1a；认识 L1b→L2、L1a→L3、L2/L3→完成（L4→完成 为 inferred，单测锁定兜底行为）', () => {
    const step = (level: number, rating: Rating) =>
      scheduleNext(atLevel(level), rating, NOW + HOUR, V2)
    expect(step(1, 'vague').state.todayProgressLevel).toBe(3)
    expect(step(3, 'vague').state.todayProgressLevel).toBe(4)
    expect(step(4, 'vague').state.todayProgressLevel).toBe(4)
    expect(step(5, 'vague').state.todayProgressLevel).toBe(4)
    expect(step(4, 'forgot').state.todayProgressLevel).toBe(3)
    expect(step(3, 'forgot').state.todayProgressLevel).toBe(1)
    expect(step(2, 'familiar').state.todayProgressLevel).toBe(3)
    expect(step(1, 'familiar').state.todayProgressLevel).toBe(4)
    expect(step(3, 'familiar').completesToday).toBe(true)
    expect(step(4, 'familiar').completesToday).toBe(true)
    expect(step(5, 'familiar').completesToday).toBe(true)
    // 同一日不改长期
    const before = atLevel(4)
    const after = step(4, 'vague').state
    expect(after.stability).toBe(before.stability)
    expect(after.difficulty).toBe(before.difficulty)
    expect(after.dueAt).toBe(before.dueAt)
    expect(after.nextIntervalDays).toBe(before.nextIntervalDays)
  })

  it('未知转移标 inferred: true（L1b+模糊→L1a、L1b+忘记→L1b、L1a+忘记→L1b、L4+忘记→L2、L4+认识→完成）', () => {
    expect(DEFAULT_PARAMS.progressOnVague[2]).toEqual({ to: 1, inferred: true })
    expect(DEFAULT_PARAMS.progressOnForget[2]).toEqual({ to: 2, inferred: true })
    expect(DEFAULT_PARAMS.progressOnForget[1]).toEqual({ to: 2, inferred: true })
    expect(DEFAULT_PARAMS.progressOnForget[5]).toEqual({ to: 3, inferred: true })
    expect(DEFAULT_PARAMS.progressOnFamiliar[5]).toEqual({ to: 'complete', inferred: true })
    // 实测项不带 inferred
    expect(DEFAULT_PARAMS.progressOnVague[1]!.inferred).toBeUndefined()
    expect(DEFAULT_PARAMS.progressOnVague[3]!.inferred).toBeUndefined()
    expect(DEFAULT_PARAMS.progressOnForget[3]!.inferred).toBeUndefined()
    expect(DEFAULT_PARAMS.progressOnForget[4]!.inferred).toBeUndefined()
    expect(DEFAULT_PARAMS.progressOnFamiliar[1]!.inferred).toBeUndefined()
  })

  it('首评：不确定→L1a、不认识→L1b、认识→当日完成', () => {
    expect(afterFirst('vague').todayProgressLevel).toBe(1)
    expect(afterFirst('forgot').todayProgressLevel).toBe(2)
    const fresh = createWordState({ wordId: 'deck:f', deckId: 'deck', difficulty: 1, now: NOW })
    const familiar = scheduleNext(fresh, 'familiar', NOW)
    expect(familiar.completesToday).toBe(true)
    expect(familiar.state.todayProgress).toBe(1)
  })
})

describe('端到端序列 1 · face', () => {
  it('首评不认识→(60/40/20) → 认识→(1天后/60/40) → 认识→完成', () => {
    let s = afterFirst('forgot') // L1b
    const N = s.nextIntervalDays // 首评忘记 = 1 天
    expect(N).toBe(1)
    expect(s.todayProgressLevel).toBe(2)
    expect(triplet(s)).toEqual(['今日进度60%', '今日进度40%', '今日进度20%'])

    // 认识：L1b→L2（不完成）
    let r = scheduleNext(s, 'familiar', NOW + HOUR, V2)
    expect(r.completesToday).toBe(false)
    s = r.state
    expect(s.todayProgressLevel).toBe(3)
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度60%', '今日进度40%'])

    // 认识：L2→完成当日
    r = scheduleNext(s, 'familiar', NOW + 2 * HOUR, V2)
    expect(r.completesToday).toBe(true)
    expect(r.requeue).toBe('none')
  })
})

describe('端到端序列 2 · cat', () => {
  it('首评不确定→(80/60/20) → 模糊→(天后/60/40) → 模糊→(天后/80/60) → 模糊→(天后/80/60) → 忘记→(天后/60/40) → 忘记→(80/60/20) → 认识→(80/60,天后) → 认识→完成', () => {
    let s = afterFirst('vague') // L1a
    const N = s.nextIntervalDays // 用首次反馈算出的长期间隔（不另算）
    expect(s.todayProgressLevel).toBe(1)
    expect(triplet(s)).toEqual(['今日进度80%', '今日进度60%', '今日进度20%'])

    let r = scheduleNext(s, 'vague', NOW + 1 * HOUR, V2) // L1a→L2
    s = r.state
    expect(s.todayProgressLevel).toBe(3)
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度60%', '今日进度40%'])

    r = scheduleNext(s, 'vague', NOW + 2 * HOUR, V2) // L2→L3
    s = r.state
    expect(s.todayProgressLevel).toBe(4)
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度80%', '今日进度60%'])

    r = scheduleNext(s, 'vague', NOW + 3 * HOUR, V2) // L3→L3（停住）
    s = r.state
    expect(s.todayProgressLevel).toBe(4)
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度80%', '今日进度60%'])

    r = scheduleNext(s, 'forgot', NOW + 4 * HOUR, V2) // L3→L2
    s = r.state
    expect(s.todayProgressLevel).toBe(3)
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度60%', '今日进度40%'])

    r = scheduleNext(s, 'forgot', NOW + 5 * HOUR, V2) // L2→L1a（回到 80/60/20）
    s = r.state
    expect(s.todayProgressLevel).toBe(1)
    expect(triplet(s)).toEqual(['今日进度80%', '今日进度60%', '今日进度20%'])

    r = scheduleNext(s, 'familiar', NOW + 6 * HOUR, V2) // L1a→L3
    expect(r.completesToday).toBe(false)
    s = r.state
    expect(s.todayProgressLevel).toBe(4)
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度80%', '今日进度60%'])

    r = scheduleNext(s, 'familiar', NOW + 7 * HOUR, V2) // L3→完成
    expect(r.completesToday).toBe(true)
  })
})

describe('端到端序列 3 · yellow', () => {
  it('首评不确定→(80/60/20) → 模糊→(60/40) → 模糊→(80/60) → 模糊→(80/60) → 忘记→(60/40) → 认识→完成', () => {
    let s = afterFirst('vague')
    const N = s.nextIntervalDays
    expect(triplet(s)).toEqual(['今日进度80%', '今日进度60%', '今日进度20%'])

    s = scheduleNext(s, 'vague', NOW + HOUR, V2).state // L1a→L2
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度60%', '今日进度40%'])

    s = scheduleNext(s, 'vague', NOW + 2 * HOUR, V2).state // L2→L3
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度80%', '今日进度60%'])

    s = scheduleNext(s, 'vague', NOW + 3 * HOUR, V2).state // L3→L3
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度80%', '今日进度60%'])

    s = scheduleNext(s, 'forgot', NOW + 4 * HOUR, V2).state // L3→L2
    expect(triplet(s)).toEqual([`${N} 天后`, '今日进度60%', '今日进度40%'])

    const done = scheduleNext(s, 'familiar', NOW + 5 * HOUR, V2) // L2→完成
    expect(done.completesToday).toBe(true)
  })
})
