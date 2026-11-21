/**
 * DHP 记忆模型公式（SPEC §3.3，逐字实现；系数来自 KDD'22 官方代码，禁止改）。
 *
 * 记号：
 *   h = memory stability（记忆半衰期，天；回忆概率从 1 降到 0.5 所需天数）
 *   d = word difficulty（难度，1–18）
 *   p = retrievability（回忆概率，0–1）= 2^(-Δt/h)
 *
 * 公式 2（答对，r=1）：h' = h * (1 + e^3.81 · d^-0.534 · h^-0.127 · (1-p)^0.970)
 * 公式 3（答错，r=0）：h' = e^-0.041 · d^-0.041 · h^0.377 · (1-p)^-0.227   ← 注意是重新赋值，不是乘
 * 公式 5（初始半衰期）：h0 = -1 / log2(max(0.925 - 0.05·d, 0.025))
 */

import { clamp, clamp01, resolveParams } from './params'
import type { AlgoParams } from './params'

/** 回忆概率 p = 2^(-Δt/h)，Δt 单位天（可为小数）；h 非法/≤0 时返回 0 */
export function retrievability(h: number, elapsedDays: number): number {
  if (!Number.isFinite(h) || h <= 0) return 0
  const p = Math.pow(2, -Math.max(0, elapsedDays) / h)
  return clamp01(p)
}

/** 初始半衰期（公式 5）。d0=5 → -1/log2(0.675) ≈ 1.7637 天 */
export function initialStability(
  difficulty: number,
  params?: Partial<AlgoParams>,
): number {
  const p = resolveParams(params)
  const d = clamp(difficulty, p.dMin, p.dInitialMax)
  const p0 = Math.max(p.startPBase - p.startPStep * d, p.startPFloor)
  return -1 / Math.log2(p0)
}

/** 答对后 h'（公式 2，r=1） */
export function stabilityAfterRecall(
  difficulty: number,
  h: number,
  p: number,
  params?: Partial<AlgoParams>,
): number {
  const q = resolveParams(params)
  const d = clamp(difficulty, q.dMin, q.dMax)
  const hh = Math.max(h, q.stabilityMin)
  const pp = clamp01(p)
  const gain =
    Math.exp(q.recallExp) *
    Math.pow(d, q.recallDExp) *
    Math.pow(hh, q.recallHExp) *
    Math.pow(1 - pp, q.recallFiExp)
  return hh * (1 + gain)
}

/** 答错后 h'（公式 3，r=0；重新赋值，不是乘系数） */
export function stabilityAfterForget(
  difficulty: number,
  h: number,
  p: number,
  params?: Partial<AlgoParams>,
): number {
  const q = resolveParams(params)
  const d = clamp(difficulty, q.dMin, q.dMax)
  const hh = Math.max(h, q.stabilityMin)
  const fi = Math.max(1e-4, 1 - clamp01(p)) // 防 0^负数
  return (
    Math.exp(q.forgetExp) *
    Math.pow(d, q.forgetDExp) *
    Math.pow(hh, q.forgetHExp) *
    Math.pow(fi, q.forgetFiExp)
  )
}
