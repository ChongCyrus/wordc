import { describe, expect, it } from 'vitest'
import { createWordState, localDateKey, predictAll, scheduleNext } from '../../src/core'
import {
  buildNextHints,
  buildOfficialHints,
  formatDaysLater,
  formatOfficialHint,
} from '../../src/ui/study/lib/next-hint'

describe('core 数值快照（K=80 首评；回炉 20pp 显式 v1-20pp）', () => {
  const NOW = new Date(2026, 10, 11, 10, 0, 0).getTime()
  const newWordState = (difficulty: number) =>
    createWordState({ wordId: 'w', deckId: 'd', difficulty, now: NOW })

  it('新词首评（按难度 d）：认识/不确定/不认识逐值对齐官方', () => {
    const cases: Array<{ d: number; familiar: string; vague: string; forgot: string }> = [
      // 首评常数解耦：认识 K_f=80、模糊 K_v=100（官方实机区间内逼近）
      { d: 1, familiar: '63 天后', vague: '今日 / 3 天后', forgot: '今日 / 1 天后' },
      { d: 2, familiar: '44 天后', vague: '今日 / 2 天后', forgot: '今日 / 1 天后' },
      { d: 3, familiar: '33 天后', vague: '今日 / 2 天后', forgot: '今日 / 1 天后' },
      { d: 5, familiar: '21 天后', vague: '今日 / 2 天后', forgot: '今日 / 1 天后' },
      { d: 10, familiar: '10 天后', vague: '今日 / 1 天后', forgot: '今日 / 1 天后' },
    ]
    for (const item of cases) {
      const p = predictAll(newWordState(item.d), NOW)
      expect(formatOfficialHint(p.familiar)).toBe(item.familiar)
      expect(formatOfficialHint(p.vague)).toBe(item.vague)
      expect(formatOfficialHint(p.forgot)).toBe(item.forgot)
    }
  })

  // 注：core 默认已切 progressModelMode='v2-levels'，20pp 保留做 A/B/回滚；
  // 下面 3 条是 v1-20pp 回归（显式传参），v2 默认档位期望等最终转移表后再补。
  it('回炉进度投影（v1-20pp）：P=20% → 今日进度 60/40/20%', () => {
    const state = {
      ...newWordState(5),
      phase: 'review' as const,
      firstSeenAt: NOW - 86_400_000,
      lastReviewedAt: NOW,
      lastRating: 'familiar' as const,
      todayProgress: 0.2,
      todayProgressDate: localDateKey(NOW),
      nextIntervalDays: 5,
    }
    const p = predictAll(state, NOW, { progressModelMode: 'v1-20pp' })
    expect(formatOfficialHint(p.familiar)).toBe('今日进度60%')
    expect(formatOfficialHint(p.vague)).toBe('今日进度40%')
    expect(formatOfficialHint(p.forgot)).toBe('今日进度20%')
  })

  // ===== core 默认 v2-levels（5 档状态机，Lead 2026-11-11 拍板）=====
  it('v2 五档表：level 1..5 的三键文案（F/V/W）', () => {
    const base = {
      ...createWordState({ wordId: 'w', deckId: 'd', difficulty: 5, now: NOW - 86_400_000 }),
      phase: 'review' as const,
      firstSeenAt: NOW - 86_400_000,
      lastReviewedAt: NOW,
      lastRating: 'vague' as const,
      todayProgressDate: localDateKey(NOW),
      nextIntervalDays: 5,
    }
    const expected: Array<{ level: number; familiar: string; vague: string; forgot: string }> = [
      { level: 1, familiar: '今日进度80%', vague: '今日进度60%', forgot: '今日进度20%' }, // L1a
      { level: 2, familiar: '今日进度60%', vague: '今日进度40%', forgot: '今日进度20%' }, // L1b
      { level: 3, familiar: '5 天后', vague: '今日进度60%', forgot: '今日进度40%' }, // L2
      { level: 4, familiar: '5 天后', vague: '今日进度80%', forgot: '今日进度60%' }, // L3
      { level: 5, familiar: '5 天后', vague: '今日进度80%', forgot: '今日进度80%' }, // L4
    ]
    for (const item of expected) {
      const predicts = predictAll({ ...base, todayProgressLevel: item.level }, NOW)
      expect(formatOfficialHint(predicts.familiar)).toBe(item.familiar)
      expect(formatOfficialHint(predicts.vague)).toBe(item.vague)
      expect(formatOfficialHint(predicts.forgot)).toBe(item.forgot)
    }
  })

  it('v2 真机序列 face：首评不认识 → 认识 → 认识（完成）', () => {
    const DAY = 86_400_000
    const first = scheduleNext(
      createWordState({ wordId: 'face', deckId: 'd', difficulty: 5, now: NOW - DAY }),
      'forgot',
      NOW,
    ).state
    const hint = (state: typeof first) => {
      const p = predictAll(state, NOW)
      return [formatOfficialHint(p.familiar), formatOfficialHint(p.vague), formatOfficialHint(p.forgot)]
    }
    expect(hint(first)).toEqual(['今日进度60%', '今日进度40%', '今日进度20%'])
    const afterFamiliar = scheduleNext(first, 'familiar', NOW)
    expect(hint(afterFamiliar.state)).toEqual([
      `${afterFamiliar.state.nextIntervalDays} 天后`,
      '今日进度60%',
      '今日进度40%',
    ])
    const done = scheduleNext(afterFamiliar.state, 'familiar', NOW)
    expect(done.completesToday).toBe(true)
  })

  it('v2 真机序列 cat：首评不确定 → 模糊×3 → 忘记×2 → 认识×2（完成）', () => {
    const DAY = 86_400_000
    let state = scheduleNext(
      createWordState({ wordId: 'cat', deckId: 'd', difficulty: 5, now: NOW - DAY }),
      'vague',
      NOW,
    ).state
    const hint = () => {
      const p = predictAll(state, NOW)
      return [formatOfficialHint(p.familiar), formatOfficialHint(p.vague), formatOfficialHint(p.forgot)]
    }
    expect(hint()).toEqual(['今日进度80%', '今日进度60%', '今日进度20%'])
    state = scheduleNext(state, 'vague', NOW).state
    expect(hint()).toEqual([
      `${state.nextIntervalDays} 天后`,
      '今日进度60%',
      '今日进度40%',
    ])
    state = scheduleNext(state, 'vague', NOW).state
    expect(hint()).toEqual([`${state.nextIntervalDays} 天后`, '今日进度80%', '今日进度60%'])
    state = scheduleNext(state, 'vague', NOW).state
    expect(hint()).toEqual([`${state.nextIntervalDays} 天后`, '今日进度80%', '今日进度60%'])
    state = scheduleNext(state, 'forgot', NOW).state
    expect(hint()).toEqual([`${state.nextIntervalDays} 天后`, '今日进度60%', '今日进度40%'])
    state = scheduleNext(state, 'forgot', NOW).state
    expect(hint()).toEqual(['今日进度80%', '今日进度60%', '今日进度20%'])
    state = scheduleNext(state, 'familiar', NOW).state
    expect(hint()).toEqual([`${state.nextIntervalDays} 天后`, '今日进度80%', '今日进度60%'])
    const done = scheduleNext(state, 'familiar', NOW)
    expect(done.completesToday).toBe(true)
  })

  it('v2 真机序列 yellow：首评不确定 → 模糊×3 → 忘记 → 认识（完成）', () => {
    const DAY = 86_400_000
    let state = scheduleNext(
      createWordState({ wordId: 'yellow', deckId: 'd', difficulty: 5, now: NOW - DAY }),
      'vague',
      NOW,
    ).state
    const hint = () => {
      const p = predictAll(state, NOW)
      return [formatOfficialHint(p.familiar), formatOfficialHint(p.vague), formatOfficialHint(p.forgot)]
    }
    expect(hint()).toEqual(['今日进度80%', '今日进度60%', '今日进度20%'])
    state = scheduleNext(state, 'vague', NOW).state
    expect(hint()).toEqual([`${state.nextIntervalDays} 天后`, '今日进度60%', '今日进度40%'])
    state = scheduleNext(state, 'vague', NOW).state
    expect(hint()).toEqual([`${state.nextIntervalDays} 天后`, '今日进度80%', '今日进度60%'])
    state = scheduleNext(state, 'vague', NOW).state
    expect(hint()).toEqual([`${state.nextIntervalDays} 天后`, '今日进度80%', '今日进度60%'])
    state = scheduleNext(state, 'forgot', NOW).state
    expect(hint()).toEqual([`${state.nextIntervalDays} 天后`, '今日进度60%', '今日进度40%'])
    const done = scheduleNext(state, 'familiar', NOW)
    expect(done.completesToday).toBe(true)
  })

  it('回炉进度投影（v1-20pp）：P=40% → 80/60/40%；P=80% → 认识完成、模糊/忘记封顶 80%', () => {
    const base = {
      ...newWordState(5),
      phase: 'review' as const,
      firstSeenAt: NOW - 86_400_000,
      lastReviewedAt: NOW,
      lastRating: 'familiar' as const,
      todayProgressDate: localDateKey(NOW),
      nextIntervalDays: 5,
    }
    const p40 = predictAll({ ...base, todayProgress: 0.4 }, NOW, {
      progressModelMode: 'v1-20pp',
    })
    expect(formatOfficialHint(p40.familiar)).toBe('今日进度80%')
    expect(formatOfficialHint(p40.vague)).toBe('今日进度60%')
    expect(formatOfficialHint(p40.forgot)).toBe('今日进度40%')

    const p80 = predictAll({ ...base, todayProgress: 0.8, nextIntervalDays: 1 }, NOW, {
      progressModelMode: 'v1-20pp',
    })
    expect(formatOfficialHint(p80.familiar)).toBe('1 天后') // 认识完成当日
    expect(formatOfficialHint(p80.vague)).toBe('今日进度80%')
    expect(formatOfficialHint(p80.forgot)).toBe('今日进度80%')
  })
})

describe('三键「下次出现」文案（官方 task-26 格式化）', () => {
  it('progress>=1 → 「N 天后」', () => {
    expect(formatOfficialHint({ first: false, days: 80, progress: 1 })).toBe('80 天后')
    expect(formatOfficialHint({ first: true, days: 60, progress: 1 })).toBe('60 天后')
    expect(formatOfficialHint({ first: false, days: 40, progress: 1.2 })).toBe('40 天后')
  })

  it('first → 「今日 / N 天后」', () => {
    expect(formatOfficialHint({ first: true, days: 20, progress: 0 })).toBe('今日 / 20 天后')
    expect(formatOfficialHint({ first: true, days: 20, progress: 0.6 })).toBe('今日 / 20 天后')
  })

  it('非首次且 progress<1 → 「今日进度N%」', () => {
    expect(formatOfficialHint({ first: false, days: 10, progress: 0.6 })).toBe('今日进度60%')
    expect(formatOfficialHint({ first: false, days: 10, progress: 0.4 })).toBe('今日进度40%')
    expect(formatOfficialHint({ first: false, days: 10, progress: 0.2 })).toBe('今日进度20%')
  })

  it('隐藏预计复习间隔：first → 今日；否则 → 今日进度N%', () => {
    expect(formatOfficialHint({ first: true, days: 20, progress: 0 }, false)).toBe('今日')
    expect(formatOfficialHint({ first: false, days: 20, progress: 0.6 }, false)).toBe('今日进度60%')
  })

  it('三个按钮各自独立格式化', () => {
    const hints = buildOfficialHints(
      {
        familiar: { first: false, days: 80, progress: 1 },
        vague: { first: false, days: 60, progress: 0.4 },
        forgot: { first: false, days: 40, progress: 0.2 },
      },
      true,
    )
    expect(hints).toEqual({
      familiar: '80 天后',
      vague: '今日进度40%',
      forgot: '今日进度20%',
    })
    const hidden = buildOfficialHints(
      {
        familiar: { first: true, days: 80, progress: 0 },
        vague: { first: false, days: 60, progress: 0.6 },
        forgot: { first: false, days: 40, progress: 0.2 },
      },
      false,
    )
    expect(hidden).toEqual({ familiar: '今日', vague: '今日进度60%', forgot: '今日进度20%' })
  })


  it('认识 N 天后 / 模糊 今日 · N 天后 / 不认识 今日 · 明天', () => {
    expect(buildNextHints({ familiarDays: 78, vagueDays: 3, vagueRequeue: true })).toEqual({
      familiar: '78 天后',
      vague: '今日 · 3 天后',
      forgot: '今日 · 明天',
    })
  })

  it('间隔为 1 天仍显示「1 天后」；非法值兜底为 1 天后', () => {
    expect(formatDaysLater(1)).toBe('1 天后')
    expect(formatDaysLater(0)).toBe('1 天后')
    expect(formatDaysLater(-3)).toBe('1 天后')
    expect(formatDaysLater(Number.NaN)).toBe('1 天后')
    expect(formatDaysLater(2.4)).toBe('2 天后')
  })

  it('不认识固定文案不随预览变化', () => {
    expect(buildNextHints({ familiarDays: 365, vagueDays: 1 }).forgot).toBe('今日 · 明天')
  })

  it('模糊不回炉时只显示 N 天后（core 预览 todayRequeue=false 的降级）', () => {
    expect(buildNextHints({ familiarDays: 2, vagueDays: 3, vagueRequeue: false }).vague).toBe(
      '3 天后',
    )
  })
})
