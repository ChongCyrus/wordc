/** 0.4.1：多对象协议类型适配器 + 统一批量任务（生成/回退/任务持久化） */
import type { AiConfig, GenerateTarget, TokenUsage } from './types'
import type { PackItemV1 } from '../packs/schema'
import type { LlmProvider } from './provider'
import { generateItems, validateGeneratedItems } from './generate'
import { generateRootEtymology } from './root-etymology'
import { generateDerivationMap, validateDerivationMapDraft } from './derivation-map'
import { generateRareMeanings, validateRareMeaningsDraft, validateRareCoreSenseDraft } from './rare-meanings'
import { validateSemanticsV4Items } from './semantics'
import { estimateCost } from './cost'
import { generateCoreSenseExamples } from './core-sense-content'
import { generateCoreSenseOverview, validateCoreSenseOverviewDraft } from './core-sense-overview'
import { validateRootEtymologyDraft } from '../root-etymology'
import {
  generateMultiObject,
  chunkMultiObjectSources,
  type MultiObjectKind,
  type MultiObjectSource,
  type MultiObjectItem,
} from './multi-object'
import {
  appendGenerationJobFailed,
  appendGenerationJobResult,
  getGenerationJob,
  updateGenerationJob,
} from '../generation-jobs'

export type MultiObjectAdapterKind =
  | 'examples'
  | 'phrases'
  | 'mnemonics'
  | 'root-etymology'
  | 'derivation'
  | 'rare-meanings'
  | 'semantics'
  | 'core-sense'
  | 'overview'
  | 'meaning-mnemonic'

export interface MultiObjectAdapterDeps {
  provider?: LlmProvider
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  config: AiConfig
}

export interface MultiObjectAdapter {
  validateItem: (raw: unknown, source: MultiObjectSource) => unknown
  fallbackSingle: (source: MultiObjectSource, signal: AbortSignal, deps: MultiObjectAdapterDeps) => Promise<unknown>
}

function targetOf(source: MultiObjectSource): GenerateTarget {
  const context = source.context ?? {}
  const target = context.target as GenerateTarget | undefined
  if (target) return target
  const meanings = Array.isArray(context.meanings)
    ? (context.meanings as Array<{ id?: string; cn?: string; pos?: string }>).map((meaning, index) => ({
        id: meaning.id ?? `m${index + 1}`,
        cn: meaning.cn ?? '',
        ...(meaning.pos ? { pos: meaning.pos } : {}),
      }))
    : []
  return {
    wordId: source.wordId,
    headword: source.headword,
    headwordLower: source.headword.toLowerCase(),
    meanings,
    existing: { examples: 0, phrases: 0, mnemonics: 0 },
  }
}

function validatePackItem(kind: 'examples' | 'phrases' | 'mnemonics', raw: unknown, source: MultiObjectSource): PackItemV1 {
  const target = targetOf(source)
  const json = { items: [{ ...(raw as Record<string, unknown>), headword: source.headword, headwordLower: source.headword.toLowerCase() }] }
  const result = validateGeneratedItems({ json, kind, targets: [target] })
  if (result.error) throw new Error(result.error)
  const item = [...result.byKey.values()][0]
  if (!item) throw new Error(`多对象 ${kind} 条目为空或与目标不匹配`)
  return item
}

async function fallbackPackItem(
  kind: 'examples' | 'phrases' | 'mnemonics',
  source: MultiObjectSource,
  config: AiConfig,
  signal: AbortSignal,
  deps: MultiObjectAdapterDeps,
): Promise<PackItemV1> {
  const target = targetOf(source)
  const response = await generateItems(
    { kind, targets: [target], config, signal },
    { ...(deps.provider ? { provider: deps.provider } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
  )
  const first = response.results.find((result) => result.item)?.item
  if (!first) throw new Error(`${kind} 单对象回退未生成内容：${JSON.stringify(response.results.map((result) => result.error ?? null))}`)
  return first
}

function meaningsOf(source: MultiObjectSource): Array<{ index: number; cn: string; pos?: string }> {
  const context = source.context ?? {}
  return Array.isArray(context.meanings)
    ? (context.meanings as Array<{ cn?: string; pos?: string }>).map((meaning, index) => ({
        index: index + 1,
        cn: meaning.cn ?? '',
        ...(meaning.pos ? { pos: meaning.pos } : {}),
      }))
    : []
}

function coreSensesOf(source: MultiObjectSource): Array<{ index: number; label: string }> {
  const context = source.context ?? {}
  return Array.isArray(context.coreSenses)
    ? (context.coreSenses as Array<{ index?: number; label?: string }>).map((sense, index) => ({
        index: sense.index ?? index + 1,
        label: sense.label ?? '',
      }))
    : []
}

/** 词级类型适配器：examples / mnemonics / phrases / root-etymology / derivation / rare-meanings */
export const MULTI_OBJECT_ADAPTERS: Record<MultiObjectAdapterKind, MultiObjectAdapter> = {
  examples: {
    validateItem: (raw, source) => validatePackItem('examples', raw, source),
    fallbackSingle: async (source, signal, deps) => fallbackPackItem('examples', source, deps.config, signal, deps),
  },
  phrases: {
    validateItem: (raw, source) => validatePackItem('phrases', raw, source),
    fallbackSingle: async (source, signal, deps) => fallbackPackItem('phrases', source, deps.config, signal, deps),
  },
  mnemonics: {
    validateItem: (raw, source) => validatePackItem('mnemonics', raw, source),
    fallbackSingle: async (source, signal, deps) => fallbackPackItem('mnemonics', source, deps.config, signal, deps),
  },
  derivation: {
    validateItem: (raw) => validateDerivationMapDraft(raw),
    fallbackSingle: async (source, signal, deps) => {
      const meanings = meaningsOf(source)
      const result = await generateDerivationMap(
        { word: source.headword, meanings },
        deps.config,
        {
          signal,
          ...(deps.provider ? { provider: deps.provider } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        },
      )
      return result
    },
  },
  'rare-meanings': {
    validateItem: (raw, source) => {
      const count = Math.max(1, meaningsOf(source).length)
      const rareMeaningIndexes = validateRareMeaningsDraft(raw, count)
      const coreSenses = coreSensesOf(source)
      const rareCoreSenseIndexes =
        coreSenses.length > 0 ? validateRareCoreSenseDraft(raw, coreSenses.length) : undefined
      return {
        rareMeaningIndexes,
        ...(rareCoreSenseIndexes ? { rareCoreSenseIndexes } : {}),
      }
    },
    fallbackSingle: async (source, signal, deps) => {
      const meanings = meaningsOf(source)
      const coreSenses = coreSensesOf(source)
      const result = await generateRareMeanings(
        {
          word: source.headword,
          wordId: source.wordId,
          meanings,
          ...(coreSenses.length > 0 ? { coreSenses } : {}),
        },
        deps.config,
        {
          signal,
          markCoreSenses: coreSenses.length > 0,
          ...(deps.provider ? { provider: deps.provider } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        },
      )
      return {
        rareMeaningIndexes: result.rareMeaningIndexes,
        ...(result.rareCoreSenseIndexes ? { rareCoreSenseIndexes: result.rareCoreSenseIndexes } : {}),
      }
    },
  },
  semantics: {
    validateItem: (raw, source) => {
      const target = targetOf(source)
      const row = { ...(raw as Record<string, unknown>), headword: source.headword, headwordLower: source.headword.toLowerCase() }
      const result = validateSemanticsV4Items({
        json: { items: [row] },
        targets: [{ headword: source.headword, headwordLower: source.headword.toLowerCase(), meanings: target.meanings }],
      })
      const item = [...result.byKey.values()][0]
      if (!item) throw new Error(result.errors[0] ?? '语义结构条目为空')
      return item
    },
    fallbackSingle: async (source, signal, deps) => {
      const response = await generateItems(
        { kind: 'semantics', targets: [targetOf(source)], config: deps.config, signal },
        { ...(deps.provider ? { provider: deps.provider } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
      )
      const item = response.results.find((result) => result.item)?.item
      if (!item) throw new Error('semantics 单对象回退未生成内容')
      return item
    },
  },
  'meaning-mnemonic': {
    validateItem: (raw, source) => validatePackItem('mnemonics', raw, source),
    fallbackSingle: async (source, signal, deps) => {
      const target = targetOf(source)
      const meaningTarget = { ...target, meaningIndex: Number(source.context?.meaningIndex ?? 1) }
      const response = await generateItems(
        { kind: 'mnemonics', targets: [{ ...meaningTarget, meaningIndex: meaningTarget.meaningIndex }], config: deps.config, signal },
        { ...(deps.provider ? { provider: deps.provider } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
      )
      const item = response.results.find((result) => result.item)?.item
      if (!item) throw new Error('meaning-mnemonic 单对象回退未生成内容')
      return item
    },
  },
  'core-sense': {
    validateItem: (raw) => {
      const examples = (raw as { examples?: unknown }).examples
      if (!Array.isArray(examples) || examples.length === 0) throw new Error('core-sense 缺少 examples')
      const list = examples
        .map((entry) => entry as { en?: unknown; cn?: unknown })
        .filter((entry) => typeof entry.en === 'string' && entry.en.trim() && typeof entry.cn === 'string' && entry.cn.trim())
      if (list.length === 0) throw new Error('core-sense examples 为空')
      return { examples: list.map((entry) => ({ en: String(entry.en), cn: String(entry.cn) })) }
    },
    fallbackSingle: async (source, signal, deps) => {
      const contexts = (source.context?.meanings as Array<{ cn?: string; pos?: string }> | undefined) ?? []
      return generateCoreSenseExamples(
        {
          word: source.headword,
          label: String(source.context?.coreSenseLabel ?? '本义'),
          ...(typeof source.context?.coreSenseIndex === 'number' ? { coreSenseIndex: source.context.coreSenseIndex } : {}),
          mappedMeanings: contexts.map((meaning, index) => ({ meaningIndex: index + 1, cn: meaning.cn ?? '', ...(meaning.pos ? { pos: meaning.pos } : {}) })),
          count: 2,
        },
        deps.config,
        { signal, ...(deps.provider ? { provider: deps.provider } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
      )
    },
  },
  overview: {
    validateItem: (raw) => ({ text: validateCoreSenseOverviewDraft(raw) }),
    fallbackSingle: async (source, signal, deps) => {
      const coreSenses = coreSensesOf(source)
      const text = await generateCoreSenseOverview(
        {
          word: source.headword,
          coreSenses: coreSenses.map((sense) => ({ index: sense.index, label: sense.label })),
          mappedMeanings: [],
        },
        deps.config,
        { signal, ...(deps.provider ? { provider: deps.provider } : {}), ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) },
      )
      return { text }
    },
  },
  'root-etymology': {
    validateItem: (raw) => validateRootEtymologyDraft(raw),
    fallbackSingle: async (source, signal, deps) => {
      const context = source.context ?? {}
      const result = await generateRootEtymology(
        {
          wordId: source.wordId,
          headword: source.headword,
          meanings: Array.isArray(context.meanings) ? (context.meanings as Array<{ cn: string; pos?: string }>) : [],
          ...(Array.isArray(context.coreSenses)
            ? { coreSenses: context.coreSenses as Array<{ index: number; label: string }> }
            : {}),
        },
        deps.config,
        {
          signal,
          ...(deps.provider ? { provider: deps.provider } : {}),
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
        },
      )
      return result.draft
    },
  },
}

export interface RunMultiObjectGenerationOptions {
  kind: MultiObjectAdapterKind
  sources: MultiObjectSource[]
  config: AiConfig
  batchSize?: number
  jobId?: string
  /** 0.6.0：并发 1–8（默认 2） */
  concurrency?: number
  deps?: Omit<MultiObjectAdapterDeps, 'config'> & { signal?: AbortSignal }
}

export interface RunMultiObjectGenerationResult {
  items: MultiObjectItem<unknown>[]
  usage: TokenUsage
  costYuan: number
  fallbackCount: number
  batches: number
  jobId?: string
}

/** 统一批量：按 batchSize 切 chunk，缺失/错误回退，结果/失败写 generationJob */
export async function runMultiObjectGeneration(opts: RunMultiObjectGenerationOptions): Promise<RunMultiObjectGenerationResult> {
  const adapter = MULTI_OBJECT_ADAPTERS[opts.kind]
  if (!adapter) throw new Error(`暂不支持的多对象类型：${opts.kind}`)
  const batchSize = Math.max(1, Math.min(50, Math.floor(opts.batchSize ?? 5)))
  const concurrency = Math.max(1, Math.min(8, Math.floor(opts.concurrency ?? 2)))
  // 0.6.2：续跑时 sources 可能是「剩余 targets」；cursor 必须是绝对索引，
  // results 必须按 wordId 去重，不能把旧结果再次 append。
  const existingJob = opts.jobId ? await getGenerationJob(opts.jobId) : null
  const initialCursor = existingJob?.cursor ?? 0
  const jobTargets = existingJob?.targets ?? []
  let sources = opts.sources
  if (jobTargets.length > 0 && initialCursor > 0 && sources.length > 0) {
    const remaining = jobTargets.slice(initialCursor)
    const remainingIds = new Set(remaining.map((target) => target.wordId))
    const sourceIds = new Set(sources.map((source) => source.wordId))
    // 若传入的是完整 targets（或包含已跑前缀），只用 remaining，避免重复跑/重复结果
    if (sources.length > remaining.length && remaining.every((target) => sourceIds.has(target.wordId))) {
      sources = remaining.map((target) => ({ wordId: target.wordId, headword: target.headword ?? '' }))
    } else {
      sources = sources.filter((source) => remainingIds.has(source.wordId))
    }
  }
  const chunks = chunkMultiObjectSources(sources, batchSize)
  const items: MultiObjectItem<unknown>[] = []
  let usage: TokenUsage = { input: 0, output: 0, total: 0 }
  let fallbackCount = 0
  let costYuan = 0
  let budgetStopped = false
  if (opts.jobId) {
    await updateGenerationJob(opts.jobId, {
      status: 'running',
      concurrency,
      cursor: initialCursor,
    })
  }
  const runChunk = async (chunk: MultiObjectSource[]) => {
    const chunkResult = await generateMultiObject(opts.kind, chunk, opts.config, {
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
    items.push(...chunkResult.items)
    fallbackCount += chunkResult.fallbackCount
    usage = {
      input: usage.input + chunkResult.usage.input,
      output: usage.output + chunkResult.usage.output,
      total: usage.total + chunkResult.usage.total,
    }
    costYuan = estimateCost(usage, opts.config.model)
    if (opts.config.maxCostPerRun > 0 && costYuan > opts.config.maxCostPerRun) {
      budgetStopped = true
      throw new Error(`AI_COST_LIMIT：本任务已用 ¥${costYuan.toFixed(3)}，超过上限 ¥${opts.config.maxCostPerRun.toFixed(3)}`)
    }
  }
  try {
    let cursor = 0
    const workers = Array.from({ length: Math.min(concurrency, Math.max(1, chunks.length)) }, async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= chunks.length) return
        await runChunk(chunks[index]!)
      }
    })
    await Promise.all(workers)
    if (opts.jobId) {
      const latest = (await getGenerationJob(opts.jobId)) ?? existingJob
      const seen = new Set((latest?.results ?? []).map((result) => result.wordId).filter((id): id is string => Boolean(id)))
      for (const item of items) {
        if (item.error) {
          await appendGenerationJobFailed(opts.jobId, { wordId: item.wordId, message: item.error })
        } else if (!seen.has(item.wordId)) {
          seen.add(item.wordId)
          await appendGenerationJobResult(opts.jobId, {
            wordId: item.wordId,
            headword: sources.find((source) => source.wordId === item.wordId)?.headword,
            kind: opts.kind,
            cursor: initialCursor + seen.size,
          })
        }
      }
      const processedIds = new Set(items.map((item) => item.wordId))
      const remainingIds = new Set(sources.map((source) => source.wordId))
      const allRemainingDone = [...remainingIds].every((id) => processedIds.has(id))
      const finalCursor =
        jobTargets.length > 0
          ? Math.min(jobTargets.length, allRemainingDone ? jobTargets.length : initialCursor + processedIds.size)
          : sources.length
      const failed = items.filter((item) => Boolean(item.error)).length
      await updateGenerationJob(opts.jobId, {
        status: failed === items.length && items.length > 0 ? 'failed' : 'completed',
        cursor: finalCursor,
        concurrency,
        batchSize,
        budget: { ...(opts.config.maxCostPerRun > 0 ? { maxCostPerRun: opts.config.maxCostPerRun } : {}), spentYuan: costYuan },
      })
    }
    return { items, usage, costYuan, fallbackCount, batches: chunks.length, ...(opts.jobId ? { jobId: opts.jobId } : {}) }
  } catch (error) {
    if (opts.jobId) {
      const canceled = opts.deps?.signal?.aborted === true
      await updateGenerationJob(opts.jobId, {
        status: canceled ? 'canceled' : budgetStopped ? 'paused' : 'failed',
        error: error instanceof Error ? error.message : String(error),
        cursor: initialCursor + new Set(items.map((item) => item.wordId)).size,
        concurrency,
        batchSize,
        budget: { ...(opts.config.maxCostPerRun > 0 ? { maxCostPerRun: opts.config.maxCostPerRun } : {}), spentYuan: costYuan },
      })
    }
    throw error
  }
}

/** 兼容：为后续补齐 types 留出口 */
export function getMultiObjectAdapter(kind: MultiObjectKind): MultiObjectAdapter | null {
  return MULTI_OBJECT_ADAPTERS[kind as MultiObjectAdapterKind] ?? null
}
