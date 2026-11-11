/**
 * AI 批量生成（task-70）：严格 JSON + zod 校验 + 修复重试 + 429 退避 + 取消 + 成本上限。
 *
 * 证据/规格：docs/ARCH-CONTENT-PACKS.md §6；输出格式 momo-pack v1（docs/SPEC-CONTENT-PACKS.md §2）。
 * 安全：错误信息/返回值中不包含 apiKey；模型原文只保留脱敏后的短片段（≤500 字）。
 */

import { z } from 'zod'
import { normalizeHeadword } from '../../core'
import { estimateBatchCost, estimateCost, addUsage, emptyUsage } from './cost'
import {
  CONTENT_LIMITS,
  PROMPT_VERSION,
  buildRepairPrompt,
  buildSemanticsRepairPromptV3,
  buildSystemPrompt,
  buildSystemPromptV3,
  buildUserPrompt,
  buildUserPromptV3,
} from './prompts'
import { createLlmProvider, AiRequestError, sanitizeSnippet } from './provider'
import type { LlmProvider } from './provider'
import type { AiHttpClient } from './transport'
import type {
  AiConfig,
  AiError,
  AiErrorCode,
  GenerateRequest,
  GenerateResponse,
  GenerateResult,
  GenerateTarget,
  GenerationKind,
  PackExample,
  PackItemV1,
  PackMnemonic,
  PackPhrase,
  SingleContentKind,
  TokenUsage,
} from './types'
import { targetKey } from './types'

/** 并发上限（ARCH §6：3） */
export const MAX_CONCURRENCY = 3
/** 429 退避：1s/2s/4s，最多 3 次重试 */
export const RATE_LIMIT_BACKOFF_MS = [1_000, 2_000, 4_000] as const
/** 5xx/网络：最多 2 次重试，退避 500/1000ms */
export const SERVER_BACKOFF_MS = [500, 1_000] as const
/** 解析失败修复重试：最多 2 次（Lead task-70 要求；ARCH 原写 1 次） */
export const MAX_REPAIR_RETRIES = 2
/** 模型原文片段上限（调试用） */
const RAW_SNIPPET_MAX = 500

/** zod：模型返回的 JSON（momo-pack 条目子集） */
export const packExampleSchema = z.object({
  en: z.string().min(1).max(300),
  cn: z.string().min(1).max(300),
})

export const packPhraseSchema = z.object({
  en: z.string().min(1).max(160),
  cn: z.string().min(1).max(160),
  meaningIndex: z.number().int().min(1).max(9999).optional(),
})

export const packMnemonicSchema = z.object({
  type: z.enum(['root', 'assoc', 'story']),
  text: z.string().min(1).max(200),
})

export const packItemSchema = z.object({
  headword: z.string().min(1).max(120),
  headwordLower: z.string().min(1).max(120).optional(),
  meaningIndex: z.number().int().min(1).max(9999).optional(),
  examples: z.array(packExampleSchema).max(6).optional(),
  phrases: z.array(packPhraseSchema).max(8).optional(),
  mnemonics: z.array(packMnemonicSchema).max(3).optional(),
})

export const packItemsResponseSchema = z.object({
  items: z.array(packItemSchema).max(200),
})

export type PackItemsResponse = z.infer<typeof packItemsResponseSchema>

/** 修复重试用 sleep（测试注入，避免真实等待） */
export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>

export interface GenerateDeps {
  /** 注入 provider（测试/CLI）；不传则按 config 构造 */
  provider?: LlmProvider
  /** 注入 HTTP client（构造 provider 用） */
  http?: AiHttpClient
  fetchImpl?: typeof fetch
  /** 注入 sleep（测试用；默认 setTimeout） */
  sleep?: SleepFn
  /** 并发上限（默认 3；测试可调小） */
  maxConcurrency?: number
  /** 修复重试上限（默认 MAX_REPAIR_RETRIES） */
  maxRepairRetries?: number
  /** 429/5xx 退避序列（测试可注入 [0,0,...]） */
  rateLimitBackoffMs?: readonly number[]
  serverBackoffMs?: readonly number[]
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function makeAiError(
  code: AiErrorCode,
  message: string,
  extra: Omit<AiError, 'code' | 'message'> = {},
): AiError {
  return { code, message, ...extra }
}

/**
 * 去掉 Markdown 代码围栏（jsonMode=false 时部分模型会用 ```json 包裹输出）。
 * 容错：完整围栏 / 只有开头围栏 / 只有结尾围栏。
 */
export function stripCodeFence(text: string): string {
  const raw = String(text ?? '').trim()
  if (!raw) return ''
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw)
  if (fenced) return fenced[1]!.trim()
  return raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim()
}

/** 从模型文本抽取 JSON（允许 ```json 围栏/前后解释） */
export function extractJsonObject(text: string): { json?: unknown; error?: string } {
  const candidate = stripCodeFence(text)
  if (!candidate) return { error: '空响应' }
  const first = candidate.indexOf('{')
  const last = candidate.lastIndexOf('}')
  if (first < 0 || last <= first) return { error: '未找到 JSON 对象' }
  const slice = candidate.slice(first, last + 1)
  try {
    return { json: JSON.parse(slice) }
  } catch (error) {
    return { error: `JSON.parse 失败：${(error as Error).message.slice(0, 120)}` }
  }
}

function dedupeExamples(items: PackExample[]): PackExample[] {
  const seen = new Set<string>()
  const out: PackExample[] = []
  for (const ex of items) {
    const k = ex.en.trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push({ en: ex.en.trim(), cn: ex.cn.trim() })
  }
  return out
}

function dedupePhrases(items: PackPhrase[]): PackPhrase[] {
  const seen = new Set<string>()
  const out: PackPhrase[] = []
  for (const ph of items) {
    const k = ph.en.trim().toLowerCase()
    if (!k || seen.has(k)) continue
    seen.add(k)
    const next: PackPhrase = { en: ph.en.trim(), cn: ph.cn.trim() }
    if (ph.meaningIndex != null) next.meaningIndex = ph.meaningIndex
    out.push(next)
  }
  return out
}

function dedupeMnemonics(items: PackMnemonic[]): PackMnemonic[] {
  const seen = new Set<string>()
  const out: PackMnemonic[] = []
  for (const m of items) {
    const text = m.text.trim().replace(/\s+/g, ' ').slice(0, 60)
    const k = text.toLowerCase()
    if (!text || seen.has(k)) continue
    seen.add(k)
    out.push({ type: m.type, text })
  }
  return out
}

/**
 * 校验 + 语义过滤 + 截断 + 去重（供 generate 与单测直接使用）。
 * 返回按 targetKey 聚合的条目（只保留输入 targets 之内的词/含义）。
 */
export function validateGeneratedItems(input: {
  json: unknown
  kind: SingleContentKind
  targets: GenerateTarget[]
  limits?: Partial<Record<SingleContentKind, number>>
}): { byKey: Map<string, PackItemV1>; error?: string } {
  const parsed = packItemsResponseSchema.safeParse(input.json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { byKey: new Map(), error: `schema 校验失败：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim() }
  }
  const limit = Math.max(1, Math.floor(input.limits?.[input.kind] ?? CONTENT_LIMITS[input.kind]))

  const targetsByLower = new Map<string, GenerateTarget>()
  const targetByKey = new Map<string, GenerateTarget>()
  for (const t of input.targets) {
    targetsByLower.set(t.headwordLower, t)
    targetByKey.set(targetKey(t.headwordLower, t.meaningIndex), t)
  }

  const merged = new Map<string, PackItemV1>()
  for (const raw of parsed.data.items) {
    const lower = normalizeHeadword(raw.headwordLower ?? raw.headword)
    const baseTarget = targetsByLower.get(lower)
    if (!baseTarget) continue // 只保留输入集合内的 headword
    const maxMeanings = Math.max(1, baseTarget.meanings.length)
    // 含义下标：条目级优先；**越界丢弃该条目**（SPEC-CONTENT-PACKS §2.2）
    const meaningIndex = raw.meaningIndex
    if (meaningIndex != null && (meaningIndex < 1 || meaningIndex > maxMeanings)) continue
    let target: GenerateTarget | undefined
    if (meaningIndex != null) target = targetByKey.get(targetKey(lower, meaningIndex))
    // 词级目标（未限定含义）允许接收任意合法 meaningIndex 的条目
    if (!target && baseTarget.meaningIndex == null) target = baseTarget
    if (!target) continue // 目标限定了含义，模型给了别的含义 → 丢弃
    const key = targetKey(target.headwordLower, target.meaningIndex)
    const acc: PackItemV1 =
      merged.get(key) ?? {
        headword: target.headword,
        headwordLower: target.headwordLower,
        ...(target.meaningIndex != null ? { meaningIndex: target.meaningIndex } : {}),
      }

    if (input.kind === 'examples' && raw.examples?.length) {
      acc.examples = dedupeExamples([...(acc.examples ?? []), ...raw.examples]).slice(0, limit)
    }
    if (input.kind === 'phrases' && raw.phrases?.length) {
      const valid: PackPhrase[] = []
      for (const ph of raw.phrases) {
        const idx = ph.meaningIndex ?? meaningIndex ?? target.meaningIndex
        if (idx != null && (idx < 1 || idx > maxMeanings)) continue
        valid.push(idx != null ? { ...ph, meaningIndex: idx } : ph)
      }
      acc.phrases = dedupePhrases([...(acc.phrases ?? []), ...valid]).slice(0, limit)
    }
    if (input.kind === 'mnemonics' && raw.mnemonics?.length) {
      acc.mnemonics = dedupeMnemonics([...(acc.mnemonics ?? []), ...raw.mnemonics]).slice(0, limit)
    }
    const hasContent =
      (acc.examples?.length ?? 0) + (acc.phrases?.length ?? 0) + (acc.mnemonics?.length ?? 0) > 0
    if (hasContent) merged.set(key, acc)
  }
  return { byKey: merged }
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  const s = Math.max(1, Math.floor(size))
  for (let i = 0; i < items.length; i += s) out.push(items.slice(i, i + s))
  return out
}

/** 简单 worker pool（并发上限） */
async function runPool<T>(items: readonly T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0
  const runners = Math.max(1, Math.min(limit, items.length))
  await Promise.all(
    Array.from({ length: runners }, async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        await worker(items[index]!, index)
      }
    }),
  )
}

/**
 * 批量生成（对外主入口）。
 *
 * - 批大小 `config.batchSize`（1–50）；并发 ≤3；
 * - 严格 JSON + zod 校验；解析失败修复重试 ≤2 次；
 * - 429 指数退避（1/2/4s，最多 3 次）；5xx/网络重试 2 次；401/403/402 直接分类；
 * - `maxCostPerRun>0` 时每批前预估，超预算停止并返回 `AI_COST_LIMIT`（已生成结果保留）；
 * - 取消（AbortSignal）返回 `canceled:true`，后续目标标 `AI_CANCELED`。
 */

import {
  aggregateSemanticsLabels,
  selfMeaningSemanticsItem,
} from './semantics'
// ============ 批量生成主入口 ============

/**
 * 量生成（对外主入口；task-70 + task-76 semantics）：
 * - kind='semantics'：只对 ≥2 含义的词调模型；单含义词短路返回自身映射（不调模型/不计成本）；
 * - 其它 kind：批大小 `config.batchSize`（1–50）；并发 ≤3；
 * - 严格 JSON + zod 校验；解析/映射失败修复重试 ≤2 次；429 退避（1/2/4s，最多 3 次）；5xx/网络 2 次；
 * - `maxCostPerRun>0` 每批前预估，超预算停止并返回 `AI_COST_LIMIT`（已生成结果保留）；
 * - 取消（AbortSignal）返回 `canceled:true`，后续目标标 `AI_CANCELED`。
 */
export async function generateItems(req: GenerateRequest, deps: GenerateDeps = {}): Promise<GenerateResponse> {
  const cfg: AiConfig = req.config
  const kind: GenerationKind = req.kind
  const targets = req.targets
  const results: Array<GenerateResult | undefined> = new Array(targets.length)
  let usage: TokenUsage = emptyUsage()
  let costYuan = 0
  let canceled = false
  let costLimitHit = false
  let doneCount = 0

  if (targets.length === 0) return { results: [], usage, costYuan: 0, canceled: false }

  // semantics：单含义词短路（不调模型、不计成本）
  const workIndices: number[] = []
  targets.forEach((target, index) => {
    if (kind === 'semantics' && target.meanings.length < 2) {
      results[index] = { target, item: selfMeaningSemanticsItem(target) }
    } else {
      workIndices.push(index)
    }
  })
  doneCount = targets.length - workIndices.length
  if (doneCount > 0) req.onProgress?.({ done: doneCount, total: targets.length, costYuan: 0 })

  const failWork = (code: AiErrorCode, message: string): void => {
    for (const index of workIndices) {
      results[index] = { target: targets[index]!, error: makeAiError(code, message) }
    }
  }

  if (workIndices.length > 0 && !cfg.apiKey) {
    failWork('AI_NO_KEY', '未配置 AI API Key')
    return { results: results as GenerateResult[], usage, costYuan: 0, canceled: false }
  }

  const provider = deps.provider ?? createLlmProvider({ http: deps.http, fetchImpl: deps.fetchImpl })
  const sleep = deps.sleep ?? defaultSleep
  const rateBackoff = deps.rateLimitBackoffMs ?? RATE_LIMIT_BACKOFF_MS
  const serverBackoff = deps.serverBackoffMs ?? SERVER_BACKOFF_MS
  const maxRepair = Math.max(0, deps.maxRepairRetries ?? MAX_REPAIR_RETRIES)
  const batchSize = Math.min(50, Math.max(1, Math.floor(cfg.batchSize || 20)))
  const workTargets = workIndices.map((i) => targets[i]!)
  const batches = chunk(workTargets, batchSize)

  const generateBatch = async (batch: GenerateTarget[], workStart: number): Promise<void> => {
    const originalIndices = workIndices.slice(workStart, workStart + batch.length)
    const markAll = (
      code: AiErrorCode,
      message: string,
      extra: { raw?: string; usage?: TokenUsage } = {},
    ): void => {
      originalIndices.forEach((originalIndex) => {
        results[originalIndex] = {
          target: targets[originalIndex]!,
          error: makeAiError(code, message),
          ...(extra.raw ? { raw: extra.raw } : {}),
          ...(extra.usage ? { usage: extra.usage } : {}),
        }
      })
    }
    if (canceled) {
      markAll('AI_CANCELED', '已取消')
      return
    }
    if (costLimitHit) {
      markAll('AI_COST_LIMIT', `已达单次成本上限 ¥${cfg.maxCostPerRun}，已停止`)
      return
    }
    if (req.signal?.aborted) {
      canceled = true
      markAll('AI_CANCELED', '已取消')
      return
    }
    if (cfg.maxCostPerRun > 0) {
      const estimate = estimateBatchCost({ kind, targets: batch.length, model: cfg.model })
      if (costYuan + estimate > cfg.maxCostPerRun) {
        costLimitHit = true
        markAll('AI_COST_LIMIT', `已达单次成本上限 ¥${cfg.maxCostPerRun}，已停止`)
        return
      }
    }

    const systemPrompt = kind === 'semantics' ? buildSystemPromptV3() : buildSystemPrompt()
    const userPrompt = kind === 'semantics' ? buildUserPromptV3(batch) : buildUserPrompt({ kind: kind as SingleContentKind, targets: batch })
    let messages: Array<{ role: 'system' | 'user'; content: string }> = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]
    let repair = 0
    let rateRetries = 0
    let serverRetries = 0

    for (;;) {
      if (req.signal?.aborted) {
        canceled = true
        markAll('AI_CANCELED', '已取消')
        return
      }
      try {
        const res = await provider.chat(
          { messages, temperature: cfg.temperature },
          cfg,
          req.signal ?? new AbortController().signal,
        )
        usage = addUsage(usage, res.usage)
        costYuan += estimateCost(res.usage, cfg.model)

        const extracted = extractJsonObject(res.text)
        const validation = extracted.json
          ? kind === 'semantics'
            ? aggregateSemanticsLabels({ json: extracted.json, targets: batch })
            : validateGeneratedItems({ json: extracted.json, kind: kind as SingleContentKind, targets: batch })
          : { byKey: new Map<string, PackItemV1>(), error: extracted.error ?? '解析失败' }
        const parseError = 'error' in validation ? validation.error : undefined

        if (parseError) {
          if (repair >= maxRepair) {
            markAll('AI_FORMAT', `模型输出格式错误：${sanitizeSnippet(parseError)}`, {
              raw: sanitizeSnippet(res.text).slice(0, RAW_SNIPPET_MAX),
              usage: res.usage,
            })
            return
          }
          repair += 1
          const repairUser =
            kind === 'semantics'
              ? buildSemanticsRepairPromptV3(userPrompt, parseError)
              : buildRepairPrompt(userPrompt, parseError)
          messages = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: repairUser },
          ]
          continue
        }

        const rawSnippet = sanitizeSnippet(res.text).slice(0, RAW_SNIPPET_MAX)
        batch.forEach((target, offset) => {
          const key = targetKey(target.headwordLower, target.meaningIndex)
          const item = validation.byKey.get(key)
          results[originalIndices[offset]!] = item
            ? { target, item, raw: rawSnippet, usage: res.usage }
            : {
                target,
                error: makeAiError('AI_EMPTY', '模型未返回该词的有效内容', { targetKey: key }),
                raw: rawSnippet,
                usage: res.usage,
              }
        })
        return
      } catch (error) {
        if (error instanceof AiRequestError) {
          if (error.code === 'AI_CANCELED') {
            canceled = true
            markAll('AI_CANCELED', '已取消')
            return
          }
          if (error.code === 'AI_RATE_LIMIT' && rateRetries < rateBackoff.length) {
            const delay = rateBackoff[rateRetries] ?? 0
            rateRetries += 1
            try {
              await sleep(delay, req.signal)
            } catch {
              canceled = true
              markAll('AI_CANCELED', '已取消')
              return
            }
            continue
          }
          if ((error.code === 'AI_NETWORK' || error.code === 'AI_TIMEOUT') && serverRetries < serverBackoff.length) {
            const delay = serverBackoff[serverRetries] ?? 0
            serverRetries += 1
            try {
              await sleep(delay, req.signal)
            } catch {
              canceled = true
              markAll('AI_CANCELED', '已取消')
              return
            }
            continue
          }
          markAll(error.code, sanitizeSnippet(error.message))
          return
        }
        markAll('AI_UNKNOWN', sanitizeSnippet((error as Error)?.message ?? 'AI 调用失败'))
        return
      }
    }
  }

  await runPool(batches, deps.maxConcurrency ?? MAX_CONCURRENCY, async (batch, index) => {
    await generateBatch(batch, index * batchSize)
    doneCount = Math.min(targets.length, doneCount + batch.length)
    req.onProgress?.({ done: doneCount, total: targets.length, costYuan })
  })

  for (let i = 0; i < results.length; i += 1) {
    if (!results[i]) results[i] = { target: targets[i]!, error: makeAiError('AI_UNKNOWN', '未执行') }
  }

  return {
    results: results as GenerateResult[],
    usage,
    costYuan: Math.round(costYuan * 1e6) / 1e6,
    canceled,
  }
}

export { PROMPT_VERSION }


// ============ semantics 兼容 re-export（实现在 ./semantics，纯模块供 CLI 共用） ============
export {
  aggregateSemanticsLabels,
  coreSenseSchema,
  meaningMapEntrySchema,
  normalizeCoreSenseLabel,
  selfMeaningSemanticsItem,
  semanticsItemSchema,
  semanticsMeaningEntrySchema,
  semanticsMeaningItemSchema,
  semanticsMeaningsResponseSchema,
  semanticsResponseSchema,
  validateSemanticsItems,
} from './semantics'
export type {
  SemanticsAggregateResult,
  SemanticsMeaningEntry,
  SemanticsMeaningItem,
  SemanticsValidateTarget,
} from './semantics'
