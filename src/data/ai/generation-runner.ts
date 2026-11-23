/** 0.6.2：多类型统一 runner——按 job.targets 的 kind 顺序处理全部目标，不在第一类型后提前完成 */
import type { AiConfig } from './types'
import type { LlmProvider } from './provider'
import type { MultiObjectSource, MultiObjectItem } from './multi-object'
import { generateMultiObject, chunkMultiObjectSources } from './multi-object'
import { MULTI_OBJECT_ADAPTERS, type MultiObjectAdapterKind } from './multi-object-adapters'
import { estimateCost } from './cost'
import { getDb } from '../db'
import { getEffectiveContent } from '../packs.repo'
import {
  appendGenerationJobFailed,
  appendGenerationJobResult,
  getGenerationJob,
  updateGenerationJob,
  type GenerationJob,
  type GenerationJobTarget,
} from '../generation-jobs'

export interface RunGenerationJobOptions {
  jobId: string
  config: AiConfig
  batchSize?: number
  concurrency?: number
  deps?: { provider?: LlmProvider; fetchImpl?: typeof fetch; signal?: AbortSignal }
}

export interface RunGenerationJobResult {
  items: Array<MultiObjectItem<unknown> & { kind: MultiObjectAdapterKind; targetKey: string }>
  usage: { input: number; output: number; total: number }
  costYuan: number
  fallbackCount: number
  processed: number
  total: number
  status: GenerationJob['status']
}

function targetKeyOf(kind: string, target: GenerationJobTarget): string {
  const context = target.context ?? {}
  if (target.targetKey) return target.targetKey
  const meaningIndex = typeof target.meaningIndex === 'number' ? target.meaningIndex : typeof context.meaningIndex === 'number' ? context.meaningIndex : undefined
  const coreSenseIndex =
    typeof target.coreSenseIndex === 'number' ? target.coreSenseIndex : typeof context.coreSenseIndex === 'number' ? context.coreSenseIndex : undefined
  const suffix = meaningIndex != null ? `#m${meaningIndex}` : coreSenseIndex != null ? `#c${coreSenseIndex}` : ''
  return `${kind}:${target.wordId}${suffix}`
}

async function buildSource(target: GenerationJobTarget, targetKey: string): Promise<MultiObjectSource> {
  const context: Record<string, unknown> = { ...(target.context ?? {}) }
  if (!Array.isArray(context.meanings) || !Array.isArray(context.coreSenses)) {
    try {
      const word = await getDb().words.get(target.wordId)
      if (word) {
        if (!Array.isArray(context.meanings)) context.meanings = word.meanings.map((meaning) => ({ id: meaning.id, cn: meaning.cn, pos: meaning.pos }))
        if (!Array.isArray(context.coreSenses)) {
          const effective = await getEffectiveContent(target.wordId).catch(() => null)
          context.coreSenses = effective?.coreSenses ?? []
        }
      }
    } catch {
      /* 缺上下文时由适配器兜底 */
    }
  }
  return { wordId: target.wordId, headword: target.headword ?? target.wordId, targetKey, context }
}

/**
 * 统一多类型 runner：
 * - 按 job.kinds / config.kinds / target.kind 顺序分组，处理全部 remaining targets；
 * - cursor 只在全部目标处理完后设为 targets.length；中途不 completed；
 * - results 按 targetKey（kind:wordId#meaning/core）去重，允许同词多类型；
 * - 预算超限 paused、取消 canceled、逐条失败 failed 记录。
 */
export async function runGenerationJob(opts: RunGenerationJobOptions): Promise<RunGenerationJobResult> {
  const job = await getGenerationJob(opts.jobId)
  if (!job) throw new Error(`生成任务不存在：${opts.jobId}`)
  const targets = job.targets ?? []
  const initialCursor = Math.max(0, Math.min(job.cursor, targets.length))
  const remaining = targets.slice(initialCursor)
  const configKinds = Array.isArray(job.config?.kinds) ? (job.config.kinds as string[]) : []
  const order: string[] = [...new Set([...configKinds, ...remaining.map((target) => target.kind ?? job.kind)])]
  const batchSize = Math.max(1, Math.min(50, Math.floor(opts.batchSize ?? job.batchSize ?? job.config?.batchSize as number ?? 5)))
  const concurrency = Math.max(1, Math.min(8, Math.floor(opts.concurrency ?? job.concurrency ?? 2)))
  await updateGenerationJob(job.id, { status: 'running', batchSize, concurrency, cursor: initialCursor })
  const items: RunGenerationJobResult['items'] = []
  let usage = { input: 0, output: 0, total: 0 }
  let costYuan = 0
  let fallbackCount = 0
  let processed = 0
  let paused = false
  let canceled = false
  const seen = new Set(
    (job.results ?? []).map((result) => result.targetKey ?? result.wordId ?? '').filter(Boolean),
  )
  const runKind = async (kind: string) => {
    const kindTargets = remaining.filter((target) => (target.kind ?? job.kind) === kind)
    if (kindTargets.length === 0) return
    const adapter = MULTI_OBJECT_ADAPTERS[kind as MultiObjectAdapterKind]
    if (!adapter) {
      for (const target of kindTargets) {
        await appendGenerationJobFailed(job.id, { wordId: target.wordId, message: `未知生成类型：${kind}` })
        processed += 1
      }
      return
    }
    const sources: MultiObjectSource[] = []
    const targetByKey = new Map<string, GenerationJobTarget>()
    for (const target of kindTargets) {
      const key = targetKeyOf(kind, target)
      targetByKey.set(key, target)
      sources.push(await buildSource(target, key))
    }
    const chunks = chunkMultiObjectSources(sources, batchSize)
    let cursor = 0
    const worker = async () => {
      while (true) {
        if (opts.deps?.signal?.aborted) {
          canceled = true
          return
        }
        const current = (await getGenerationJob(job.id))?.status
        if (current === 'paused') {
          paused = true
          return
        }
        const index = cursor
        cursor += 1
        if (index >= chunks.length) return
        const chunk = chunks[index]!
        const chunkResult = await generateMultiObject(kind as MultiObjectAdapterKind, chunk, opts.config, {
          ...(opts.deps?.provider ? { provider: opts.deps.provider } : {}),
          ...(opts.deps?.fetchImpl ? { fetchImpl: opts.deps.fetchImpl } : {}),
          ...(opts.deps?.signal ? { signal: opts.deps.signal } : {}),
          batchSize,
          validateItem: adapter.validateItem,
          fallbackSingle: (source, signal) =>
            adapter.fallbackSingle(source, signal, {
              ...(opts.deps ?? {}),
              config: opts.config,
            }),
        })
        fallbackCount += chunkResult.fallbackCount
        usage = {
          input: usage.input + chunkResult.usage.input,
          output: usage.output + chunkResult.usage.output,
          total: usage.total + chunkResult.usage.total,
        }
        costYuan = estimateCost(usage, opts.config.model)
        for (const item of chunkResult.items) {
          const targetKey = item.targetKey ?? `${kind}:${item.wordId}`
          const target = targetByKey.get(targetKey)
          items.push({ ...item, kind: kind as MultiObjectAdapterKind, targetKey })
          processed += 1
          if (item.error) {
            await appendGenerationJobFailed(job.id, { wordId: item.wordId, message: item.error, code: kind })
          } else if (!seen.has(targetKey)) {
            seen.add(targetKey)
            await appendGenerationJobResult(job.id, {
              wordId: item.wordId,
              headword: target?.headword,
              kind,
              result: { wordId: item.wordId, headword: target?.headword, kind, at: Date.now(), targetKey },
            })
          }
        }
        await updateGenerationJob(job.id, {
          cursor: Math.min(targets.length, initialCursor + processed),
          status: 'running',
        })
        if (opts.config.maxCostPerRun > 0 && costYuan > opts.config.maxCostPerRun) {
          throw new Error(`AI_COST_LIMIT：本任务已用 ¥${costYuan.toFixed(3)}，超过上限 ¥${opts.config.maxCostPerRun.toFixed(3)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()))
  }
  try {
    for (const kind of order) {
      if (paused || canceled) break
      await runKind(kind)
    }
    const failedCount = items.filter((item) => item.error).length
    const allDone = initialCursor + processed >= targets.length
    const status: GenerationJob['status'] = canceled
      ? 'canceled'
      : paused
        ? 'paused'
        : allDone
          ? failedCount === items.length && items.length > 0
            ? 'failed'
            : 'completed'
          : 'failed'
    await updateGenerationJob(job.id, {
      status,
      cursor: status === 'completed' || status === 'failed' ? targets.length : Math.min(targets.length, initialCursor + processed),
      batchSize,
      concurrency,
      budget: { ...(opts.config.maxCostPerRun > 0 ? { maxCostPerRun: opts.config.maxCostPerRun } : {}), spentYuan: costYuan },
    })
    return {
      items,
      usage,
      costYuan,
      fallbackCount,
      processed: status === 'completed' ? targets.length : initialCursor + processed,
      total: targets.length,
      status,
    }
  } catch (error) {
    const latest = await getGenerationJob(job.id)
    const pausedNow = latest?.status === 'paused'
    await updateGenerationJob(job.id, {
      status: pausedNow ? 'paused' : opts.deps?.signal?.aborted ? 'canceled' : 'failed',
      error: error instanceof Error ? error.message : String(error),
      cursor: Math.min(targets.length, initialCursor + processed),
      batchSize,
      concurrency,
      budget: { ...(opts.config.maxCostPerRun > 0 ? { maxCostPerRun: opts.config.maxCostPerRun } : {}), spentYuan: costYuan },
    })
    throw error
  }
}
