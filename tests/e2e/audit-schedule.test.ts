/**
 * QA task-21/31 · 复习间隔与队列审计（**v2 新语义，2026-11-11 task-26/27 之后更新**）。
 *
 * 旧版本锁定的是 v1 行为（首评 1 天、1→2→5… 序列、dailyGoal 硬截断、忘记强制次日），
 * 已随官方对齐改造而废弃。v2 新语义：
 *  - 新词首评：认识 K=80（d=1→63 / d=2→44 / d=5→21 / d=10→10，±1 天）；
 *    模糊独立 K_v=100（d=1→3 / d=2→2 / d=5→2 / d=10→1，±1 天）；忘记固定 1 天；
 *  - d0=5 连续「认识」：21 → 44 → 88 → 169 → 311 → 365…；
 *  - 非首评「忘记」不再强制次日，按答错公式重算（可能 1/2/4/7 天）；
 *  - **每日学习量不截断复习**：reviewQueue = 全部到期词；newBudget = max(0, dailyGoal − dueCount)。
 *
 * 运行（单文件单 fork）：
 *   npx vitest run tests/e2e/audit-schedule.test.ts --pool=forks --poolOptions.forks.maxForks=1
 */

import { describe, expect, it } from 'vitest'
import {
  createWordState,
  firstFamiliarDays,
  firstVagueDays,
  pickQueue,
  scheduleNext,
  startOfLocalDay,
  type Rating,
  type WordState,
} from '../../src/core'

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
/** 第 1 天 = 2026-11-11 09:00 本地时间 */
const DAY1 = startOfLocalDay(new Date(2026, 10, 11, 9, 0, 0).getTime()) + 9 * HOUR_MS

function atHour(day: number, hour = 9): number {
  return startOfLocalDay(DAY1 + (day - 1) * DAY_MS) + hour * HOUR_MS
}

/** 构造一个「已到期」的复习状态（审计用，不写库） */
function reviewedState(wordId: string, now: number, elapsedDays = 10, stability = 30): WordState {
  const base = createWordState({ wordId, deckId: 'audit', difficulty: 5, now })
  return {
    ...base,
    phase: 'review',
    stability,
    reps: 3,
    lapses: 0,
    firstSeenAt: now - 100 * DAY_MS,
    lastReviewedAt: now - elapsedDays * DAY_MS,
    dueAt: startOfLocalDay(now - 1),
    nextIntervalDays: 10,
    retrievability: 0.5,
  }
}

interface LogRow {
  day: number
  due: number
  reviewN: number
  newN: number
  total: number
  newBudget: number
}

/**
 * 模拟：words 个词全部从新词开始；每天按 policy 给队列里的词评分。
 * dailyGoal 决定 newBudget（复习不再截断）。
 */
function simulate(params: {
  wordCount: number
  days: number
  dailyGoal: number
  policy: (wordId: string, day: number) => Rating
}): { rows: LogRow[]; states: Map<string, WordState> } {
  const states = new Map<string, WordState>()
  for (let i = 1; i <= params.wordCount; i += 1) {
    states.set(`w${i}`, createWordState({ wordId: `w${i}`, deckId: 'audit', now: atHour(1) }))
  }
  const rows: LogRow[] = []
  for (let day = 1; day <= params.days; day += 1) {
    const now = atHour(day)
    const queue = pickQueue([...states.values()], { now, dailyGoal: params.dailyGoal, deckId: null })
    const queued = [...queue.reviewQueue, ...queue.newQueue]
    for (const st of queued) {
      const res = scheduleNext(st, params.policy(st.wordId, day), now)
      states.set(st.wordId, res.state)
    }
    rows.push({
      day,
      due: queue.dueCount,
      reviewN: queue.reviewQueue.length,
      newN: queue.newQueue.length,
      total: queue.totalPlanned,
      newBudget: queue.newBudget,
    })
  }
  return { rows, states }
}

function printTable(title: string, rows: LogRow[]) {
  const lines = [
    `\n=== ${title} ===`,
    '| 天 | 到期总数 | 复习队列 | 新学队列 | 队列合计 | 新学预算 |',
    '|---|---|---|---|---|---|',
  ]
  for (const r of rows) {
    lines.push(`| ${r.day} | ${r.due} | ${r.reviewN} | ${r.newN} | ${r.total} | ${r.newBudget} |`)
  }
  console.log(lines.join('\n'))
}

describe('复习间隔 / 队列长度审计 v2（task-26 新语义）', () => {
  it('A. 新词首评间隔表：认识 K=80（63/44/21/10）、模糊 K_v=100（3/2/2/1）、忘记 1（±1 天）', () => {
    const familiarExpected = { 1: 63, 2: 44, 5: 21, 10: 10 } as const
    const vagueExpected = { 1: 3, 2: 2, 5: 2, 10: 1 } as const
    for (const d of [1, 2, 5, 10] as const) {
      const fresh = createWordState({ wordId: `w-d${d}`, deckId: 'audit', difficulty: d, now: atHour(1) })

      const fam = scheduleNext(fresh, 'familiar', atHour(1))
      expect(Math.abs(fam.state.nextIntervalDays - familiarExpected[d]), `d=${d} 认识`).toBeLessThanOrEqual(1)
      expect(Math.abs(firstFamiliarDays(d) - familiarExpected[d]), `firstFamiliarDays(${d})`).toBeLessThanOrEqual(1)
      expect(fam.state.difficulty).toBe(d)

      const vague = scheduleNext(fresh, 'vague', atHour(1))
      expect(Math.abs(vague.state.nextIntervalDays - vagueExpected[d]), `d=${d} 模糊`).toBeLessThanOrEqual(1)
      expect(Math.abs(firstVagueDays(d) - vagueExpected[d]), `firstVagueDays(${d})`).toBeLessThanOrEqual(1)
      expect(vague.state.difficulty).toBe(d) // 模糊不加难度

      const forgot = scheduleNext(fresh, 'forgot', atHour(1))
      expect(forgot.state.nextIntervalDays).toBe(1) // 首评忘记固定 1 天
      expect(forgot.state.difficulty).toBe(d + 2) // 忘记 +2
    }
    console.log('\n=== A. 首评间隔（认识/模糊/忘记，天，K=80/K_v=100）===\n d1: 63/3/1 | d2: 44/2/1 | d5: 21/2/1 | d10: 10/1/1')
  })

  it('B. d0=5 连续「认识」：间隔 21→44→88→169→311→365→365…，h 与 SPEC 基准一致（±1%）', () => {
    let state = createWordState({ wordId: 'w1', deckId: 'audit', now: atHour(1) })
    const intervals: number[] = []
    const stabilities: number[] = []
    let now = atHour(1)
    const expectedH = [141.08, 292.27, 580.8, 1109.4, 2044.04]
    for (let i = 0; i < 7; i += 1) {
      const res = scheduleNext(state, 'familiar', now)
      intervals.push(res.state.nextIntervalDays)
      stabilities.push(res.state.stability)
      state = res.state
      now += res.state.nextIntervalDays * DAY_MS
    }
    expect(intervals).toEqual([21, 44, 88, 169, 311, 365, 365])
    expectedH.forEach((h, i) => {
      const rel = Math.abs(stabilities[i]! - h) / h
      expect(rel, `第 ${i + 1} 次 h=${stabilities[i]} 期望≈${h}`).toBeLessThanOrEqual(0.01)
    })
    console.log(
      `\n=== B. d0=5 连续认识 ===\n间隔: ${intervals.join(' → ')}\nh: ${stabilities.map((h) => h.toFixed(2)).join(' → ')}`,
    )
  })

  it('C. 10 个新词全部「认识」按天推进：day2 无到期，day22 全部到期（首间隔 21 天）', () => {
    const { rows } = simulate({ wordCount: 10, days: 60, dailyGoal: 30, policy: () => 'familiar' })
    printTable('C. 10 词全部一直「认识」（dailyGoal=30）', rows.filter((r) => r.due > 0 || r.day <= 3))
    expect(rows[1]!.due).toBe(0) // 旧版 day2=10；v2 首评认识到期 27 天后
    expect(rows[21]!.due).toBe(10) // day22（下标 21）
  })

  it('D. 10 个新词全部「模糊」按天推进：day2 无到期、day3 全部到期（d0=5 首模糊 2 天）', () => {
    const { rows } = simulate({ wordCount: 10, days: 10, dailyGoal: 30, policy: () => 'vague' })
    printTable('D. 10 词全部一直「模糊」（dailyGoal=30）', rows)
    expect(rows[1]!.due).toBe(0)
    expect(rows[2]!.due).toBe(10)
  })

  it('E. 10 个新词全部「不认识」按天推进：day2 全部到期（首评忘记固定 1 天）', () => {
    const { rows } = simulate({ wordCount: 10, days: 8, dailyGoal: 30, policy: () => 'forgot' })
    printTable('E. 10 词全部一直「不认识」（dailyGoal=30）', rows)
    expect(rows[1]!.due).toBe(10)
  })

  it('F. 认识后忘记（高 h）：不再强制次日，按公式重算为 4 天', () => {
    // 连续 5 次认识：间隔 21→44→88→169→311（h≈2044，K=80）
    let st = createWordState({ wordId: 'w-forget', deckId: 'audit', now: atHour(1) })
    let now = atHour(1)
    const intervals: number[] = []
    for (let i = 0; i < 5; i += 1) {
      const r = scheduleNext(st, 'familiar', now)
      intervals.push(r.state.nextIntervalDays)
      st = r.state
      now += r.state.nextIntervalDays * DAY_MS
    }
    expect(intervals).toEqual([21, 44, 88, 169, 311])
    // 高 h（2044）时忘记：公式结果 4 天（>1，证明不强制次日）——期望值来自独立复算 fixture
    const forgot = scheduleNext(st, 'forgot', now)
    expect(forgot.state.nextIntervalDays).toBe(4)
    expect(forgot.state.nextIntervalDays).toBeGreaterThan(1)
    expect(forgot.state.difficulty).toBe(7) // 忘记仍 +2
    console.log(
      `\n=== F. 高 h 忘记 ===\n连续认识间隔 ${intervals.join(' → ')}；第 6 次忘记 → 间隔 ${forgot.state.nextIntervalDays} 天（非强制次日）`,
    )
  })

  it('G. 队列不再截断：due 50 + goal 30 → review 50 / new 0 / total 50；due 10 → 10/20/30', () => {
    const now = atHour(1)
    const due = Array.from({ length: 50 }, (_, i) => reviewedState(`r${i}`, now, 10 + (i % 5)))
    const newOnes = Array.from({ length: 40 }, (_, i) => createWordState({ wordId: `n${i}`, deckId: 'audit', now }))

    const q1 = pickQueue([...due, ...newOnes], { now, dailyGoal: 30 })
    expect(q1.dueCount).toBe(50)
    expect(q1.reviewQueue).toHaveLength(50) // 不截断
    expect(q1.newQueue).toHaveLength(0)
    expect(q1.newBudget).toBe(0)
    expect(q1.totalPlanned).toBe(50)

    const q2 = pickQueue([...due.slice(0, 10), ...newOnes], {
      now,
      dailyGoal: 30,
      orderOf: Object.fromEntries(newOnes.map((s, i) => [s.wordId, i])),
    })
    expect(q2.dueCount).toBe(10)
    expect(q2.reviewQueue).toHaveLength(10)
    expect(q2.newBudget).toBe(20)
    expect(q2.newQueue).toHaveLength(20)
    expect(q2.totalPlanned).toBe(30)

    const q3 = pickQueue(newOnes, { now, dailyGoal: 30 })
    expect(q3.reviewQueue).toHaveLength(0)
    expect(q3.newQueue).toHaveLength(30)
    expect(q3.totalPlanned).toBe(30)
    console.log('\n=== G. 队列不截断 ===\n due50+goal30 → 50/0/50；due10+goal30 → 10/20/30；due0+goal30 → 0/30/30')
  })

  it('H. 40 词 / dailyGoal=5 模拟：任何一天都「全部到期词入队」，不再出现截断积压', () => {
    const { rows } = simulate({
      wordCount: 40,
      days: 120,
      dailyGoal: 5,
      policy: () => 'familiar',
    })
    const truncated = rows.filter((r) => r.reviewN !== r.due)
    printTable(
      'H. 40 词、dailyGoal=5（到期数 > 0 的行）',
      rows.filter((r) => r.due > 0),
    )
    expect(truncated, `不应有复习截断行：${JSON.stringify(truncated.slice(0, 3))}`).toHaveLength(0)
    for (const r of rows) {
      // v2：复习全量入队；新学预算 = max(0, goal - due)，但受「还没学的新词数量」上限约束
      expect(r.newBudget).toBe(Math.max(0, 5 - r.due))
      expect(r.newN).toBeLessThanOrEqual(r.newBudget)
      expect(r.total).toBe(r.due + r.newN)
      if (r.due >= 5) expect(r.newN).toBe(0)
    }
    console.log('\nH 结论：120 天中 0 天出现「到期数 > 复习队列长度」，复习全量入队 ✅')
  })
})
