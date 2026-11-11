/** tests/core 共用工具：构造确定性 WordState / 时间 / 随机源（不依赖任何浏览器环境）。 */
import { createWordState } from '../../src/core'
import type { Rating, WordState } from '../../src/core'

/** 2026-11-10 10:00 本地时间 **/
export const NOW = new Date(2026, 10, 10, 10, 0, 0, 0).getTime()
export const HOUR = 3_600_000
export const DAY = 86_400_000

/** 本地 2026-11-10 10:00 + n 天（同一钟点，保证 elapsedDays 精确 = n） */
export function day(n: number): number {
  return new Date(2026, 10, 10 + n, 10, 0, 0, 0).getTime()
}

/** 本地某天 00:00 */
export function localMidnight(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
}

interface MakeStateOverrides extends Partial<WordState> {
  wordId?: string
  deckId?: string
}

/** 造一个可调状态的词（默认：已学过的 review 状态，便于测到期/排序） */
export function makeState(overrides: MakeStateOverrides = {}): WordState {
  const base = createWordState({
    wordId: overrides.wordId ?? 'deck:a',
    deckId: overrides.deckId ?? 'deck',
    now: NOW,
  })
  return { ...base, ...overrides }
}

/** 造一个「刚复习过、phase=review」的状态 */
export function makeReviewed(overrides: MakeStateOverrides = {}): WordState {
  return makeState({
    phase: 'review',
    lastReviewedAt: NOW,
    firstSeenAt: NOW,
    dueAt: NOW,
    nextIntervalDays: 1,
    reps: 1,
    ...overrides,
  })
}

/** mulberry32：确定性伪随机（0..1），单测随机模式用 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 依次返回给定值的随机源（用完后循环） */
export function seqRandom(values: number[]): () => number {
  let i = 0
  return () => {
    const v = values[i % values.length] ?? 0
    i += 1
    return v
  }
}

export const RATINGS: Rating[] = ['familiar', 'vague', 'forgot']
