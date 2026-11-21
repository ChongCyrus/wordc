/**
 * AI 扩充 UI 辅助（task-71）：错误码文案、范围/类型/排除选项、预算与进度格式化。
 * 纯函数、无依赖，便于单测；数据调用统一走 `src/data/ai`。
 */
import type { AiErrorCode, AiProviderId, GenerationKind } from '../../data/ai'

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

/** 错误码 → 常见 HTTP 状态（用于文案补充；not available 时不加） */
const AI_ERROR_HTTP: Partial<Record<AiErrorCode, number>> = {
  AI_AUTH: 401,
  AI_QUOTA: 402,
  AI_RATE_LIMIT: 429,
  AI_TIMEOUT: 408,
}

export function aiErrorMessage(
  code: string | undefined,
  fallback = '生成失败',
  status?: number,
): string {
  if (!code || !(code in AI_ERROR_MESSAGES)) return fallback
  const message = AI_ERROR_MESSAGES[code as AiErrorCode]
  const http = status ?? AI_ERROR_HTTP[code as AiErrorCode]
  return http ? `${message}（HTTP ${http}）` : message
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

export type AiScope = 'today' | 'deck' | 'word' | 'meanings' | 'deck-select' | 'custom'

export const AI_SCOPE_OPTIONS: ReadonlyArray<{ value: AiScope; label: string }> = [
  { value: 'today', label: '今日要学' },
  { value: 'deck', label: '当前词库' },
  { value: 'word', label: '当前词' },
  { value: 'meanings', label: '指定含义' },
  { value: 'deck-select', label: '选择词库' },
  { value: 'custom', label: '自定义选词' },
]

export const AI_CONTENT_KIND_OPTIONS: ReadonlyArray<{
  value: GenerationKind
  label: string
}> = [
  { value: 'examples', label: '例句' },
  { value: 'phrases', label: '词组' },
  { value: 'mnemonics', label: '助记' },
  { value: 'semantics', label: '本义/引申链' },
]

export type AiExcludeKey = 'existingExamples' | 'existingPhrases' | 'existingMnemonics' | 'rejected'

export const AI_EXCLUDE_OPTIONS: ReadonlyArray<{ value: AiExcludeKey; label: string }> = [
  { value: 'existingExamples', label: '已有例句' },
  { value: 'existingPhrases', label: '已有词组' },
  { value: 'existingMnemonics', label: '已有助记' },
  { value: 'rejected', label: '已拒绝' },
]

/** 生成模式（task-107）：仅缺失 / 追加更多 / 覆盖；本义链只有 missing/replace */
export type AiGenerationMode = 'missing' | 'append' | 'replace'
export const AI_MODE_OPTIONS: ReadonlyArray<{ value: AiGenerationMode; label: string }> = [
  { value: 'missing', label: '仅缺失' },
  { value: 'append', label: '追加更多' },
  { value: 'replace', label: '覆盖' },
]
export const AI_SEMANTICS_MODE_OPTIONS: ReadonlyArray<{ value: AiGenerationMode; label: string }> = [
  { value: 'missing', label: '仅缺失' },
  { value: 'replace', label: '替换该词本义' },
]
export function aiModeLabel(mode: AiGenerationMode): string {
  return AI_MODE_OPTIONS.find((option) => option.value === mode)?.label ?? mode
}

/** deck 选项文案：deck.name 已含「（N 词）」时不再重复追加（task-85 QA P3） */
export function formatDeckOption(name: string, wordCount: number): string {
  return /（\d+\s*词）$/.test(name) ? name : `${name}（${wordCount} 词）`
}

export function aiScopeLabel(scope: AiScope): string {
  return AI_SCOPE_OPTIONS.find((item) => item.value === scope)?.label ?? scope
}

export function aiKindLabel(kind: GenerationKind): string {
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

/** 无目标提示（task-109：已有内容/被排除/词未选中都立即提示，不进入请求） */
export const AI_EMPTY_TARGET_MESSAGE = '没有可生成的词（已有/被排除）'

/** 单次生成请求硬超时（task-109；与 provider timeout 独立，防 UI 无限转圈） */
export const AI_GENERATION_TIMEOUT_MS = 60_000

/**
 * 给生成 Promise 加 UI 级超时；超时后调用 onTimeout（通常 abort 请求）并抛 AI_TIMEOUT。
 * 纯函数可测：不依赖 DOM/真实网络。
 */
export async function withAiTimeout<T>(
  promise: Promise<T>,
  opts: { timeoutMs?: number; onTimeout?: () => void } = {},
): Promise<T> {
  const timeoutMs = Math.max(1, opts.timeoutMs ?? AI_GENERATION_TIMEOUT_MS)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { opts.onTimeout?.() } catch { /* ignore */ }
      reject(Object.assign(new Error('AI_TIMEOUT'), { code: 'AI_TIMEOUT' }))
    }, timeoutMs)
  })
  try { return await Promise.race([promise, timeout]) } finally { if (timer) clearTimeout(timer) }
}

/** 设置页「测试连接」失败文案：错误码文案 + 底层原因（task-117） */
export function formatAiTestFailure(code: string | undefined, detail?: string): string {
  const base = aiErrorMessage(code, '请检查网络/Key/baseURL')
  const extra = String(detail ?? '').trim()
  return extra ? `连接失败：${base}（${extra.slice(0, 120)}）` : `连接失败：${base}`
}
