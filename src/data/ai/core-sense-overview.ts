/** 0.3.73：AI 生成本义串联助记（单条；超时/取消/成本预检；只回预览） */
import {
  PROMPT_VERSION_CORE_SENSE_OVERVIEW,
  buildCoreSenseOverviewSystemPrompt,
  buildCoreSenseOverviewUserPrompt,
  type CoreSenseOverviewPromptSource,
} from './prompts'
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import { estimateCost, estimateTextTokens } from './cost'
import type { AiConfig, TokenUsage } from './types'

export type { CoreSenseOverviewPromptSource } from './prompts'

export interface CoreSenseOverviewResult {
  text: string
  usage: TokenUsage
  promptVersion: string
}

export interface GenerateCoreSenseOverviewOptions {
  provider?: LlmProvider
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export function validateCoreSenseOverviewDraft(raw: unknown): string {
  const obj = raw as { text?: unknown } | null | undefined
  const text = typeof obj?.text === 'string' ? obj.text.trim() : ''
  if (!text) throw new AiRequestError('AI_FORMAT', 'AI 返回缺少 text')
  if (text.length > 500) throw new AiRequestError('AI_FORMAT', '串联助记过长（>500 字）')
  return text
}

export async function generateCoreSenseOverview(
  source: CoreSenseOverviewPromptSource,
  config: AiConfig,
  opts: GenerateCoreSenseOverviewOptions = {},
): Promise<CoreSenseOverviewResult> {
  const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs ?? 30_000))
  const estimated = estimateCost(
    {
      input:
        estimateTextTokens(buildCoreSenseOverviewSystemPrompt()) +
        estimateTextTokens(buildCoreSenseOverviewUserPrompt(source)),
      output: 200,
      total: 0,
    },
    config.model,
  )
  if (config.maxCostPerRun > 0 && estimated > config.maxCostPerRun) {
    throw new AiRequestError(
      'AI_COST_LIMIT',
      `预计成本 ¥${estimated.toFixed(3)} 超过单次上限 ¥${config.maxCostPerRun}`,
    )
  }
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const res = await new Promise<Awaited<ReturnType<LlmProvider['chat']>>>((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onOuterAbort)
        controller.abort()
        fn()
      }
      timer = setTimeout(
        () => finish(() => reject(new AiRequestError('AI_TIMEOUT', `串联助记生成超时（>${timeoutMs}ms）`))),
        timeoutMs,
      )
      opts.signal?.addEventListener('abort', () => finish(() => reject(new AiRequestError('AI_CANCELED', '已取消'))), {
        once: true,
      })
      if (opts.signal?.aborted) {
        finish(() => reject(new AiRequestError('AI_CANCELED', '已取消')))
        return
      }
      provider
        .chat(
          {
            messages: [
              { role: 'system', content: buildCoreSenseOverviewSystemPrompt() },
              { role: 'user', content: buildCoreSenseOverviewUserPrompt(source) },
            ],
            temperature: 0.6,
            jsonMode: true,
          },
          config,
          controller.signal,
        )
        .then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)))
    })
    const extracted = extractJsonObject(res.text)
    if (!extracted.json) throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
    return {
      text: validateCoreSenseOverviewDraft(extracted.json),
      usage: res.usage,
      promptVersion: PROMPT_VERSION_CORE_SENSE_OVERVIEW,
    }
  } finally {
    if (timer) clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}
