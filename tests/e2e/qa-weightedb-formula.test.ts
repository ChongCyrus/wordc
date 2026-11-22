import { describe, expect, it } from 'vitest'
import { weightedTotal } from '../../src/core/weighted-memory'

const settings = { minRepeats: 1, maxRepeats: 10, strength: 1 }
describe('0.3.78 B 公式', () => {
  it('默认 3/1/10/1：f=0→1, f=.5→3, f=1→10', () => {
    expect(weightedTotal(3, 0, settings)).toBe(1)
    expect(weightedTotal(3, 0.5, settings)).toBe(3)
    expect(weightedTotal(3, 1, settings)).toBe(10)
  })
  it('k=0 → base', () => {
    expect(weightedTotal(3, 0, { ...settings, strength: 0 })).toBe(3)
    expect(weightedTotal(3, 1, { ...settings, strength: 0 })).toBe(3)
  })
})
