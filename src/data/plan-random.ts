/**
 * 新词顺序随机化的稳定种子（task-47）。
 *
 * 需求：设置 `study.newWordOrder='random'` 时，新词顺序要**可复现**——
 * 同一天同一词库（planId = `${date}:${deckId}`）退出重进、改学习量（30→50）后：
 * - 前 30 个顺序不变；
 * - 追加的 20 个是同一「随机序列」的延续（前缀稳定）。
 *
 * 实现：不用 Fisher-Yates（候选集合变化会改变序列），而是给每个词算一个**稳定排序键**
 * `hash(planId, wordId)`，按 key 升序取；候选集合增删只会「跳过/补上」词，不改变其余词相对顺序。
 * 同时提供 mulberry32 PRNG（seed=hash(planId)）供需要序列的调用方（如 study.repo 旧队列路径）使用。
 */

import { fnv1a32 } from '../core'

export type NewWordOrder = 'order' | 'random'

/** mulberry32：32 位种子 PRNG（返回 [0,1)，确定性） */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** plan 稳定种子（planId = `${本地日期}:${deckId}`） */
export function planSeed(planId: string): number {
  return fnv1a32(`new-word-order:${planId}`)
}

/** 由 planId 派生的确定性 PRNG（同 planId 永远相同序列） */
export function seededRandomFromPlan(planId: string): () => number {
  return mulberry32(planSeed(planId))
}

/** 每个词的稳定随机排序键（同 planId + wordId 永远相同） */
export function newWordOrderKey(planId: string, wordId: string): number {
  return fnv1a32(`${planId}#${wordId}`)
}

/** 规范化设置值（仅允许 order/random；其余回退默认 random —— 用户拍板 task-47/D48） */
export function normalizeNewWordOrder(value: unknown): NewWordOrder {
  return value === 'order' ? 'order' : 'random'
}
