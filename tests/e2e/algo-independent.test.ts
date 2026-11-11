/**
 * QA · AC1/AC2/AC3 独立复算与补充验收（**task-26 新基准**，2026-11-11 更新）。
 *
 * ⚠️ 本文件的「期望值」全部来自 `tests/e2e/fixtures/algo-reference.json`，
 *    该文件由 `tests/e2e/algo-reference.py` 按新 SPEC（§3.2 参数 / §3.3 公式 /
 *    §3.4 rating 与 predictAll / §3.5 伪代码 / research 04 官方截图锚点）
 *    **完全独立复算**得出，不引用 src/core。
 *    本文件只做「实现输出 vs 独立期望值」的比对。
 *
 * 新基准（task-26，旧基准已废弃）：
 *  - 新词首评：认识 K=80（d=1→63/44/33/21/10），模糊独立 K_v=100（3/2/2/2/1），忘记 1（±1 天）
 *  - d0=5 连续认识：21 → 44 → 88 → 169 → 311 → 365 → 365…
 *  - 非首评「忘记」不再强制次日（按公式重算，可 1/2/4/7 天）
 *  - predictAll（进度模型 v2 五档，默认）：新词 dog(d=1) 首显 63 天后 / 今日 / 3 天后 / 今日 / 1 天后；
 *    同日链 忘记→60/40/20 → 模糊→80/60/20 → 认识→1 天后/80/60；face/cat/yellow 三条真机序列。
 *    同日回炉 P=20% → 60/40/20%；P=40% → 80/60/40%；P=80% → 1 天后 / 80% / 80%
 *
 * 覆盖：
 *  - AC1：首评间隔表、连续认识新序列、首评忘记/模糊、非首评忘记、predictAll 数值快照、阈值法边界。
 *  - AC2：不熟悉度公式组合（含异常输入）。
 *  - AC3：mode=sequential/random 收敛性、总点击恒等式、边界、savedCounts 恢复
 *    （task-26 random 新语义：每次 tap 立即重选、允许连续同一 c）。
 */

import { describe, expect, it } from 'vitest'
import reference from './fixtures/algo-reference.json'
import {
  advanceMemory,
  createSession,
  createWordState,
  familiarity,
  firstFamiliarDays,
  firstVagueDays,
  intervalFromRetention,
  isFirstShow,
  isMemoryComplete,
  openMemory,
  predictAll,
  scheduleNext,
  tapBoard,
  tapMemory,
  type Rating,
  type SessionSettings,
  type SessionWord,
  type WordPredicts,
} from '../../src/core'

const DAY_MS = 86_400_000
const START = Date.UTC(2026, 0, 1, 1, 0, 0)

interface StepActual {
  p: number
  h: number
  d: number
  interval: number
}

function fresh(difficulty = 5, wordId = 'qa:test') {
  return createWordState({ wordId, deckId: 'qa', difficulty, now: START })
}

function runSequence(ratings: Rating[], d0 = 5): StepActual[] {
  let now = START
  let state = fresh(d0)
  const out: StepActual[] = []
  for (const rating of ratings) {
    const res = scheduleNext(state, rating, now)
    out.push({
      p: res.state.retrievability,
      h: res.state.stability,
      d: res.state.difficulty,
      interval: res.state.nextIntervalDays,
    })
    state = res.state
    // 研究脚本口径：恰好 interval 天后的同一钟点复习（p = 2^(-interval/h)）
    now += res.state.nextIntervalDays * DAY_MS
  }
  return out
}

function relErr(actual: number, expected: number): number {
  if (expected === 0) return Math.abs(actual - expected)
  return Math.abs(actual - expected) / Math.abs(expected)
}

// h/p 相对误差 ≤1%（SPEC §3.3）；间隔按 SPEC 允许 ±1 天（首评表）/精确（连续序列）
const H_TOL = 0.01
const DAY_TOL = 1

function assertStep(
  actual: StepActual,
  expected: { p: number; h: number; interval: number },
  dayTol = 0,
) {
  expect(relErr(actual.h, expected.h), `h=${actual.h} 期望=${expected.h}`).toBeLessThanOrEqual(H_TOL)
  expect(relErr(actual.p, expected.p), `p=${actual.p} 期望=${expected.p}`).toBeLessThanOrEqual(H_TOL)
  if (dayTol > 0) {
    expect(Math.abs(actual.interval - expected.interval), `interval=${actual.interval} 期望=${expected.interval}`)
      .toBeLessThanOrEqual(dayTol)
  } else {
    expect(actual.interval, `interval=${actual.interval} 期望=${expected.interval}`).toBe(expected.interval)
  }
}

/** UI 格式化（逐字对齐 SPEC §3.4 / research 04 §3.2；core 只出数据） */
function fmt(p: { first: boolean; days: number; progress: number }): string {
  if (p.progress >= 1) return `${p.days} 天后`
  if (p.first) return `今日 / ${p.days} 天后`
  return `今日进度${Math.round(100 * p.progress)}%`
}

function fmtAll(preds: WordPredicts): Record<'familiar' | 'vague' | 'forgot', string> {
  return {
    familiar: fmt(preds.familiar),
    vague: fmt(preds.vague),
    forgot: fmt(preds.forgot),
  }
}

describe('AC1 · 独立复算（task-26 新基准；期望值来自 Python 独立实现，不 import src/core）', () => {
  it('初始半衰期：d=1→5.19、d=2→3.60、d=5→1.7635、d=10→0.81（与独立复算一致）', () => {
    for (const d of [1, 2, 5, 10] as const) {
      const res = scheduleNext(fresh(d), 'familiar', START)
      expect(relErr(res.state.stability, reference.firstHalfLives[`d${d}`].familiar as number)).toBeLessThanOrEqual(H_TOL)
    }
    expect(relErr(scheduleNext(fresh(5), 'forgot', START).state.stability, reference.initialStability.d5)).toBeLessThanOrEqual(H_TOL)
  })

  it('新词首评间隔表：认识 K=80（63/44/33/21/10）、模糊 K_v=100（3/2/2/2/1）、忘记 1（±1 天）', () => {
    const ratings: Rating[] = ['familiar', 'vague', 'forgot']
    for (const d of [1, 2, 3, 5, 10] as const) {
      for (const rating of ratings) {
        const expected = (reference.firstIntervals[`d${d}`] as Record<string, number>)[rating]!
        const res = scheduleNext(fresh(d), rating, START)
        expect(
          Math.abs(res.state.nextIntervalDays - expected),
          `d=${d} ${rating}: 实际 ${res.state.nextIntervalDays} 期望 ${expected}`,
        ).toBeLessThanOrEqual(DAY_TOL)
        expect(Number.isFinite(res.state.stability)).toBe(true)
        expect(res.longTermUpdate).toBe(true)
      }
    }
    // 直接对比导出的首评间隔函数（与 scheduleNext 同源）
    for (const d of [1, 2, 3, 5, 10] as const) {
      expect(Math.abs(firstFamiliarDays(d) - reference.firstIntervals[`d${d}`].familiar)).toBeLessThanOrEqual(DAY_TOL)
      expect(Math.abs(firstVagueDays(d) - reference.firstIntervals[`d${d}`].vague)).toBeLessThanOrEqual(DAY_TOL)
    }
  })

  it('d0=5 连续「认识」新基准（K=80）：间隔 21→44→88→169→311→365→365…（旧 1→2→5→11… 已废弃）', () => {
    const actual = runSequence(Array(8).fill('familiar') as Rating[])
    expect(actual.map((s) => s.interval)).toEqual([21, 44, 88, 169, 311, 365, 365, 365])
    reference.familiarSequence_d0_5.forEach((expected, i) => {
      assertStep(actual[i]!, expected)
    })
    // 首评「认识」不是 1 天（task-26 用户 P0 根因已修复）
    expect(actual[0]!.interval).toBeGreaterThanOrEqual(7)
  })

  it('持续认识：第 6 次起间隔封顶 365 并保持（不产生“毕业”）', () => {
    const actual = runSequence(Array(10).fill('familiar') as Rating[])
    expect(actual.slice(5).every((s) => s.interval === 365)).toBe(true)
  })

  it('首评「忘记」：h=h0(d)、d+2、固定 1 天；首评「模糊」：d 不变、间隔=d×模糊首评天数', () => {
    const forgot = scheduleNext(fresh(5), 'forgot', START)
    expect(forgot.state.nextIntervalDays).toBe(1) // 首评忘记固定 1 天
    expect(forgot.state.difficulty).toBe(7)
    expect(relErr(forgot.state.stability, reference.initialStability.d5)).toBeLessThanOrEqual(H_TOL)
    assertStep(
      { p: 1, h: forgot.state.stability, d: forgot.state.difficulty, interval: forgot.state.nextIntervalDays },
      reference.newWordForgot_d5[0]!,
      DAY_TOL,
    )

    const vague = scheduleNext(fresh(5), 'vague', START)
    expect(vague.state.difficulty).toBe(5) // 模糊不加难度
    expect(Math.abs(vague.state.nextIntervalDays - reference.newWordVague_d5[0]!.interval)).toBeLessThanOrEqual(DAY_TOL)
    expect(relErr(vague.state.stability, reference.newWordVague_d5[0]!.h)).toBeLessThanOrEqual(H_TOL)
  })

  it('非首评「忘记」不再强制次日：按公式重算（高 h → 1~7 天，非固定 1 天）', () => {
    const ratings: Rating[] = ['familiar', 'familiar', 'familiar', 'familiar', 'familiar', 'forgot', 'familiar', 'familiar']
    const actual = runSequence(ratings)
    reference.forgetAfterHighH.forEach((expected, i) => {
      assertStep(actual[i]!, expected)
    })
    const forgotIdx = reference.forgetAfterHighH.findIndex((s) => s.rating === 'forgot')
    const forgotStep = reference.forgetAfterHighH[forgotIdx]!
    expect(actual[forgotIdx]!.d).toBe(7) // 忘记仍 +2 难度
    expect(actual[forgotIdx]!.interval).toBe(forgotStep.interval)
    expect(actual[forgotIdx]!.interval).toBeGreaterThan(1) // ← 关键：不再强制次日
    // 低 h 场景（首评模糊→次日记忘记）：期望值同样来自独立复算
    const low = runSequence(['vague', 'forgot', 'familiar'])
    reference.forgetAfterLowH.forEach((expected, i) => {
      assertStep(low[i]!, expected)
    })
  })

  it('predictAll v2 五档快照：dog(d=1) 首显 63/3/1 → 忘记 60/40/20 → 模糊 80/60/20 → 认识 1天后/80/60', () => {
    const NOW = new Date(2026, 10, 11, 9, 0, 0).getTime()
    const dog = createWordState({ wordId: 'qa:dog', deckId: 'qa', difficulty: 1, now: NOW })
    expect(isFirstShow(dog)).toBe(true)

    // 1) 新词首次显示：逐字对齐 fixture（独立复算）
    expect(fmtAll(predictAll(dog, NOW))).toEqual(reference.predictDog.first)
    expect(fmtAll(predictAll(dog, NOW))).toEqual({
      familiar: '63 天后',
      vague: '今日 / 3 天后',
      forgot: '今日 / 1 天后',
    })

    const steps: Array<{ after: string; state: ReturnType<typeof scheduleNext>['state']; at: number }> = []
    let state = dog
    let at = NOW
    for (const rating of reference.predictDog.ratings as Rating[]) {
      const res = scheduleNext(state, rating, at)
      at += 1000
      state = res.state
      steps.push({ after: rating, state, at })
    }
    expect(steps).toHaveLength(3)
    reference.predictDog.steps.forEach((expected, i) => {
      const step = steps[i]!
      const texts = fmtAll(predictAll(step.state, step.at))
      for (const rating of ['familiar', 'vague', 'forgot'] as const) {
        const exp = expected.predicts[rating]!
        expect(texts[rating], `${expected.after} ${rating} 文案`).toBe(exp.text)
        expect(predictAll(step.state, step.at)[rating].days, `${expected.after} ${rating} days`).toBe(exp.days)
      }
    })
    // 关键快照（Lead 明确要求：P=40% 时 v2 L1a 忘记=20%，不是 40%）
    expect(fmtAll(predictAll(steps[1]!.state, steps[1]!.at))).toEqual({
      familiar: '今日进度80%',
      vague: '今日进度60%',
      forgot: '今日进度20%',
    })
    expect(fmtAll(predictAll(steps[2]!.state, steps[2]!.at))).toEqual({
      familiar: '1 天后',
      vague: '今日进度80%',
      forgot: '今日进度60%',
    })
  })

  it('v2 真机序列 face / cat / yellow：逐档位预测与完成标记与独立复算一致', () => {
    const NOW = new Date(2026, 10, 11, 9, 0, 0).getTime()
    for (const name of ['face', 'cat', 'yellow'] as const) {
      const expected = reference.sequences[name]
      let state = createWordState({ wordId: `qa:${name}`, deckId: 'qa', difficulty: 1, now: NOW })
      let at = NOW
      expected.steps.forEach((step, i) => {
        const res = scheduleNext(state, expected.ratings[i] as Rating, at)
        at += 1000
        expect(res.completesToday, `${name} 第 ${i + 1} 步 completesToday`).toBe(step.completes)
        state = res.state
        const texts = fmtAll(predictAll(state, at))
        for (const rating of ['familiar', 'vague', 'forgot'] as const) {
          const exp = step.predicts[rating]!
          expect(texts[rating], `${name} 第 ${i + 1} 步 ${rating}`).toBe(exp.text)
        }
      })
    }
    // 关键快照（与 dev-algo 三条真机序列一致）
    // face：首评不认识 → 60/40/20 → 认识 → 1天后/60/40 → 认识完成
    const face = reference.sequences.face
    expect(face.steps[0]!.predicts.familiar!.text).toBe('今日进度60%')
    expect(face.steps[1]!.predicts.familiar!.text).toBe('1 天后')
    // cat：80/60/20 → 3天后/60/40 → 3天后/80/60 → 3天后/80/60 → 3天后/60/40 → 80/60/20 → 3天后/80/60 → 完成
    expect(reference.sequences.cat.steps.map((s) => s.predicts.forgot!.text)).toEqual([
      '今日进度20%', '今日进度40%', '今日进度60%', '今日进度40%', '今日进度20%', '今日进度60%', '今日进度60%',
    ])
    expect(reference.sequences.cat.steps.at(-1)!.completes).toBe(true)
  })

  it('记录与独立复算的实测最大相对误差（证据用）', () => {
    let maxH = 0
    let maxP = 0
    const actual = runSequence(Array(8).fill('familiar') as Rating[])
    actual.forEach((step, i) => {
      const expected = reference.familiarSequence_d0_5[i]!
      maxH = Math.max(maxH, relErr(step.h, expected.h))
      maxP = Math.max(maxP, relErr(step.p, expected.p))
    })
    const low = runSequence(['vague', 'forgot', 'familiar'])
    low.forEach((step, i) => {
      const expected = reference.forgetAfterLowH[i]!
      maxH = Math.max(maxH, relErr(step.h, expected.h))
      maxP = Math.max(maxP, relErr(step.p, expected.p))
    })
    expect(maxH).toBeLessThan(H_TOL)
    expect(maxP).toBeLessThan(H_TOL)
    console.log(`[AC1] 实现 vs 独立复算 最大相对误差 h=${(maxH * 100).toExponential(2)}% p=${(maxP * 100).toExponential(2)}%`)
  })

  it('阈值法边界：h 极小/极大/clamp、R_target 0.85/0.92 与独立复算一致', () => {
    expect(intervalFromRetention(1.7635)).toBe(reference.intervalFromRetention['h_1.7635'])
    expect(intervalFromRetention(176.35)).toBe(reference.intervalFromRetention['h_176.35'])
    expect(intervalFromRetention(4002.94)).toBe(reference.intervalFromRetention['h_4002.94'])
    expect(intervalFromRetention(100000)).toBe(reference.intervalFromRetention.h_100000)
    expect(intervalFromRetention(0.1)).toBe(reference.intervalFromRetention['h_0.1'])
    expect(intervalFromRetention(50, 0.85)).toBe(reference.intervalFromRetention['h_50_r0.85'])
    expect(intervalFromRetention(50, 0.92)).toBe(reference.intervalFromRetention['h_50_r0.92'])
    for (const h of [Number.EPSILON, 0, -5, 1e9, Number.NaN, Number.POSITIVE_INFINITY]) {
      const v = intervalFromRetention(h)
      expect(v, `h=${h}`).toBeGreaterThanOrEqual(1)
      expect(v, `h=${h}`).toBeLessThanOrEqual(365)
    }
  })
})

describe('AC2 · 不熟悉度公式独立复算（含异常输入）', () => {
  it('与独立复算逐项一致：0/0→null、1/1→1、1/3→0.3333、3/7、7/5→clamp 1、0/5→0', () => {
    const cases: Array<[number, number, number | null]> = [
      [0, 0, reference.familiarity['0/0']],
      [1, 1, reference.familiarity['1/1']],
      [1, 3, reference.familiarity['1/3']],
      [3, 7, reference.familiarity['3/7']],
      [7, 5, reference.familiarity['7/5']],
      [0, 5, reference.familiarity['0/5']],
    ]
    for (const [clicks, encounters, expected] of cases) {
      expect(familiarity(clicks, encounters), `${clicks}/${encounters}`).toBe(expected)
    }
    expect(familiarity(1, 3)).toBeCloseTo(0.3333, 4)
    expect(familiarity(7, 5)).toBe(1) // 展示 clamp，原始 clicks 保留在数据层
    expect(familiarity(0, 0)).toBeNull() // 展示 —
  })

  it('异常输入：clicks>encounters 展示 clamp、encounters<=0 → null、NaN/Infinity 不产生 NaN 数字', () => {
    expect(familiarity(5, 0)).toBe(reference.familiarity['5/0'])
    expect(familiarity(0, -3)).toBe(reference.familiarity['0/-3'])
    expect(familiarity(5, 0)).toBeNull()
    expect(familiarity(0, -3)).toBeNull()
    for (const [c, e] of [
      [Number.NaN, 3],
      [3, Number.NaN],
      [Number.POSITIVE_INFINITY, 3],
      [3, Number.POSITIVE_INFINITY],
      [-2, 4],
      [2, -4],
    ]) {
      const v = familiarity(c!, e!)
      if (v !== null) {
        expect(Number.isFinite(v), `${c}/${e} → ${v}`).toBe(true)
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    }
  })
})

// ============================================================ AC3 补充（性质测试）
const WORD: SessionWord = {
  wordId: 'qa:multi',
  deckId: 'qa',
  headword: 'multi',
  meanings: [
    { meaningId: 'qa:multi#M1', cn: '一' },
    { meaningId: 'qa:multi#M2', cn: '二' },
    { meaningId: 'qa:multi#M3', cn: '三' },
  ],
  phrases: [],
}

const SETTINGS: SessionSettings = {
  totalRepeats: 3,
  mode: 'sequential',
  showPhrases: false,
  exampleCount: 2,
  showPhonetic: true,
}

/** 用给定随机源跑完整个 w-c 流程，返回 { taps, activeOrder, counts }；断言流程一定收敛。 */
function runMemory(settings: SessionSettings, random: () => number, savedCounts?: Record<string, number>) {
  let s = createSession({ word: WORD, settings, savedCounts, now: START })
  s = tapBoard(s)
  s = openMemory(s, random)
  const taps: string[] = []
  const activeOrder: string[] = []
  let guard = 0
  let lastActive: string | null = null
  let needsAdvanceCount = 0
  while (s.stage === 'memory' && guard < 200) {
    guard += 1
    const active = s.activeMeaningId!
    if (active !== lastActive) {
      activeOrder.push(active)
      lastActive = active
    }
    s = tapMemory(s, random) // task-26：random 模式在 tapMemory 内立即重选（需注入随机源）
    taps.push(active)
    if (s.needsAdvance) {
      needsAdvanceCount += 1
      s = advanceMemory(s, random)
    }
  }
  expect(s.stage).toBe('annotation')
  expect(isMemoryComplete(s)).toBe(true)
  return { taps, activeOrder, counts: s.wcCounts, guard, needsAdvanceCount }
}

/** 简单可复现 LCG（不依赖实现随机） */
function lcg(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0
    return x / 4294967296
  }
}

describe('AC3 补充 · mode 两种流程的独立性质测试', () => {
  it('sequential：3 个含义 × 3 次 → 次数 [3,3,3]、顺序 M1→M2→M3 循环、总点击 9', () => {
    const { taps, counts } = runMemory(SETTINGS, lcg(1))
    expect(counts).toEqual({ 'qa:multi#M1': 3, 'qa:multi#M2': 3, 'qa:multi#M3': 3 })
    expect(taps).toHaveLength(9)
    expect(taps).toEqual([
      'qa:multi#M1', 'qa:multi#M1', 'qa:multi#M1',
      'qa:multi#M2', 'qa:multi#M2', 'qa:multi#M2',
      'qa:multi#M3', 'qa:multi#M3', 'qa:multi#M3',
    ])
  })

  it('random（task-26 新语义）：200 个种子全部收敛，总点击恒 = 9，每含义恰好 3 次；每次 tap 立即重选', () => {
    // SPEC §4.3（2026-11-11 修正）：random 模式每次 tap 后立即从未满集合均匀随机重选，
    // **允许连续两次抽中同一个 c**；总点击恒 = 含义数 × totalRepeats；不再要求“不连续同 c”。
    let maxGuard = 0
    for (let seed = 1; seed <= 200; seed += 1) {
      const { taps, counts, guard, needsAdvanceCount } = runMemory({ ...SETTINGS, mode: 'random' }, lcg(seed))
      expect(taps, `seed=${seed}`).toHaveLength(9)
      expect(counts).toEqual({ 'qa:multi#M1': 3, 'qa:multi#M2': 3, 'qa:multi#M3': 3 })
      // random 模式切换在 tapMemory 内完成，不应依赖 advanceMemory
      expect(needsAdvanceCount, `seed=${seed} random 不应出现 needsAdvance`).toBe(0)
      maxGuard = Math.max(maxGuard, guard)
    }
    expect(maxGuard).toBeLessThanOrEqual(9)

    // 固定随机源可复现：两次独立运行点击序列一致
    const runA = runMemory({ ...SETTINGS, mode: 'random' }, lcg(42))
    const runB = runMemory({ ...SETTINGS, mode: 'random' }, lcg(42))
    expect(runA.taps).toEqual(runB.taps)
  })

  it('边界 totalRepeats=1：每次点击即切换，3 个含义共 3 次点击后回注释面', () => {
    const { taps } = runMemory({ ...SETTINGS, totalRepeats: 1 }, lcg(7))
    expect(taps).toHaveLength(3)
    expect(new Set(taps).size).toBe(3)
  })

  it('边界 totalRepeats=10：3 个含义共 30 次点击，sequential 每 c 恰好 10 次', () => {
    const { taps, counts } = runMemory({ ...SETTINGS, totalRepeats: 10 }, lcg(7))
    expect(taps).toHaveLength(30)
    expect(counts).toEqual({ 'qa:multi#M1': 10, 'qa:multi#M2': 10, 'qa:multi#M3': 10 })
  })

  it('边界 meanings.length=1：不切换，满后回注释面（sequential/random 均如此）', () => {
    const single: SessionWord = { ...WORD, meanings: [{ meaningId: 'qa:single#M1', cn: '唯一' }] }
    for (const mode of ['sequential', 'random'] as const) {
      let s = createSession({ word: single, settings: { ...SETTINGS, mode }, now: START })
      s = tapBoard(s)
      s = openMemory(s, lcg(3))
      for (let i = 0; i < 3; i += 1) {
        expect(s.activeMeaningId).toBe('qa:single#M1')
        s = tapMemory(s)
        if (s.needsAdvance) s = advanceMemory(s, lcg(3))
      }
      expect(s.stage).toBe('annotation')
      expect(isMemoryComplete(s)).toBe(true)
    }
  })

  it('random 注入固定 random=0：允许连续同一 c，且最终所有 c 都记满（可复现）', () => {
    let s = createSession({ word: WORD, settings: { ...SETTINGS, mode: 'random' }, now: START })
    s = tapBoard(s)
    s = openMemory(s, () => 0)
    const seq: string[] = []
    let tap = 0
    while (s.stage === 'memory' && tap < 50) {
      tap += 1
      seq.push(s.activeMeaningId!)
      s = tapMemory(s, () => 0)
    }
    // random()=0 时永远选「未满集合」的第一个：M1×3 → M2×3 → M3×3（连续同 c 是新语义允许的）
    expect(seq).toHaveLength(9)
    expect(seq.slice(0, 3)).toEqual(['qa:multi#M1', 'qa:multi#M1', 'qa:multi#M1'])
    expect(new Set(seq).size).toBe(3)
  })

  it('D15 中断恢复：savedCounts 恢复后已满含义不再出现，剩余次数正确', () => {
    const saved = { 'qa:multi#M1': 3, 'qa:multi#M2': 3, 'qa:multi#M3': 1 }
    const { taps, counts } = runMemory(SETTINGS, lcg(11), saved)
    expect(counts).toEqual({ 'qa:multi#M1': 3, 'qa:multi#M2': 3, 'qa:multi#M3': 3 })
    expect(taps).toHaveLength(2)
    expect(new Set(taps)).toEqual(new Set(['qa:multi#M3']))

    const saved2 = { 'qa:multi#M1': 3, 'qa:multi#M2': 0, 'qa:multi#M3': 1 }
    const r2 = runMemory({ ...SETTINGS, mode: 'random' }, lcg(13), saved2)
    expect(r2.taps).toHaveLength(5)
    expect(r2.taps).not.toContain('qa:multi#M1')
    expect(r2.counts).toEqual({ 'qa:multi#M1': 3, 'qa:multi#M2': 3, 'qa:multi#M3': 3 })

    const saved3 = { 'qa:multi#M1': 2, 'qa:multi#M2': 0, 'qa:multi#M3': 1 }
    const r3 = runMemory({ ...SETTINGS, mode: 'random' }, lcg(17), saved3)
    expect(r3.taps).toHaveLength(6)
    expect(r3.counts).toEqual({ 'qa:multi#M1': 3, 'qa:multi#M2': 3, 'qa:multi#M3': 3 })
  })
})
