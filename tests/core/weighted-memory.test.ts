import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WEIGHTED_MEMORY_SETTINGS,
  advanceWeighted,
  createSession,
  isMemoryComplete,
  isWeightedSameAsBase,
  memoryTotalForMeaning,
  normalizeWeightedMemorySettings,
  openMemory,
  remainingMemoryTaps,
  selectWeightedMemory,
  tapBoard,
  tapMemory,
  weightedMemoryTotals,
  weightedSettingsFromSettings,
  weightedTotal,
} from '../../src/core'
import type { SessionState, SessionWord } from '../../src/core'

const word: SessionWord = {
  wordId: 'w1',
  deckId: 'd1',
  headword: 'embrace',
  meanings: [
    { meaningId: 'm1', pos: 'n.', cn: '拥抱' },
    { meaningId: 'm2', pos: 'v.', cn: '包含' },
    { meaningId: 'm3', pos: 'v.', cn: '信奉' },
  ],
  phrases: [],
}

describe('core/weighted-memory · 加权次数公式', () => {
  it('默认配置：base=3, k=1, min=1, max=10 → f=0/.25/.5/.75/1', () => {
    expect(DEFAULT_WEIGHTED_MEMORY_SETTINGS).toEqual({ minRepeats: 1, maxRepeats: 10, strength: 1 })
    expect(weightedTotal(3, 0)).toBe(3)
    expect(weightedTotal(3, 0.25)).toBe(4) // round(3.75)
    expect(weightedTotal(3, 0.5)).toBe(5) // round(4.5) = 5
    expect(weightedTotal(3, 0.75)).toBe(5) // round(5.25) = 5
    expect(weightedTotal(3, 1)).toBe(6)
  })

  it('k=0 → 不加权（仍受 min/max 约束）', () => {
    expect(weightedTotal(3, 1, { strength: 0 })).toBe(3)
    expect(weightedTotal(1, 1, { strength: 0, minRepeats: 2 })).toBe(2)
    expect(weightedTotal(9, 0, { strength: 0, maxRepeats: 5 })).toBe(5)
  })

  it('f/null/NaN/越界均安全收敛', () => {
    expect(weightedTotal(3, null)).toBe(3)
    expect(weightedTotal(3, Number.NaN)).toBe(3)
    expect(weightedTotal(3, -1)).toBe(3)
    expect(weightedTotal(3, 2)).toBe(6) // clamp01 → 1
  })

  it('min/max 边界与 min=max', () => {
    expect(weightedTotal(10, 1, { minRepeats: 1, maxRepeats: 20 })).toBe(20)
    expect(weightedTotal(10, 0.5, { minRepeats: 5, maxRepeats: 5 })).toBe(5)
    expect(weightedTotal(3, 0, { minRepeats: 6 })).toBe(6) // 低于 min 抬到 min
    expect(weightedTotal(3, 1, { maxRepeats: 2 })).toBe(2) // 高于 max 压到 max
  })

  it('base 越界收敛到 1–10；k 越界收敛到 0–2', () => {
    expect(weightedTotal(0, 1)).toBe(2) // base→1, *(1+1)=2
    expect(weightedTotal(99, 0)).toBe(10) // base→10
    expect(weightedTotal(3, 1, { strength: 99 })).toBe(9) // k→2 → 3*3=9
    expect(weightedTotal(3, 1, { strength: -1 })).toBe(3) // k→0
  })

  it('配置规范化：min/max/k clamp，max<min 抬到 min，默认值', () => {
    expect(normalizeWeightedMemorySettings()).toEqual({ minRepeats: 1, maxRepeats: 10, strength: 1 })
    expect(
      normalizeWeightedMemorySettings({ minRepeats: 0, maxRepeats: 99, strength: 5 }),
    ).toEqual({ minRepeats: 1, maxRepeats: 20, strength: 2 })
    expect(normalizeWeightedMemorySettings({ minRepeats: 8, maxRepeats: 3 })).toEqual({
      minRepeats: 8,
      maxRepeats: 8,
      strength: 1,
    })
    expect(normalizeWeightedMemorySettings({ minRepeats: Number.NaN, strength: -3 })).toEqual({
      minRepeats: 1,
      maxRepeats: 10,
      strength: 0,
    })
  })

  it('selectWeightedMemory 与 weightedTotal 等价；isWeightedSameAsBase', () => {
    expect(selectWeightedMemory(3, 1)).toBe(6)
    expect(isWeightedSameAsBase(3, 0)).toBe(true)
    expect(isWeightedSameAsBase(3, 1)).toBe(false)
    expect(isWeightedSameAsBase(3, 1, { strength: 0 })).toBe(true)
  })

  it('weightedSettingsFromSettings：映射 SettingsMap 的三项设置', () => {
    expect(
      weightedSettingsFromSettings({ 'memory.weightedMin': 2, 'memory.weightedMax': 8, 'memory.weightedK': 0.5 }),
    ).toEqual({ minRepeats: 2, maxRepeats: 8, strength: 0.5 })
    expect(weightedSettingsFromSettings(undefined)).toEqual(DEFAULT_WEIGHTED_MEMORY_SETTINGS)
  })

  it('weightedMemoryTotals：按 meaningId 批量计算', () => {
    const totals = weightedMemoryTotals(3, { m1: 0, m2: 0.5, m3: 1 })
    expect(totals).toEqual({ m1: 3, m2: 5, m3: 6 })
  })
})

describe('core/session · 加权记忆（per-c total，不破坏普通记忆）', () => {
  function stateWithWeighted(weightedTotals?: Record<string, number>): SessionState {
    return createSession({
      word,
      settings: { totalRepeats: 3, mode: 'sequential', showPhrases: true, exampleCount: 2, showPhonetic: true },
      ...(weightedTotals ? { weightedTotals } : {}),
    })
  }

  it('普通记忆：未传 weightedTotals 时全部 c = totalRepeats', () => {
    const state = stateWithWeighted()
    expect(memoryTotalForMeaning(state, 'm1')).toBe(3)
    expect(memoryTotalForMeaning(state, 'm2')).toBe(3)
    expect(remainingMemoryTaps(state)).toBe(9)
    expect(isMemoryComplete(state)).toBe(false)
  })

  it('加权记忆：per-c 次数不同；点满后推进；全部完成判定按各自 total', () => {
    let state = stateWithWeighted({ m1: 5, m2: 2, m3: 1 })
    expect(remainingMemoryTaps(state)).toBe(8)
    state = tapBoard(state)
    state = openMemory(state)
    expect(state.activeMeaningId).toBe('m1')
    for (let i = 0; i < 5; i += 1) state = tapMemory(state)
    expect(state.needsAdvance).toBe(true)
    state = advanceWeighted(state)
    expect(state.activeMeaningId).toBe('m2')
    state = tapMemory(state)
    state = tapMemory(state)
    expect(state.needsAdvance).toBe(true)
    state = advanceWeighted(state)
    expect(state.activeMeaningId).toBe('m3')
    state = tapMemory(state)
    expect(state.needsAdvance).toBe(true)
    state = advanceWeighted(state)
    expect(state.stage).toBe('annotation')
    expect(state.wcCompletedOnce).toBe(true)
    expect(isMemoryComplete(state)).toBe(true)
    expect(remainingMemoryTaps(state)).toBe(0)
  })

  it('createSession 的 savedCounts 按各 c total 截断；非法 weightedTotals 安全收敛', () => {
    const state = createSession({
      word,
      settings: { totalRepeats: 3, mode: 'sequential', showPhrases: true, exampleCount: 2, showPhonetic: true },
      weightedTotals: { m1: 5, m2: 2, m3: 99 },
      savedCounts: { m1: 9, m2: 9, m3: 99 },
    })
    expect(state.wcCounts).toEqual({ m1: 5, m2: 2, m3: 20 })
    expect(memoryTotalForMeaning(state, 'm3')).toBe(20)
  })
})
