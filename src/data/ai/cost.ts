/**
 * 成本估算（task-70）—— 纯函数，供 generate 的预算上限使用。
 *
 * 价格是**实现时的官网假设**（元/百万 token），集中在此便于校准：
 * deepseek-chat 输入 ¥2 / 输出 ¥8；reasoner 约 2×（按 4/16 估算）。
 * 真实计费以 provider 账单为准；这里的估算只用于「单次 ¥3 上限」保护。
 */

import type { GenerationKind, SingleContentKind, TokenUsage } from './types'

export interface ModelPrice {
  /** 输入（元 / 百万 token） */
  input: number
  /** 输出（元 / 百万 token） */
  output: number
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'deepseek-chat': { input: 2, output: 8 },
  'deepseek-reasoner': { input: 4, output: 16 },
}

export const DEFAULT_MODEL_PRICE: ModelPrice = { input: 2, output: 8 }

/** 每目标每类的输出 token 经验值（含 JSON 结构，ARCH §6.4） */
export const OUTPUT_TOKENS_PER_ITEM: Record<SingleContentKind, number> = {
  examples: 110,
  phrases: 90,
  mnemonics: 70,
}

/** 语义结构（本义/引申链）每目标输出 token 经验值（task-76，含 JSON 结构） */
export const SEMANTICS_OUTPUT_TOKENS = 150

/** 每批输入 token 经验值（20 词 ≈ 1.5k tokens） */
export const INPUT_TOKENS_PER_TARGET = 75
export const INPUT_TOKENS_BASE = 300

/** 粗估文本 token 数（4 字符 ≈ 1 token；中文按 1.5 字符/token 保守取 3 字符） */
export function estimateTextTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 3)
}

/** 合并 usage */
export function addUsage(acc: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    input: acc.input + next.input,
    output: acc.output + next.output,
    total: acc.total + next.total,
  }
}

export function emptyUsage(): TokenUsage {
  return { input: 0, output: 0, total: 0 }
}

/**
 * 成本（元）= 输入 token × 输入价 + 输出 token × 输出价（价格是元/百万 token）。
 * tokens 使用 `TokenUsage`（对应 ARCH `estimateCost(tokens, model)`）。
 */
export function estimateCost(tokens: TokenUsage, model: string): number {
  const price = MODEL_PRICES[model] ?? DEFAULT_MODEL_PRICE
  const raw =
    (tokens.input * price.input) / 1_000_000 + (tokens.output * price.output) / 1_000_000
  return Math.round(raw * 1e6) / 1e6
}

/** 单批预估 token（供预算预检；偏保守） */
export function estimateBatchTokens(input: {
  kind: GenerationKind
  targets: number
  limit?: number
}): TokenUsage {
  const perLimit = input.limit ?? 2
  const perItem =
    input.kind === 'semantics' ? SEMANTICS_OUTPUT_TOKENS : OUTPUT_TOKENS_PER_ITEM[input.kind as SingleContentKind]
  const output = Math.max(0, input.targets) * perItem * Math.max(1, perLimit / 2)
  const inputTokens = INPUT_TOKENS_BASE + Math.max(0, input.targets) * INPUT_TOKENS_PER_TARGET
  return {
    input: Math.round(inputTokens),
    output: Math.round(output),
    total: Math.round(inputTokens + output),
  }
}

/** 单批预估成本（元） */
export function estimateBatchCost(input: {
  kind: GenerationKind
  targets: number
  model: string
  limit?: number
}): number {
  return estimateCost(estimateBatchTokens(input), input.model)
}

/** 成本格式化（供 UI 文案，不进日志） */
export function formatCostYuan(yuan: number): string {
  const n = Number.isFinite(yuan) ? Math.max(0, yuan) : 0
  if (n === 0) return '¥0.00'
  return `¥${n.toFixed(n < 0.01 ? 4 : 2)}`
}
