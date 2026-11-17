/**
 * F11：批量生成「生成元 → 含义」引申图（prompt v1.3）的编排层。
 * - 逐词调用 generateDerivationMap，单条失败不中断；
 * - 并发 1–4、AbortSignal 可停止、进度回调；
 * - 不自动保存（通过 onSaved 交给 UI）；task-194：单条请求 30s 超时（只失败该条），
 *   AI 超时失败项自动重试一次（普通失败不重试）；批量上限由选词辅助控制。
 */
import { generateDerivationMap } from './derivation-map'
import type { DerivationMapResult } from './derivation-map'
import { AiRequestError } from './provider'
import type { AiConfig, TokenUsage } from './types'
import type { LlmProvider } from './provider'
import { getDb } from '../db'
import type { Word } from '../../core/types'

export const DERIVATION_BATCH_MAX_ITEMS = 200
/** task-194：单条 AI 请求超时（与外部 signal 合并；超时只失败该条，其它 worker 继续） */
export const DERIVATION_BATCH_REQUEST_TIMEOUT_MS = 30_000
/** task-194：AI 超时失败项自动重试一次（可在 options 关闭） */
export const DERIVATION_BATCH_AUTO_RETRY_TIMEOUTS = true

export interface DerivationBatchItem {
  wordId: string
  deckId?: string
  word: string
  meanings: Array<{ index: number; cn: string; pos?: string }>
}

export interface DerivationBatchFailure {
  wordId: string
  code: string
  message: string
  retryable: boolean
}

export interface DerivationBatchSkipped {
  wordId: string
  reason: 'aborted' | 'canceled'
}

export interface DerivationBatchProgress {
  done: number
  total: number
  succeeded: number
  failed: number
  skipped: number
  /** 当前完成的词（用于 UI 显示） */
  wordId?: string
  /** task-194：main=第一次批量；retry=超时失败项自动重试阶段 */
  phase?: 'main' | 'retry'
  /** retry 阶段专用：已重试数/待重试总数（UI 显示「自动重试失败项 i/n」） */
  retryDone?: number
  retryTotal?: number
  /** 当前在跑的请求数（UI「进行中」避免歧义；可选） */
  inFlight?: number
}

export interface DerivationBatchOptions {
  concurrency?: number
  signal?: AbortSignal
  onProgress?: (progress: DerivationBatchProgress) => void
  /** 每成功一条回调（UI 可立即保存）；抛错按该条失败处理 */
  onSaved?: (wordId: string, result: DerivationMapResult) => void | Promise<void>
  provider?: LlmProvider
  fetchImpl?: typeof fetch
  /** task-194：单条请求超时（ms，默认 30s；与外部 signal 合并） */
  requestTimeoutMs?: number
  /** task-194：AI 超时失败项自动重试一次（默认 true） */
  autoRetryTimeouts?: boolean
  /** task-194：自动重试阶段并发（默认 min(2, 批量并发)） */
  retryConcurrency?: number
}

export interface DerivationBatchResult {
  total: number
  succeeded: Array<{ wordId: string; result: DerivationMapResult }>
  failed: DerivationBatchFailure[]
  skipped: DerivationBatchSkipped[]
  stopped: boolean
  usage: TokenUsage
  calls: number
  /** task-194：本次自动重试的超时失败项数量 */
  retried: number
}

function clampConcurrency(value: number | undefined): number {
  const n = Math.floor(Number(value ?? 2))
  if (!Number.isFinite(n)) return 2
  return Math.min(4, Math.max(1, n))
}

function errorOf(err: unknown): { code: string; message: string; retryable: boolean } {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; message?: unknown; retryable?: unknown }
    return {
      code: typeof e.code === 'string' ? e.code : 'AI_UNKNOWN',
      message: typeof e.message === 'string' ? e.message : '生成失败',
      retryable: e.retryable === true,
    }
  }
  return { code: 'AI_UNKNOWN', message: typeof err === 'string' ? err : '生成失败', retryable: false }
}

/**
 * 并发批量生成；返回成功结果（不落库）。Abort 后不再启动新词，已成功结果保留。
 */
type AttemptOutcome =
  | { ok: true; result: DerivationMapResult }
  | { ok: false; code: string; message: string; retryable: boolean; timedOut: boolean; canceled: boolean }

function timeoutError(timeoutMs: number): AiRequestError {
  const seconds = Math.max(1, Math.round(timeoutMs / 1000))
  return new AiRequestError('AI_TIMEOUT', `单条请求超过 ${seconds}s，已中断该条`, { retryable: true })
}

/**
 * 单条请求：外部 signal 与「单条超时」合并；超时只 abort 本条，不影响其它 worker。
 * 用 Promise.race 兜底 provider 不响应 abort 的挂起 Promise。
 */
async function attemptOne(
  item: DerivationBatchItem,
  config: AiConfig,
  opts: DerivationBatchOptions,
  timeoutMs: number,
): Promise<AttemptOutcome> {
  const local = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const onExternalAbort = (): void => local.abort()
  if (opts.signal) {
    if (opts.signal.aborted) local.abort()
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true })
  }
  const aborted = new Promise<never>((_, reject) => {
    local.signal.addEventListener(
      'abort',
      () => reject(timedOut ? timeoutError(timeoutMs) : new AiRequestError('AI_CANCELED', '已取消')),
      { once: true },
    )
  })
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      local.abort()
      reject(timeoutError(timeoutMs))
    }, timeoutMs)
  })
  try {
    const running = generateDerivationMap(
      { word: item.word, meanings: item.meanings },
      config,
      {
        ...(opts.provider ? { provider: opts.provider } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        signal: local.signal,
      },
    )
    // provider 若在超时后仍返回，避免 unhandled rejection
    running.catch(() => undefined)
    const result = await Promise.race([running, timeout, aborted])
    return { ok: true, result }
  } catch (err) {
    const detail = errorOf(err)
    const canceled = !timedOut && (timedOut === false && (opts.signal?.aborted === true || detail.code === 'AI_CANCELED'))
    if (timedOut) {
      return { ok: false, code: 'AI_TIMEOUT', message: timeoutError(timeoutMs).message, retryable: true, timedOut: true, canceled: false }
    }
    return { ok: false, ...detail, retryable: detail.retryable || detail.code === 'AI_TIMEOUT', timedOut: detail.code === 'AI_TIMEOUT', canceled }
  } finally {
    if (timer) clearTimeout(timer)
    if (opts.signal) opts.signal.removeEventListener('abort', onExternalAbort)
    local.abort()
  }
}

/** 并发批量生成；返回成功结果（不落库）。Abort 后不再启动新词，已成功结果保留。 */
export async function generateDerivationMapsBatch(
  items: DerivationBatchItem[],
  config: AiConfig,
  opts: DerivationBatchOptions = {},
): Promise<DerivationBatchResult> {
  const total = items.length
  const concurrency = clampConcurrency(opts.concurrency)
  const requestTimeoutMs = Math.max(1, Math.floor(opts.requestTimeoutMs ?? DERIVATION_BATCH_REQUEST_TIMEOUT_MS))
  const autoRetryTimeouts = opts.autoRetryTimeouts ?? DERIVATION_BATCH_AUTO_RETRY_TIMEOUTS
  const retryConcurrency = Math.min(4, Math.max(1, Math.floor(opts.retryConcurrency ?? Math.min(2, concurrency))))
  const succeeded: DerivationBatchResult['succeeded'] = []
  const failed: DerivationBatchFailure[] = []
  const skipped: DerivationBatchSkipped[] = []
  let done = 0
  let calls = 0
  let retried = 0
  const usage: TokenUsage = { input: 0, output: 0, total: 0 }
  let cursor = 0
  let stopped = false
  let inFlight = 0

  const progress = (wordId?: string, extra: Partial<DerivationBatchProgress> = {}) => {
    opts.onProgress?.({
      done,
      total,
      succeeded: succeeded.length,
      failed: failed.length,
      skipped: skipped.length,
      ...(wordId ? { wordId } : {}),
      ...extra,
    })
  }
  progress(undefined, { phase: 'main', inFlight: 0 })

  const recordSuccess = (item: DerivationBatchItem, result: DerivationMapResult): void => {
    succeeded.push({ wordId: item.wordId, result })
    usage.input += result.usage.input
    usage.output += result.usage.output
    usage.total += result.usage.total
  }

  const worker = async () => {
    while (true) {
      if (opts.signal?.aborted) {
        stopped = true
        return
      }
      const index = cursor
      cursor += 1
      if (index >= total) return
      const item = items[index]!
      if (opts.signal?.aborted) {
        stopped = true
        skipped.push({ wordId: item.wordId, reason: 'aborted' })
        done += 1
        progress(item.wordId, { phase: 'main', inFlight })
        return
      }
      try {
        calls += 1
        inFlight += 1
        const outcome = await attemptOne(item, config, opts, requestTimeoutMs)
        if (outcome.ok) {
          if (opts.signal?.aborted) {
            stopped = true
            skipped.push({ wordId: item.wordId, reason: 'aborted' })
          } else {
            if (opts.onSaved) await opts.onSaved(item.wordId, outcome.result)
            recordSuccess(item, outcome.result)
          }
        } else if (outcome.canceled) {
          stopped = true
          skipped.push({ wordId: item.wordId, reason: 'canceled' })
        } else {
          failed.push({ wordId: item.wordId, code: outcome.code, message: outcome.message, retryable: outcome.retryable })
        }
      } catch (err) {
        const detail = errorOf(err)
        if (opts.signal?.aborted) {
          stopped = true
          skipped.push({ wordId: item.wordId, reason: 'canceled' })
        } else {
          failed.push({ wordId: item.wordId, ...detail })
        }
      } finally {
        inFlight = Math.max(0, inFlight - 1)
        done += 1
        progress(item.wordId, { phase: 'main', inFlight })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()))

  // task-194：仅对 AI_TIMEOUT 失败项自动重试一次（不重试普通失败）
  if (!stopped && autoRetryTimeouts) {
    const timeoutFailures = failed.filter((entry) => entry.code === 'AI_TIMEOUT')
    if (timeoutFailures.length > 0) {
      retried = timeoutFailures.length
      const retryIds = new Set(timeoutFailures.map((entry) => entry.wordId))
      // 从 failed 中移除待重试项（重试仍失败会重新加入）
      const retryItems = items.filter((item) => retryIds.has(item.wordId))
      for (let i = failed.length - 1; i >= 0; i -= 1) {
        if (retryIds.has(failed[i]!.wordId)) failed.splice(i, 1)
      }
      let retryCursor = 0
      let retryDone = 0
      const retryWorker = async () => {
        while (true) {
          if (opts.signal?.aborted) {
            stopped = true
            return
          }
          const index = retryCursor
          retryCursor += 1
          if (index >= retryItems.length) return
          const item = retryItems[index]!
          try {
            calls += 1
            inFlight += 1
            const outcome = await attemptOne(item, config, opts, requestTimeoutMs)
            if (outcome.ok) {
              if (opts.onSaved) await opts.onSaved(item.wordId, outcome.result)
              recordSuccess(item, outcome.result)
            } else if (outcome.canceled) {
              stopped = true
              skipped.push({ wordId: item.wordId, reason: 'canceled' })
            } else {
              failed.push({
                wordId: item.wordId,
                code: outcome.code,
                message: outcome.timedOut ? `自动重试仍超时：${outcome.message}` : outcome.message,
                retryable: outcome.retryable,
              })
            }
          } catch (err) {
            const detail = errorOf(err)
            failed.push({ wordId: item.wordId, ...detail })
          } finally {
            inFlight = Math.max(0, inFlight - 1)
            retryDone += 1
            progress(item.wordId, { phase: 'retry', retryDone, retryTotal: retryItems.length, inFlight })
          }
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(retryConcurrency, retryItems.length) }, () => retryWorker()),
      )
      // 若 retry 阶段被 abort：剩余待重试项标 skipped
      if (stopped) {
        for (const item of retryItems.slice(retryCursor)) {
          if (!skipped.some((entry) => entry.wordId === item.wordId)) {
            skipped.push({ wordId: item.wordId, reason: 'aborted' })
          }
        }
      }
    }
  }

  // 未启动的剩余词在 abort 时标记 skipped，方便 UI 说明
  if (stopped) {
    for (const item of items.slice(cursor)) {
      if (!skipped.some((entry) => entry.wordId === item.wordId)) {
        skipped.push({ wordId: item.wordId, reason: 'aborted' })
      }
    }
    done = total
    progress(undefined, { phase: 'retry', inFlight: 0 })
  }
  return { total, succeeded, failed, skipped, stopped, usage, calls, retried }
}

export interface DerivationBatchCandidate {
  wordId: string
  deckId: string
  word: string
  meanings: Array<{ index: number; cn: string; pos?: string }>
  hasDerivationMap: boolean
}

export interface ListDerivationCandidatesOptions {
  deckId?: string
  /** 今日计划词（待复习+待新学）；与 deckId 二选一/可叠加 */
  today?: boolean
  /** 自定义候选词 id（如 UI 多选） */
  wordIds?: string[]
  /** 默认 false：排除已有 derivationMap 的词 */
  includeGenerated?: boolean
  limit?: number
}

export interface ListDerivationCandidatesResult {
  items: DerivationBatchCandidate[]
  total: number
  truncated: boolean
}

function toCandidate(word: Word): DerivationBatchCandidate {
  return {
    wordId: word.id,
    deckId: word.deckId,
    word: word.headword,
    meanings: word.meanings.map((meaning, index) => ({
      index: index + 1,
      cn: meaning.cn,
      ...(meaning.pos ? { pos: meaning.pos } : {}),
    })),
    hasDerivationMap: Boolean(
      word.derivationMap &&
        (word.derivationMap.rootLabel || word.derivationMap.text || word.derivationMap.mermaid),
    ),
  }
}

/**
 * 批量选词辅助：deck / 今日计划 / 自定义 wordIds；默认排除已有引申图；上限 200。
 */
export async function listDerivationBatchCandidates(
  opts: ListDerivationCandidatesOptions = {},
): Promise<ListDerivationCandidatesResult> {
  const db = getDb()
  let words: Word[] = []
  if (opts.wordIds && opts.wordIds.length > 0) {
    const rows = await db.words.bulkGet([...new Set(opts.wordIds)])
    words = rows.filter((word): word is Word => Boolean(word))
  } else if (opts.today) {
    const { getTodayPlan } = await import('../plans.repo')
    const plan = await getTodayPlan()
    const rows = await db.words.bulkGet(plan.wordIds)
    words = rows.filter((word): word is Word => Boolean(word))
  } else if (opts.deckId) {
    words = await db.words.where('deckId').equals(opts.deckId).toArray()
  } else {
    return { items: [], total: 0, truncated: false }
  }
  if (opts.deckId) words = words.filter((word) => word.deckId === opts.deckId)
  const candidates = words.map(toCandidate)
  const filtered = opts.includeGenerated
    ? candidates
    : candidates.filter((candidate) => !candidate.hasDerivationMap)
  const limit = Math.min(DERIVATION_BATCH_MAX_ITEMS, Math.max(1, Math.floor(opts.limit ?? DERIVATION_BATCH_MAX_ITEMS)))
  return {
    items: filtered.slice(0, limit),
    total: filtered.length,
    truncated: filtered.length > limit,
  }
}
