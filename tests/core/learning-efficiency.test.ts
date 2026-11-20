import { describe, expect, it } from 'vitest'
import {
  accumulateActiveStudyMs,
  activeStudyMs,
  averageSecondsPerWord,
  computeLearningEfficiency,
  estimateRemainingStudySeconds,
  secondsToMinutes,
} from '../../src/core'

describe('core/learning-efficiency · 活跃时长', () => {
  it('activeStudyMs：正常区间/负数/非法值', () => {
    expect(activeStudyMs(1000, 4000)).toBe(3000)
    expect(activeStudyMs(4000, 1000)).toBe(0)
    expect(activeStudyMs(Number.NaN, 1000)).toBe(0)
    expect(activeStudyMs(0, Number.NaN)).toBe(0)
  })

  it('accumulateActiveStudyMs：累计并容错旧值', () => {
    expect(accumulateActiveStudyMs(10_000, 0, 5_000)).toBe(15_000)
    expect(accumulateActiveStudyMs(Number.NaN, 0, 5000)).toBe(5000)
    expect(accumulateActiveStudyMs(-100, 0, 5000)).toBe(5000)
  })
})

describe('core/learning-efficiency · 平均每词 / 预计剩余', () => {
  it('0 词 → 平均 null（UI 显示 —）', () => {
    expect(averageSecondsPerWord(120_000, 0)).toBeNull()
    expect(averageSecondsPerWord(120_000, -1)).toBeNull()
    expect(averageSecondsPerWord(120_000, Number.NaN)).toBeNull()
  })

  it('平均 = 活跃时长 / 已学词数（秒/词）', () => {
    expect(averageSecondsPerWord(120_000, 10)).toBe(12)
    expect(averageSecondsPerWord(60_000, 4)).toBe(15)
    expect(averageSecondsPerWord(Number.NaN, 10)).toBe(0)
    expect(averageSecondsPerWord(-5000, 10)).toBe(0)
  })

  it('预计剩余 = 平均 × 剩余词数；0 剩余 → 0≈；无数据 → null', () => {
    expect(estimateRemainingStudySeconds(120_000, 10, 20)).toBe(240) // 12s ×20
    expect(estimateRemainingStudySeconds(120_000, 10, 0)).toBe(0)
    expect(estimateRemainingStudySeconds(120_000, 0, 10)).toBeNull()
    expect(estimateRemainingStudySeconds(120_000, 10, -5)).toBe(0)
  })

  it('computeLearningEfficiency 组合', () => {
    expect(computeLearningEfficiency({ activeStudyMs: 300_000, learnedWords: 25, remainingWords: 50 })).toEqual({
      averageSecondsPerWord: 12,
      estimatedRemainingSeconds: 600,
    })
    expect(computeLearningEfficiency({ activeStudyMs: 0, learnedWords: 0, remainingWords: 10 })).toEqual({
      averageSecondsPerWord: null,
      estimatedRemainingSeconds: null,
    })
    expect(computeLearningEfficiency({ activeStudyMs: 300_000, learnedWords: 25, remainingWords: 0 })).toEqual({
      averageSecondsPerWord: 12,
      estimatedRemainingSeconds: 0,
    })
  })

  it('secondsToMinutes：安全转换', () => {
    expect(secondsToMinutes(600)).toBe(10)
    expect(secondsToMinutes(0)).toBe(0)
    expect(secondsToMinutes(null)).toBeNull()
    expect(secondsToMinutes(Number.NaN)).toBeNull()
    expect(secondsToMinutes(-60)).toBe(0)
  })
})
