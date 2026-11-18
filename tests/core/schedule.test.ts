import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PARAMS,
  createWordState,
  initialStability,
  intervalFromRetention,
  isDue,
  isNew,
  localDateKey,
  memoryDurabilityDays,
  retrievabilityNow,
  scheduleNext,
  startOfLocalDay,
  addDays,
} from '../../src/core'
import type { Rating, WordState } from '../../src/core'
import { day, localMidnight, makeReviewed, NOW } from './helpers'

/**
 * task-26 新基准：d0=5、新词首评「认识」= 27 天（候选 A：h=K·h0(d), K=100），
 * 之后沿用 DHP 更新 + 阈值法（research 04 §11.4）。
 * 旧基准（首评 1 天 → 1,2,5,11…）已随首评间隔修复而废弃。
 */
const BASELINE = {
  p: [1, 0.902, 0.9009, 0.9003, 0.8998, 0.8999],
  h: [141.08, 292.27, 580.8, 1109.4, 2044.04, 3635.71], // K=80
  interval: [21, 44, 88, 169, 311, 365, 365, 365, 365, 365],
}

function relClose(actual: number, expected: number, tol = 0.01): boolean {
  return Math.abs(actual - expected) <= Math.abs(expected) * tol
}

/** 模拟一条词连续评分；每次复习发生在「上次 + 间隔天数」的同一钟点（与 research 附录 B 口径一致） */
function simulate(start: WordState, ratings: Rating[], nowStart: number): Array<{
  rating: Rating
  state: WordState
  now: number
  longTermUpdate: boolean
}> {
  let state = start
  let now = nowStart
  const out: Array<{ rating: Rating; state: WordState; now: number; longTermUpdate: boolean }> = []
  for (const rating of ratings) {
    const res = scheduleNext(state, rating, now)
    out.push({ rating, state: res.state, now, longTermUpdate: res.longTermUpdate })
    state = res.state
    now = addDays(now, res.state.nextIntervalDays)
  }
  return out
}

describe('core/schedule · 基准序列（AC1）', () => {
  it('d0=5 一直「认识」：首评 21 天（K=80），之后 44→88→169→311→365 封顶', () => {
    const rows = simulate(
      createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW }),
      Array<Rating>(10).fill('familiar'),
      NOW,
    )
    expect(rows.map((r) => r.state.nextIntervalDays)).toEqual(BASELINE.interval)
    expect(rows[0]!.state.nextIntervalDays).toBe(21)
  })

  it('基准序列：每次复习时 p 与更新后 h 相对误差 ≤1%', () => {
    const rows = simulate(
      createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW }),
      Array<Rating>(10).fill('familiar'),
      NOW,
    )
    rows.slice(0, 6).forEach((row, i) => {
      const p = row.state.retrievability
      const h = row.state.stability
      expect(relClose(p, BASELINE.p[i]!), `第 ${i + 1} 次序 p=${p} vs ${BASELINE.p[i]}`).toBe(true)
      expect(relClose(h, BASELINE.h[i]!), `第 ${i + 1} 次序 h=${h} vs ${BASELINE.h[i]}`).toBe(true)
    })
    expect(rows[9]!.state.stability).toBe(4096) // stabilityMax 封顶
    // 第 10 次序后间隔封顶 365，之后保持（官方无“完全记住”概念）
    expect(rows[9]!.state.nextIntervalDays).toBe(365)
    const after = scheduleNext(rows[9]!.state, 'familiar', rows[9]!.now + 365 * 86_400_000)
    expect(after.state.nextIntervalDays).toBe(365)
  })

  it('复习日「不认识」：h 75.10→7.78（±1%）、d 5→7、间隔按公式重算（=1 天）', () => {
    // 复习态：h=75.10、11 天前评过（p≈0.903）
    const prev = makeReviewed({ stability: 75.1, difficulty: 5, lastReviewedAt: NOW - 11 * 86_400_000 })
    const res = scheduleNext(prev, 'forgot', NOW)
    expect(relClose(res.state.stability, 7.78, 0.01)).toBe(true)
    expect(res.state.difficulty).toBe(7)
    expect(res.state.nextIntervalDays).toBe(1)
    expect(res.longTermUpdate).toBe(true)
    expect(res.requeue).toBe('requeue-forgot')
  })

  it('忘记后继续「认识」：h 7.78→16.57→39.87→82.21，间隔 3→6→12', () => {
    let state: WordState = {
      ...makeReviewed({ stability: 7.78, difficulty: 7, lastReviewedAt: NOW }),
      lastReviewedAt: NOW,
      dueAt: NOW,
    }
    let now = addDays(NOW, 1) // 忘记后长期间隔默认 1 天（d=7 时公式给出 1）
    const hs: number[] = []
    const ivls: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const res = scheduleNext(state, 'familiar', now)
      hs.push(res.state.stability)
      ivls.push(res.state.nextIntervalDays)
      state = res.state
      now = addDays(now, res.state.nextIntervalDays)
    }
    expect(relClose(hs[0]!, 16.57)).toBe(true)
    expect(relClose(hs[1]!, 39.87)).toBe(true)
    expect(relClose(hs[2]!, 82.21)).toBe(true)
    expect(ivls).toEqual([3, 6, 12])
    expect(state.difficulty).toBe(7)
  })
})

describe('core/schedule · 三条 rating 分支（AC1）', () => {
  // 复习发生在「上次评分之后的下一天」，否则会被判定为“当天非首次反馈”
  const AT = addDays(NOW, 1)
  it('familiar：升 h、d 不变、phase=review、间隔按阈值法', () => {
    const prev = makeReviewed({ stability: 10, difficulty: 5, lastReviewedAt: NOW })
    const res = scheduleNext(prev, 'familiar', AT)
    expect(res.longTermUpdate).toBe(true)
    expect(res.state.stability).toBeGreaterThan(10)
    expect(res.state.difficulty).toBe(5)
    expect(res.state.phase).toBe('review')
    expect(res.state.reps).toBe(prev.reps + 1)
    expect(res.state.lapses).toBe(prev.lapses)
    expect(res.state.nextIntervalDays).toBe(intervalFromRetention(res.state.stability))
  })

  it('vague：h 用答错公式、d 不变（dVagueStep=0）、不强制次日', () => {
    const prev = makeReviewed({ stability: 30, difficulty: 6 })
    const res = scheduleNext(prev, 'vague', AT)
    expect(res.longTermUpdate).toBe(true)
    expect(res.state.stability).toBeLessThan(30)
    expect(res.state.difficulty).toBe(6)
    expect(res.state.lapses).toBe(prev.lapses + 1)
    expect(res.state.reps).toBe(prev.reps)
    // 通常 1–5 天：h' 用答错公式后按阈值法
    expect(res.state.nextIntervalDays).toBeGreaterThanOrEqual(1)
    expect(res.state.nextIntervalDays).toBeLessThanOrEqual(5)
  })

  it('forgot：h 用答错公式、d+2（上限 18）、间隔按公式重算（不再强制次日）', () => {
    const prev = makeReviewed({ stability: 100, difficulty: 10 })
    const res = scheduleNext(prev, 'forgot', AT)
    expect(res.state.difficulty).toBe(12)
    // h=100、1 天后 p≈0.993 → h'≈15.33 → 间隔 2 天（旧实现强制 1 天）
    expect(res.state.nextIntervalDays).toBe(2)
    expect(res.state.phase).toBe('lapsed')
    expect(res.requeue).toBe('requeue-forgot')
  })

  it('难度边界：d=18 再忘记仍为 18；d=1 忘记 → 3', () => {
    const maxed = makeReviewed({ stability: 50, difficulty: 18 })
    expect(scheduleNext(maxed, 'forgot', AT).state.difficulty).toBe(18)

    const easy = makeReviewed({ stability: 50, difficulty: 1 })
    expect(scheduleNext(easy, 'forgot', AT).state.difficulty).toBe(3)
  })

  it('相变：new+familiar → review；new+vague → learning；review+forgot → lapsed', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    expect(scheduleNext(fresh, 'familiar', NOW).state.phase).toBe('review')
    expect(scheduleNext(fresh, 'vague', NOW).state.phase).toBe('learning')
    expect(scheduleNext(fresh, 'forgot', NOW).state.phase).toBe('learning')

    const review = makeReviewed({ stability: 20, difficulty: 5 })
    expect(scheduleNext(review, 'forgot', AT).state.phase).toBe('lapsed')
  })
})

describe('core/schedule · 新词首次评分（防 NaN/Infinity）', () => {
  it.each<Rating>(['familiar', 'vague', 'forgot'])('新词首次 %s：数值全部有限、间隔 1–365', (rating) => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const res = scheduleNext(fresh, rating, NOW)
    for (const v of [
      res.state.stability,
      res.state.difficulty,
      res.state.nextIntervalDays,
      res.state.retrievability,
      res.log.stabilityAfter,
      res.log.retrievabilityAtReview ?? 0,
    ]) {
      expect(Number.isFinite(v)).toBe(true)
    }
    expect(res.state.stability).toBeGreaterThan(0)
    expect(res.state.nextIntervalDays).toBeGreaterThanOrEqual(1)
    expect(res.state.nextIntervalDays).toBeLessThanOrEqual(365)
    expect(res.state.dueAt).not.toBeNull()
    expect(res.state.firstSeenAt).toBe(NOW)
    expect(res.state.lastReviewedAt).toBe(NOW)
    expect(res.log.stabilityBefore).toBe(fresh.stability)
    expect(res.log.elapsedDays).toBe(0)
  })

  it('新词首次忘记：d=5→7、间隔 1，且不套答错公式（h 仍是初始 h0）', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const res = scheduleNext(fresh, 'forgot', NOW)
    expect(res.state.difficulty).toBe(7)
    expect(res.state.nextIntervalDays).toBe(1)
    expect(relClose(res.state.stability, initialStability(5), 1e-9)).toBe(true)
  })
})

describe('core/schedule · 当天多次反馈只第一次改长期状态', () => {
  it('同日第二次评分：longTermUpdate=false，h/d/dueAt/phase 不变', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const first = scheduleNext(fresh, 'familiar', NOW)
    const second = scheduleNext(first.state, 'forgot', NOW + 3_600_000)

    expect(first.longTermUpdate).toBe(true)
    expect(second.longTermUpdate).toBe(false)
    expect(second.state.stability).toBe(first.state.stability)
    expect(second.state.difficulty).toBe(first.state.difficulty)
    expect(second.state.dueAt).toBe(first.state.dueAt)
    expect(second.state.phase).toBe(first.state.phase)
    expect(second.state.nextIntervalDays).toBe(first.state.nextIntervalDays)
    expect(second.state.sameDayCount).toBe(2)
    expect(second.state.sameDayRequeued).toBe(1)
    expect(second.state.lastRating).toBe('forgot')
    expect(second.log.longTermUpdate).toBe(false)
    // 官方 help30：同日再次反馈只影响“当天间隔几个词后再出现”，所以仍要回炉
    expect(second.requeue).toBe('requeue-forgot')
  })

  it('跨天后重新成为“当天第一次反馈”（sameDayCount 归 1、长期状态更新）', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const first = scheduleNext(fresh, 'familiar', NOW)
    const nextDay = startOfLocalDay(addDays(NOW, 1))
    const res = scheduleNext(first.state, 'familiar', nextDay)
    expect(res.longTermUpdate).toBe(true)
    expect(res.state.sameDayCount).toBe(1)
    expect(res.state.sameDayDate).toBe(localDateKey(nextDay))
    expect(res.state.stability).not.toBe(first.state.stability)
  })

  it('同日第三次反馈也只累计计数，不会重新结算', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const s1 = scheduleNext(fresh, 'familiar', NOW).state
    const s2 = scheduleNext(s1, 'familiar', NOW + 1_000_000).state
    const s3 = scheduleNext(s2, 'familiar', NOW + 2_000_000).state
    expect(s3.stability).toBe(s1.stability)
    expect(s3.sameDayCount).toBe(3)
  })
})

describe('core/schedule · 间隔/到期日边界', () => {
  it('intervalFromRetention 边界：min=1、max=365、取整规则 Math.round', () => {
    expect(intervalFromRetention(0.1, 0.9)).toBe(1)
    expect(intervalFromRetention(1.7637, 0.9)).toBe(1)
    expect(intervalFromRetention(10, 0.9)).toBe(2)
    expect(intervalFromRetention(1000, 0.9)).toBe(152)
    expect(intervalFromRetention(10_000, 0.9)).toBe(365)
    expect(intervalFromRetention(1000, 0.9, { intervalMax: 5 })).toBe(5)
    expect(intervalFromRetention(1000, 0.9, { intervalMin: 200 })).toBe(200)
  })

  it('dueAt = 本地日期 00:00（深夜学习不会次日不到期）', () => {
    const lateNight = localMidnight(2026, 11, 10) + 23 * 3_600_000 + 30 * 60_000
    const state = makeReviewed({ stability: 10, difficulty: 5, lastReviewedAt: NOW - 86_400_000 })
    const res = scheduleNext(state, 'familiar', lateNight)
    // 到期日 = 「学习日 + 新间隔」的本地 00:00（不是 now + n*86400000）
    const expectedDue = startOfLocalDay(addDays(lateNight, res.state.nextIntervalDays))
    expect(res.state.dueAt).toBe(expectedDue)
    expect(localDateKey(expectedDue)).toBe(localDateKey(addDays(lateNight, res.state.nextIntervalDays)))
    expect(new Date(expectedDue).getHours()).toBe(0)
    expect(isDue(res.state, expectedDue)).toBe(true)
    expect(isDue(res.state, expectedDue - 1)).toBe(false)
  })

  it('isDue/isNew/memoryDurabilityDays/retrievabilityNow 口径', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    expect(isNew(fresh)).toBe(true)
    expect(isDue(fresh, NOW)).toBe(false) // 新词不算“到期复习”

    const review = makeReviewed({ dueAt: NOW + 3_600_000 })
    expect(isNew(review)).toBe(false)
    expect(isDue(review, NOW)).toBe(false)
    expect(isDue(review, NOW + 3_600_000)).toBe(true)

    expect(memoryDurabilityDays(review)).toBe(review.nextIntervalDays)
    expect(retrievabilityNow(fresh, NOW)).toBe(1)
    expect(retrievabilityNow(review, NOW)).toBe(1)
    const later = retrievabilityNow(review, NOW + 10 * 86_400_000)
    expect(later).toBeLessThan(1)
    expect(later).toBeGreaterThan(0)
  })

  it('纯函数：不修改入参、不读时钟', () => {
    const prev = makeReviewed({ stability: 42, difficulty: 5 })
    const snapshot = JSON.stringify(prev)
    const res = scheduleNext(prev, 'familiar', NOW)
    expect(JSON.stringify(prev)).toBe(snapshot)
    expect(res.state).not.toBe(prev)
    // 同一输入两次调用结果一致（确定性）
    const res2 = scheduleNext(prev, 'familiar', NOW)
    expect(res2.state).toEqual(res.state)
  })

  it('createWordState：新词初始状态符合 §1.3 默认值', () => {
    const state = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    expect(state.phase).toBe('new')
    expect(state.difficulty).toBe(DEFAULT_PARAMS.d0)
    expect(relClose(state.stability, initialStability(5), 1e-9)).toBe(true)
    expect(state.nextIntervalDays).toBe(1)
    expect(state.retrievability).toBe(1)
    expect(state.firstSeenAt).toBeNull()
    expect(state.lastReviewedAt).toBeNull()
    expect(state.dueAt).toBeNull()
    expect(state.sameDayDate).toBe('')
    expect(state.meaningStats).toEqual({})
  })

  it('阶段转换跨日：第 2 天复习用 elapsedDays 计算 p（深夜/凌晨也不出错）', () => {
    const fresh = createWordState({ wordId: 'deck:a', deckId: 'deck', now: NOW })
    const first = scheduleNext(fresh, 'familiar', NOW)
    const midnight = startOfLocalDay(addDays(NOW, 1))
    const res = scheduleNext(first.state, 'familiar', midnight)
    // 14 小时 = 0.5833 天 → p = 2^(-0.5833/h0) ≈ 0.794
    const expectedP = Math.pow(2, -((midnight - NOW) / 86_400_000) / first.state.stability)
    expect(res.state.retrievability).toBeCloseTo(expectedP, 10)
    expect(relClose(res.log.elapsedDays, (midnight - NOW) / 86_400_000, 1e-12)).toBe(true)
    expect(res.longTermUpdate).toBe(true)
  })

  it('调度结果日志字段完整（stabilityBefore/After、difficultyBefore/After、longTermUpdate）', () => {
    const prev = makeReviewed({ stability: 20, difficulty: 5 })
    const res = scheduleNext(prev, 'familiar', day(3))
    expect(res.log.wordId).toBe(prev.wordId)
    expect(res.log.deckId).toBe(prev.deckId)
    expect(res.log.rating).toBe('familiar')
    expect(res.log.stabilityBefore).toBe(prev.stability)
    expect(res.log.stabilityAfter).toBe(res.state.stability)
    expect(res.log.difficultyBefore).toBe(prev.difficulty)
    expect(res.log.difficultyAfter).toBe(res.state.difficulty)
    expect(res.log.nextIntervalDays).toBe(res.state.nextIntervalDays)
    expect(res.log.longTermUpdate).toBe(true)
    expect(res.log.id).toBeUndefined()
  })
})
