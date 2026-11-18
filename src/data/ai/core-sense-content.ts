/** 0.3.72：单条生成本义例句/词组（超时/取消/成本预检；只回预览，不写库） */
import {
  PROMPT_VERSION_CORE_SENSE_EXAMPLES,
  PROMPT_VERSION_CORE_SENSE_PHRASES,
  buildCoreSenseExamplesSystemPrompt,
  buildCoreSenseExamplesUserPrompt,
  buildCoreSensePhrasesSystemPrompt,
  buildCoreSensePhrasesUserPrompt,
  type CoreSenseExamplesPromptSource,
  type CoreSensePhrasesPromptSource,
} from './prompts'
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import { estimateCost, estimateTextTokens } from './cost'
import type { AiConfig, TokenUsage } from './types'

export type { CoreSenseExamplesPromptSource, CoreSensePhrasesPromptSource } from './prompts'

export interface CoreSenseExamplesResult {
  examples: Array<{ en: string; cn: string }>
  usage: TokenUsage
  promptVersion: string
}
export interface CoreSensePhrasesResult {
  phrases: Array<{ en: string; cn: string }>
  usage: TokenUsage
  promptVersion: string
}
interface GenerateOptions {
  provider?: LlmProvider
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function validatePairs(raw: unknown, key: 'examples' | 'phrases', count: number): Array<{ en: string; cn: string }> {
  const value = (raw as Record<string, unknown> | null | undefined)?.[key]
  if (!Array.isArray(value)) throw new AiRequestError('AI_FORMAT', `AI 返回缺少 ${key} 数组`)
  const out: Array<{ en: string; cn: string }> = []
  for (const item of value) {
    const pair = item as { en?: unknown; cn?: unknown } | null
    const en = typeof pair?.en === 'string' ? pair.en.trim() : ''
    const cn = typeof pair?.cn === 'string' ? pair.cn.trim() : ''
    if (!en) throw new AiRequestError('AI_FORMAT', `${key}[].en 不能为空`)
    out.push({ en, cn })
    if (out.length >= count) break
  }
  if (out.length === 0) throw new AiRequestError('AI_FORMAT', `${key} 不能为空`)
  return out
}

async function callWithTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
): Promise<T> {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        outerSignal?.removeEventListener('abort', onOuterAbort)
        controller.abort()
        fn()
      }
      timer = setTimeout(
        () => finish(() => reject(new AiRequestError('AI_TIMEOUT', `生成超时（>${timeoutMs}ms）`))),
        timeoutMs,
      )
      outerSignal?.addEventListener('abort', () => finish(() => reject(new AiRequestError('AI_CANCELED', '已取消'))), {
        once: true,
      })
      if (outerSignal?.aborted) {
        finish(() => reject(new AiRequestError('AI_CANCELED', '已取消')))
        return
      }
      task(controller.signal).then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      )
    })
  } finally {
    if (timer) clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}

export async function generateCoreSenseExamples(
  source: CoreSenseExamplesPromptSource,
  config: AiConfig,
  opts: GenerateOptions = {},
): Promise<CoreSenseExamplesResult> {
  const count = Math.max(1, Math.min(3, Math.floor(source.count)))
  const est = estimateCost(
    {
      input: estimateTextTokens(buildCoreSenseExamplesSystemPrompt()) + estimateTextTokens(buildCoreSenseExamplesUserPrompt(source)),
      output: count * 80,
      total: 0,
    },
    config.model,
  )
  if (config.maxCostPerRun > 0 && est > config.maxCostPerRun) {
    throw new AiRequestError('AI_COST_LIMIT', `预计成本 ¥${est.toFixed(3)} 超过单次上限 ¥${config.maxCostPerRun}`)
  }
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const res = await callWithTimeout(
    (signal) =>
      provider.chat(
        {
          messages: [
            { role: 'system', content: buildCoreSenseExamplesSystemPrompt() },
            { role: 'user', content: buildCoreSenseExamplesUserPrompt(source) },
          ],
          temperature: 0.6,
          jsonMode: true,
        },
        config,
        signal,
      ),
    Math.max(1_000, Math.floor(opts.timeoutMs ?? 30_000)),
    opts.signal,
  )
  const extracted = extractJsonObject(res.text)
  if (!extracted.json) throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
  return {
    examples: validatePairs(extracted.json, 'examples', count),
    usage: res.usage,
    promptVersion: PROMPT_VERSION_CORE_SENSE_EXAMPLES,
  }
}

export async function generateCoreSensePhrases(
  source: CoreSensePhrasesPromptSource,
  config: AiConfig,
  opts: GenerateOptions = {},
): Promise<CoreSensePhrasesResult> {
  const count = Math.max(1, Math.min(3, Math.floor(source.count)))
  const est = estimateCost(
    {
      input: estimateTextTokens(buildCoreSensePhrasesSystemPrompt()) + estimateTextTokens(buildCoreSensePhrasesUserPrompt(source)),
      output: count * 50,
      total: 0,
    },
    config.model,
  )
  if (config.maxCostPerRun > 0 && est > config.maxCostPerRun) {
    throw new AiRequestError('AI_COST_LIMIT', `预计成本 ¥${est.toFixed(3)} 超过单次上限 ¥${config.maxCostPerRun}`)
  }
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const res = await callWithTimeout(
    (signal) =>
      provider.chat(
        {
          messages: [
            { role: 'system', content: buildCoreSensePhrasesSystemPrompt() },
            { role: 'user', content: buildCoreSensePhrasesUserPrompt(source) },
          ],
          temperature: 0.5,
          jsonMode: true,
        },
        config,
        signal,
      ),
    Math.max(1_000, Math.floor(opts.timeoutMs ?? 30_000)),
    opts.signal,
  )
  const extracted = extractJsonObject(res.text)
  if (!extracted.json) throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
  return {
    phrases: validatePairs(extracted.json, 'phrases', count),
    usage: res.usage,
    promptVersion: PROMPT_VERSION_CORE_SENSE_PHRASES,
  }
}
