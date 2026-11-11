/**
 * AI 扩充 UI 辅助（task-71）：错误码文案、范围/类型/排除选项、预算与进度格式化。
 * 纯函数、无依赖，便于单测；数据调用统一走 `src/data/ai`。
 */
import type { AiErrorCode, AiProviderId, SingleContentKind } from '../../data/ai'

export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  AI_DISABLED: 'AI 扩充未开启：请先在设置页打开「AI 扩充」并填写 Key。',
  AI_NO_KEY: '未配置 AI API Key：请在设置页填写（只存本机，不导出）。',
  AI_AUTH: 'Key 无效或已过期：请检查 API Key 后重试。',
  AI_QUOTA: '账户余额不足：请充值后重试。',
  AI_RATE_LIMIT: '请求过于频繁：已自动退避重试，请稍后再试。',
  AI_FORMAT: '模型输出格式异常：已自动重试，仍失败请换个模型或稍后重试。',
  AI_TIMEOUT: '请求超时：请检查网络或稍后重试。',
  AI_NETWORK: '网络失败：请检查网络连接或本地代理是否在运行。',
  AI_BAD_RESPONSE: '服务返回异常：请稍后重试或检查 baseURL/模型配置。',
  AI_EMPTY: '未生成有效内容：可稍后重试或换用其它类型。',
  AI_COST_LIMIT: '已达单次费用上限：可在设置页调高「单次预算」后重试。',
  AI_CANCELED: '已取消。',
  AI_UNKNOWN: '生成失败：请稍后重试。',
}

export function aiErrorMessage(code: string | undefined, fallback = '生成失败'): string {
  if (code && code in AI_ERROR_MESSAGES) return AI_ERROR_MESSAGES[code as AiErrorCode]
  return fallback
}

/** 失败分类短文案（summary 计数用；QA S18 P2） */
export const AI_FAILURE_LABELS: Record<AiErrorCode, string> = {
  AI_AUTH: 'Key 无效',
  AI_QUOTA: '余额不足',
  AI_RATE_LIMIT: '请求过于频繁',
  AI_TIMEOUT: '请求超时',
  AI_NETWORK: '网络失败',
  AI_FORMAT: '格式异常',
  AI_BAD_RESPONSE: '服务异常',
  AI_EMPTY: '无有效内容',
  AI_COST_LIMIT: '费用上限',
  AI_CANCELED: '已取消',
  AI_NO_KEY: '未配置 Key',
  AI_DISABLED: '未启用',
  AI_UNKNOWN: '未知错误',
}

/**
 * 汇总失败分类计数：「失败 30 条：余额不足 30」「失败 5 条：请求超时 3、Key 无效 2」。
 * 无错误码返回 null。
 */
export function summarizeAiFailures(
  codes: ReadonlyArray<string | undefined>,
): string | null {
  const counts = new Map<string, number>()
  for (const code of codes) {
    if (!code) continue
    counts.set(code, (counts.get(code) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, count]) => `${AI_FAILURE_LABELS[code as AiErrorCode] ?? '未知错误'} ${count}`)
  return `失败 ${total} 条：${parts.join('、')}`
}

/** 关键失败码：批量里出现任意一条即展示分类文案（QA S18 P2） */
const AI_FATAL_CODES: ReadonlyArray<AiErrorCode> = [
  'AI_AUTH',
  'AI_QUOTA',
  'AI_RATE_LIMIT',
  'AI_TIMEOUT',
  'AI_COST_LIMIT',
  'AI_NETWORK',
  'AI_NO_KEY',
  'AI_DISABLED',
]

/**
 * 从批量生成的错误码里挑一条给用户看（避免只显示「失败 N 条」）：
 * - 优先关键码（鉴权/余额/限流/超时/预算/网络）；
 * - 否则用第一条错误码；
 * - 无错误返回 null。
 */
export function pickAiFailureMessage(codes: ReadonlyArray<string | undefined>): string | null {
  const valid = codes.filter((code): code is string => typeof code === 'string' && code.length > 0)
  if (valid.length === 0) return null
  const fatal = valid.find((code) => (AI_FATAL_CODES as readonly string[]).includes(code))
  return aiErrorMessage(fatal ?? valid[0])
}

export const AI_PROVIDER_OPTIONS: ReadonlyArray<{ value: AiProviderId; label: string }> = [
  { value: 'deepseek', label: 'DeepSeek（默认）' },
  { value: 'openai-compatible', label: 'OpenAI 兼容' },
]

export type AiScope = 'today' | 'deck' | 'word'

export const AI_SCOPE_OPTIONS: ReadonlyArray<{ value: AiScope; label: string }> = [
  { value: 'today', label: '今日要学' },
  { value: 'deck', label: '当前词库' },
  { value: 'word', label: '当前词' },
]

export const AI_CONTENT_KIND_OPTIONS: ReadonlyArray<{
  value: SingleContentKind
  label: string
}> = [
  { value: 'examples', label: '例句' },
  { value: 'phrases', label: '词组' },
  { value: 'mnemonics', label: '助记' },
]

export type AiExcludeKey = 'existingExamples' | 'existingPhrases' | 'existingMnemonics' | 'rejected'

export const AI_EXCLUDE_OPTIONS: ReadonlyArray<{ value: AiExcludeKey; label: string }> = [
  { value: 'existingExamples', label: '已有例句' },
  { value: 'existingPhrases', label: '已有词组' },
  { value: 'existingMnemonics', label: '已有助记' },
  { value: 'rejected', label: '已拒绝' },
]

export function aiScopeLabel(scope: AiScope): string {
  return AI_SCOPE_OPTIONS.find((item) => item.value === scope)?.label ?? scope
}

export function aiKindLabel(kind: SingleContentKind): string {
  return AI_CONTENT_KIND_OPTIONS.find((item) => item.value === kind)?.label ?? kind
}

/** 预算行：「预计 ¥0.12 / 单次上限 ¥3.00（0=不限）」 */
export function formatAiBudget(estimatedYuan: number, maxCostPerRun: number): string {
  const estimate = Number.isFinite(estimatedYuan) ? Math.max(0, estimatedYuan) : 0
  const cap =
    !Number.isFinite(maxCostPerRun) || maxCostPerRun <= 0
      ? '不限'
      : `¥${maxCostPerRun.toFixed(2)}`
  return `预计 ¥${estimate.toFixed(2)} / 单次上限 ${cap}`
}

/** 进度行：「正在生成 12 / 40 · 已用 ¥0.08」 */
export function formatAiProgress(done: number, total: number, costYuan: number): string {
  const safeDone = Number.isFinite(done) ? Math.max(0, Math.round(done)) : 0
  const safeTotal = Number.isFinite(total) ? Math.max(0, Math.round(total)) : 0
  const cost = Number.isFinite(costYuan) ? Math.max(0, costYuan) : 0
  return `正在生成 ${safeDone} / ${safeTotal} · 已用 ¥${cost.toFixed(2)}`
}

/** 失败/取消汇总（结果页提示） */
export function formatAiSummary(input: {
  total: number
  succeeded: number
  failed: number
  canceled: boolean
  costYuan: number
}): string {
  if (input.canceled) return `已取消：完成 ${input.succeeded} / ${input.total} 条，已用 ¥${input.costYuan.toFixed(2)}`
  const base = `完成 ${input.succeeded} / ${input.total} 条`
  const fail = input.failed > 0 ? `，失败 ${input.failed} 条` : ''
  return `${base}${fail} · 已用 ¥${input.costYuan.toFixed(2)}`
}
