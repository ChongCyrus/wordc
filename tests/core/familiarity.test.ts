import { describe, expect, it } from 'vitest'
import {
  applyMeaningClick,
  applyMeaningEncounter,
  applyMeaningEncounters,
  emptyMeaningStat,
  familiarity,
  familiarityOfMeaning,
  normalizeMeaningStat,
} from '../../src/core'
import type { MeaningStat } from '../../src/core'

describe('core/familiarity · 不熟悉度公式（AC2）', () => {
  it('0/0 → null（UI 展示 —）', () => {
    expect(familiarity(0, 0)).toBeNull()
    expect(familiarity(0, -1)).toBeNull()
  })

  it('1/3 ≈ 0.3333', () => {
    expect(familiarity(1, 3)).toBeCloseTo(1 / 3, 10)
  })

  it('clamp01：7/5 → 1（原始 clicks 保留，不清零）', () => {
    expect(familiarity(7, 5)).toBe(1)
    const stat: MeaningStat = { clicks: 7, encounters: 5 }
    expect(normalizeMeaningStat(stat)).toEqual({ clicks: 7, encounters: 5 })
    expect(familiarity(stat.clicks, stat.encounters)).toBe(1)
  })

  it('边界：全点击（clicks=encounters）→ 1；clicks>encounters 仍 1', () => {
    expect(familiarity(5, 5)).toBe(1)
    expect(familiarity(6, 5)).toBe(1)
  })

  it('非法输入兜底：NaN/负数 → 0 或 null，不产生 NaN', () => {
    expect(familiarity(Number.NaN, 3)).toBe(0)
    expect(familiarity(-1, 3)).toBe(0)
    expect(familiarity(1, Number.NaN)).toBeNull()
  })
})

describe('core/familiarity · 计数更新（纯函数，不改入参）', () => {
  it('emptyMeaningStat = {clicks:0, encounters:0}', () => {
    expect(emptyMeaningStat()).toEqual({ clicks: 0, encounters: 0 })
  })

  it('applyMeaningClick：clicks+1、encounters 不变，且不改入参', () => {
    const stat: MeaningStat = { clicks: 1, encounters: 3 }
    const next = applyMeaningClick(stat)
    expect(next).toEqual({ clicks: 2, encounters: 3 })
    expect(stat).toEqual({ clicks: 1, encounters: 3 })
    expect(applyMeaningClick(undefined)).toEqual({ clicks: 1, encounters: 0 })
  })

  it('applyMeaningEncounter：encounters+1、clicks 不变，且不改入参', () => {
    const stat: MeaningStat = { clicks: 2, encounters: 0 }
    const next = applyMeaningEncounter(stat)
    expect(next).toEqual({ clicks: 2, encounters: 1 })
    expect(stat).toEqual({ clicks: 2, encounters: 0 })
    expect(applyMeaningEncounter(undefined)).toEqual({ clicks: 0, encounters: 1 })
  })

  it('applyMeaningEncounters：进入注释面时该词全部含义 encounters+1（整词同步，D40）', () => {
    const stats = { 'w#M1': { clicks: 2, encounters: 1 } }
    const next = applyMeaningEncounters(stats, ['w#M1', 'w#M2', 'w#M3'])
    expect(next['w#M1']).toEqual({ clicks: 2, encounters: 2 })
    expect(next['w#M2']).toEqual({ clicks: 0, encounters: 1 })
    expect(next['w#M3']).toEqual({ clicks: 0, encounters: 1 })
    // 不修改入参
    expect(stats).toEqual({ 'w#M1': { clicks: 2, encounters: 1 } })
  })

  it('连续「遇到」→「点击」：f 从 0 升到 1/2', () => {
    let stats: Record<string, MeaningStat> = {}
    stats = applyMeaningEncounters(stats, ['w#M1', 'w#M1'])
    expect(familiarityOfMeaning(stats, 'w#M1')).toBe(0)
    stats = { ...stats, 'w#M1': applyMeaningClick(stats['w#M1']) }
    expect(familiarityOfMeaning(stats, 'w#M1')).toBeCloseTo(0.5, 10)
    stats = applyMeaningEncounters(stats, ['w#M1'])
    expect(familiarityOfMeaning(stats, 'w#M1')).toBeCloseTo(1 / 3, 10)
  })

  it('familiarityOfMeaning：缺失 key → null（展示 —）', () => {
    expect(familiarityOfMeaning(undefined, 'w#M1')).toBeNull()
    expect(familiarityOfMeaning({}, 'w#M1')).toBeNull()
    expect(familiarityOfMeaning({ 'w#M1': { clicks: 0, encounters: 0 } }, 'w#M1')).toBeNull()
  })
})
