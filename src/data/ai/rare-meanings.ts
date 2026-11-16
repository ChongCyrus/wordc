/** 0.3.61：AI 批量标记「考研基本不考/不正式/不常用」含义（没有就不标）。 */
import {
  PROMPT_VERSION_RARE_MEANINGS,
  buildRareMeaningsSystemPrompt,
  buildRareMeaningsUserPrompt,
  type RareMeaningsPromptSource,
} from './prompts'
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import { addUsage, emptyUsage, estimateCost, estimateTextTokens } from './cost'
import type { AiConfig, TokenUsage } from './types'

export type { RareMeaningsPromptSource } from './prompts'

export interface RareMeaningsGenerateResult {
  rareMeaningIndexes: number[]
  usage: TokenUsage
  promptVersion: string
}

export interface GenerateRareMeaningsOptions {
  provider?: LlmProvider
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/** 校验模型输出：可空数组；索引必须是输入 c 的 1..N 整数 */
export function validateRareMeaningsDraft(raw: unknown, meaningCount: number): number[] {
  const obj = raw as { rareMeaningIndexes?: unknown } | null | undefined
  const list = obj?.rareMeaningIndexes
  if (!Array.isArray(list)) throw new AiRequestError('AI_FORMAT', 'AI 返回缺少 rareMeaningIndexes 数组')
  const indexes = list.map((value) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > meaningCount) {
      throw new AiRequestError('AI_FORMAT', `rareMeaningIndexes 必须是 1..${meaningCount} 的整数`)
    }
    return value
  })
  return [...new Set(indexes)].sort((a, b) => a - b)
}

export async function generateRareMeanings(
  source: RareMeaningsPromptSource,
  config: AiConfig,
  opts: GenerateRareMeaningsOptions = {},
): Promise<RareMeaningsGenerateResult> {
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const signal = opts.signal ?? new AbortController().signal
  const res = await provider.chat(
    {
      messages: [
        { role: 'system', content: buildRareMeaningsSystemPrompt() },
        { role: 'user', content: buildRareMeaningsUserPrompt(source) },
      ],
      temperature: 0.2,
      jsonMode: true,
    },
    config,
    signal,
  )
  const extracted = extractJsonObject(res.text)
  if (!extracted.json) throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
  return {
    rareMeaningIndexes: validateRareMeaningsDraft(extracted.json, source.meanings.length),
    usage: res.usage,
    promptVersion: PROMPT_VERSION_RARE_MEANINGS,
  }
}

export interface RareMeaningsBatchItemResult {
  source: RareMeaningsPromptSource
  rareMeaningIndexes?: number[]
  usage?: TokenUsage
  promptVersion?: string
  /** 失败/取消原因（成功时缺省） */
  error?: string
  /** 失败分类：timeout=单条超时；canceled=外部停止；format/network 等来自 provider */
  errorKind?: 'timeout' | 'canceled' | 'other'
}

export interface RareMeaningsBatchProgress {
  done: number
  total: number
  succeeded: number
  failed: number
  /** 当前在途请求数（UI 显示 inFlight） */
  inFlight: number
  /** 刚 settle 的词 id（可选） */
  wordId?: string
}

export interface RareMeaningsBatchResult {
  results: RareMeaningsBatchItemResult[]
  /** 成功词的累计 usage */
  usage: TokenUsage
  /** 估算成本（元；与 generateItems 同一套 estimateCost） */
  costYuan: number
  /** 因单条超时自动重试的次数 */
  retried: number
  /** 是否被外部 abort（结果中未完成项标记 canceled） */
  canceled: boolean
}

export interface GenerateRareMeaningsBatchOptions extends GenerateRareMeaningsOptions {
  /** 并发数，默认 2（建议 UI 2–4；最大 5） */
  concurrency?: number
  /** 单条超时（默认 30_000ms）；只失败该条，不中断其它词 */
  timeoutMs?: number
  /** 单条超时是否自动重试一次（默认 true） */
  retryTimeoutOnce?: boolean
  /** 每条 settle 后回调（done/成功/失败/inFlight/wordId） */
  onProgress?: (progress: RareMeaningsBatchProgress) => void
}

interface OneCallOutcome {
  ok: boolean
  rareMeaningIndexes?: number[]
  usage?: TokenUsage
  promptVersion?: string
  error?: string
  errorKind?: 'timeout' | 'canceled' | 'other'
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof AiRequestError && error.code === 'AI_TIMEOUT'
}

/** 单条调用：超时/外部 abort 以 race 收尾（底层 provider 同时 abort），不挂整批 */
async function callOneWithTimeout(
  source: RareMeaningsPromptSource,
  config: AiConfig,
  provider: LlmProvider,
  timeoutMs: number,
  outerSignal: AbortSignal | undefined,
  fetchImpl: typeof fetch | undefined,
): Promise<OneCallOutcome> {
  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  outerSignal?.addEventListener('abort', onOuterAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const task = generateRareMeanings(source, config, {
      provider,
      signal: controller.signal,
      ...(fetchImpl ? { fetchImpl } : {}),
    })
    const outcome = await new Promise<OneCallOutcome>((resolve) => {
      let settled = false
      const finish = (next: OneCallOutcome) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        outerSignal?.removeEventListener('abort', onOuterAbort)
        controller.abort() // 取消底层请求（超时/成功均安全：Promise 已完成时 abort 无副作用）
        resolve(next)
      }
      timer = setTimeout(() => finish({ ok: false, error: `单条超时（>${timeoutMs}ms）`, errorKind: 'timeout' }), timeoutMs)
      if (outerSignal?.aborted) {
        finish({ ok: false, error: '已取消', errorKind: 'canceled' })
        return
      }
      outerSignal?.addEventListener(
        'abort',
        () => finish({ ok: false, error: '已取消', errorKind: 'canceled' }),
        { once: true },
      )
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
    return outcome
  } finally {
    if (timer) clearTimeout(timer)
    outerSignal?.removeEventListener('abort', onOuterAbort)
    controller.abort()
  }
}

/** 批量标记：一次提交全部词，并发池逐词 settle；失败词隔离，外层 abort 可立即收尾 */
export async function generateRareMeaningsBatch(
  sources: RareMeaningsPromptSource[],
  config: AiConfig,
  opts: GenerateRareMeaningsBatchOptions = {},
): Promise<RareMeaningsBatchResult> {
  const total = sources.length
  const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs ?? 30_000))
  const retryTimeoutOnce = opts.retryTimeoutOnce !== false
  const concurrency = Math.max(1, Math.min(5, Math.floor(opts.concurrency ?? 2)))
  const results: RareMeaningsBatchItemResult[] = new Array(total)
  let retried = 0
  let succeeded = 0
  let failed = 0
  let inFlight = 0
  let done = 0
  let canceled = false
  const report = (wordId?: string) =>
    opts.onProgress?.({ done, total, succeeded, failed, inFlight, ...(wordId ? { wordId } : {}) })

  const failItem = (index: number, outcome: OneCallOutcome) => {
    const source = sources[index]!
    results[index] = {
      source,
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

  // 成本上限预检：先用 prompt 文本粗估输入 + 每词输出经验值，超过 config.maxCostPerRun 直接拒绝开始
  const estimatedInput = sources.reduce(
    (sum, source) =>
      sum +
      estimateTextTokens(buildRareMeaningsSystemPrompt()) +
      estimateTextTokens(buildRareMeaningsUserPrompt(source)),
    0,
  )
  const estimatedCost = estimateCost(
    { input: estimatedInput, output: total * 150, total: estimatedInput + total * 150 },
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
        let outcome = await callOneWithTimeout(source, config, provider, timeoutMs, opts.signal, opts.fetchImpl)
        // 超时自动重试一次（只重试该条；取消不重试）
        if (!outcome.ok && outcome.errorKind === 'timeout' && retryTimeoutOnce && !opts.signal?.aborted) {
          retried += 1
          outcome = await callOneWithTimeout(source, config, provider, timeoutMs, opts.signal, opts.fetchImpl)
        }
        if (outcome.ok) {
          results[index] = {
            source,
            rareMeaningIndexes: outcome.rareMeaningIndexes ?? [],
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
        report(source.wordId ?? source.word)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))
  if (opts.signal?.aborted) canceled = true
  // 极端中断：worker 退出后仍可能有个别 index 未赋值（worker 启动前被取消）；补 canceled 并修正计数
  for (let index = 0; index < total; index += 1) {
    if (results[index]) continue
    failItem(index, { ok: false, error: '已取消', errorKind: 'canceled' })
    done += 1
  }
  if (done > total) done = total
  report()
  let usage = emptyUsage()
  for (const result of results) if (result.usage) usage = addUsage(usage, result.usage)
  return { results, usage, costYuan: estimateCost(usage, config.model), retried, canceled }
}
