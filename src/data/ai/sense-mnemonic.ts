/** 0.3.65：AI 生成「w→本义」助记（单条 + 批量控制面）。结果只回 UI 预览，不自动写库。 */
import {
  PROMPT_VERSION_SENSE_MNEMONIC,
  buildSenseMnemonicSystemPrompt,
  buildSenseMnemonicUserPrompt,
  type SenseMnemonicPromptSource,
} from './prompts'
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import { addUsage, emptyUsage, estimateCost, estimateTextTokens } from './cost'
import type { AiConfig, TokenUsage } from './types'

export type { SenseMnemonicPromptSource } from './prompts'

export interface SenseMnemonicGenerateResult {
  mnemonic: string
  usage: TokenUsage
  promptVersion: string
}

export interface GenerateSenseMnemonicOptions {
  provider?: LlmProvider
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export function validateSenseMnemonicDraft(raw: unknown): string {
  const obj = raw as { mnemonic?: unknown } | null | undefined
  const text = typeof obj?.mnemonic === 'string' ? obj.mnemonic.trim() : ''
  if (!text) throw new AiRequestError('AI_FORMAT', 'AI 返回缺少 mnemonic')
  if (text.length > 500) throw new AiRequestError('AI_FORMAT', '助记过长（>500 字）')
  return text
}

export async function generateSenseMnemonic(
  source: SenseMnemonicPromptSource,
  config: AiConfig,
  opts: GenerateSenseMnemonicOptions = {},
): Promise<SenseMnemonicGenerateResult> {
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const signal = opts.signal ?? new AbortController().signal
  const res = await provider.chat(
    {
      messages: [
        { role: 'system', content: buildSenseMnemonicSystemPrompt() },
        { role: 'user', content: buildSenseMnemonicUserPrompt(source) },
      ],
      temperature: 0.6,
      jsonMode: true,
    },
    config,
    signal,
  )
  const extracted = extractJsonObject(res.text)
  if (!extracted.json) throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
  return {
    mnemonic: validateSenseMnemonicDraft(extracted.json),
    usage: res.usage,
    promptVersion: PROMPT_VERSION_SENSE_MNEMONIC,
  }
}

export interface SenseMnemonicBatchItemResult {
  source: SenseMnemonicPromptSource & { wordId?: string; coreSenseIndex?: number }
  mnemonic?: string
  usage?: TokenUsage
  promptVersion?: string
  error?: string
  errorKind?: 'timeout' | 'canceled' | 'other'
}

export interface SenseMnemonicBatchProgress {
  done: number
  total: number
  succeeded: number
  failed: number
  inFlight: number
  wordId?: string
  coreSenseIndex?: number
}

export interface SenseMnemonicBatchResult {
  results: SenseMnemonicBatchItemResult[]
  usage: TokenUsage
  costYuan: number
  retried: number
  canceled: boolean
}

export interface GenerateSenseMnemonicBatchOptions extends GenerateSenseMnemonicOptions {
  concurrency?: number
  timeoutMs?: number
  retryTimeoutOnce?: boolean
  onProgress?: (progress: SenseMnemonicBatchProgress) => void
}

type BatchSource = SenseMnemonicPromptSource & { wordId?: string; coreSenseIndex?: number }

interface OneOutcome {
  ok: boolean
  mnemonic?: string
  usage?: TokenUsage
  promptVersion?: string
  error?: string
  errorKind?: 'timeout' | 'canceled' | 'other'
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof AiRequestError && error.code === 'AI_TIMEOUT'
}

async function callOne(
  source: BatchSource,
  config: AiConfig,
  provider: LlmProvider,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<OneOutcome> {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const task = generateSenseMnemonic(source, config, {
      provider,
      signal: controller.signal,
      ...(fetchImpl ? { fetchImpl } : {}),
    })
    return await new Promise<OneOutcome>((resolve) => {
      let settled = false
      const finish = (next: OneOutcome) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        controller.abort()
        resolve(next)
      }
      timer = setTimeout(() => finish({ ok: false, error: `单条超时（>${timeoutMs}ms）`, errorKind: 'timeout' }), timeoutMs)
      outerSignal?.addEventListener('abort', () => finish({ ok: false, error: '已取消', errorKind: 'canceled' }), { once: true })
      if (outerSignal?.aborted) {
        finish({ ok: false, error: '已取消', errorKind: 'canceled' })
        return
      }
      task.then(
        (result) => finish({ ok: true, ...result }),
        (error) => {
          const canceled = outerSignal?.aborted === true
          finish({
            ok: false,
            error: canceled ? '已取消' : error instanceof Error ? error.message : String(error),
            errorKind: canceled ? 'canceled' : isTimeoutError(error) ? 'timeout' : 'other',
          })
        },
      )
    })
  } finally {
    if (timer) clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}

export async function generateSenseMnemonicBatch(
  sources: BatchSource[],
  config: AiConfig,
  opts: GenerateSenseMnemonicBatchOptions = {},
): Promise<SenseMnemonicBatchResult> {
  const total = sources.length
  const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs ?? 30_000))
  const retryTimeoutOnce = opts.retryTimeoutOnce !== false
  const concurrency = Math.max(1, Math.min(5, Math.floor(opts.concurrency ?? 2)))
  const results: SenseMnemonicBatchItemResult[] = new Array(total)
  let retried = 0
  let succeeded = 0
  let failed = 0
  let inFlight = 0
  let done = 0
  let canceled = false
  const report = (wordId?: string, coreSenseIndex?: number) =>
    opts.onProgress?.({ done, total, succeeded, failed, inFlight, ...(wordId ? { wordId } : {}), ...(coreSenseIndex != null ? { coreSenseIndex } : {}) })
  const failItem = (index: number, outcome: OneOutcome) => {
    results[index] = {
      source: sources[index]!,
      error: outcome.error ?? '失败',
      ...(outcome.errorKind ? { errorKind: outcome.errorKind } : {}),
    }
    failed += 1
  }
  if (opts.signal?.aborted) {
    canceled = true
    for (let index = 0; index < total; index += 1) failItem(index, { ok: false, error: '已取消', errorKind: 'canceled' })
    done = total
    report()
    return { results, usage: emptyUsage(), costYuan: 0, retried: 0, canceled }
  }
  const estimatedInput = sources.reduce(
    (sum, source) =>
      sum + estimateTextTokens(buildSenseMnemonicSystemPrompt()) + estimateTextTokens(buildSenseMnemonicUserPrompt(source)),
    0,
  )
  const estimatedCost = estimateCost(
    { input: estimatedInput, output: total * 120, total: estimatedInput + total * 120 },
    config.model,
  )
  if (config.maxCostPerRun > 0 && estimatedCost > config.maxCostPerRun) {
    throw new AiRequestError(
      'AI_COST_LIMIT',
      `预计成本 ¥${estimatedCost.toFixed(3)} 超过单次上限 ¥${config.maxCostPerRun}`,
    )
  }
  if (total === 0) return { results, usage: emptyUsage(), costYuan: 0, retried: 0, canceled: false }
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  report()
  let cursor = 0
  async function worker(): Promise<void> {
    while (true) {
      if (opts.signal?.aborted) {
        canceled = true
        return
      }
      const index = cursor
      if (index >= total) return
      cursor += 1
      const source = sources[index]!
      inFlight += 1
      try {
        let outcome = await callOne(source, config, provider, timeoutMs, opts.signal, opts.fetchImpl)
        if (!outcome.ok && outcome.errorKind === 'timeout' && retryTimeoutOnce && !opts.signal?.aborted) {
          retried += 1
          outcome = await callOne(source, config, provider, timeoutMs, opts.signal, opts.fetchImpl)
        }
        if (outcome.ok) {
          results[index] = {
            source,
            mnemonic: outcome.mnemonic,
            ...(outcome.usage ? { usage: outcome.usage } : {}),
            ...(outcome.promptVersion ? { promptVersion: outcome.promptVersion } : {}),
          }
          succeeded += 1
        } else {
          failItem(index, outcome)
        }
      } finally {
        inFlight -= 1
        done += 1
        report(source.wordId, source.coreSenseIndex)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))
  if (opts.signal?.aborted) canceled = true
  for (let index = 0; index < total; index += 1) {
    if (results[index]) continue
    failItem(index, { ok: false, error: '已取消', errorKind: 'canceled' })
    done += 1
  }
  report()
  let usage = emptyUsage()
  for (const result of results) if (result.usage) usage = addUsage(usage, result.usage)
  return { results, usage, costYuan: estimateCost(usage, config.model), retried, canceled }
}
