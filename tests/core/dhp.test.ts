import { describe, expect, it } from 'vitest'
import {
  initialStability,
  retrievability,
  stabilityAfterForget,
  stabilityAfterRecall,
} from '../../src/core'
import { clamp } from '../../src/core'

/** 独立复算公式（与实现分开写，防止“抄自己”） */
function expectClose(actual: number, expected: number, relTol = 0.01): void {
  const ok = Math.abs(actual - expected) <= Math.abs(expected) * relTol
  expect(ok, `expected ${actual} ≈ ${expected} (±${relTol * 100}%)`).toBe(true)
}

describe('core/dhp · DHP 公式（SPEC §3.3）', () => {
  it('retrievability：p = 2^(-Δt/h)', () => {
    expect(retrievability(10, 0)).toBe(1)
    expect(retrievability(10, 10)).toBeCloseTo(0.5, 10)
    expect(retrievability(10, 20)).toBeCloseTo(0.25, 10)
    expect(retrievability(10, 5)).toBeCloseTo(Math.SQRT1_2, 10)
  })

  it('retrievability：负数 Δt 视为 0，非法 h 返回 0', () => {
    expect(retrievability(10, -5)).toBe(1)
    expect(retrievability(0, 5)).toBe(0)
    expect(retrievability(-1, 5)).toBe(0)
    expect(retrievability(Number.NaN, 5)).toBe(0)
  })

  it('initialStability：d=5 → 1.7637 天（公式 5 的精确值）', () => {
    // p0 = 0.925 - 0.05*5 = 0.675 → h0 = -1/log2(0.675)
    expectClose(initialStability(5), -1 / Math.log2(0.675), 1e-9)
    expectClose(initialStability(5), 1.7637, 0.001)
  })

  it('initialStability：难度越大初始半衰期越短（d=1 → 5.19，d=10 → 0.81）', () => {
    expectClose(initialStability(1), 5.19, 0.01)
    expectClose(initialStability(10), 0.81, 0.01)
    expect(initialStability(1)).toBeGreaterThan(initialStability(5))
    expect(initialStability(5)).toBeGreaterThan(initialStability(10))
  })

  it('stabilityAfterRecall：官方公式 2 逐项复算', () => {
    const d = 5
    const h = 1.7637
    const p = 0.675
    const expected =
      h *
      (1 +
        Math.exp(3.81) *
          Math.pow(d, -0.534) *
          Math.pow(h, -0.127) *
          Math.pow(1 - p, 0.97))
    expectClose(stabilityAfterRecall(d, h, p), expected, 1e-9)
    // 答对一定不降低半衰期
    expect(stabilityAfterRecall(d, h, p)).toBeGreaterThan(h)
  })

  it('stabilityAfterRecall：p=1 时增益为 0（新词不放大）', () => {
    expectClose(stabilityAfterRecall(5, 1.7637, 1), 1.7637, 1e-9)
  })

  it('stabilityAfterForget：官方公式 3（重新赋值，不是乘）', () => {
    const d = 5
    const h = 161.01
    const p = 0.903
    const expected =
      Math.exp(-0.041) * Math.pow(d, -0.041) * Math.pow(h, 0.377) * Math.pow(1 - p, -0.227)
    expectClose(stabilityAfterForget(d, h, p), expected, 1e-9)
    // 忘记一定把半衰期打下来
    expect(stabilityAfterForget(d, h, p)).toBeLessThan(h)
    // 与 SPEC 忘记基准一致（第 5 次序忘记：h Before=75.10 → h 7.78）
    expectClose(stabilityAfterForget(5, 75.1, 0.90337), 7.78, 0.01)
  })

  it('stabilityAfterForget：p→1（fi→0）不产生 Infinity/NaN（有 1e-4 下限保护）', () => {
    const h = stabilityAfterForget(5, 1.7637, 1)
    expect(Number.isFinite(h)).toBe(true)
    expect(h).toBeGreaterThan(0)
    const h2 = stabilityAfterForget(5, 1.7637, 0.999999)
    expect(Number.isFinite(h2)).toBe(true)
  })

  it('公式对异常输入有防御（d/h 越界 clamp、NaN 不扩散）', () => {
    expect(Number.isFinite(stabilityAfterRecall(999, 1e9, -1))).toBe(true)
    expect(Number.isFinite(stabilityAfterForget(-5, 0.0001, 2))).toBe(true)
    expect(Number.isFinite(initialStability(Number.NaN, { dMin: 1, dInitialMax: 10 }))).toBe(true)
    expect(clamp(Number.NaN, 1, 10)).toBe(1)
  })
})
