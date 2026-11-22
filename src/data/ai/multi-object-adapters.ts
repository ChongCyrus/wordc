/** 0.4.1：多对象协议类型适配器 + 统一批量任务（生成/回退/任务持久化） */
import type { AiConfig, GenerateTarget, TokenUsage } from './types'
import type { PackItemV1 } from '../packs/schema'
import type { LlmProvider } from './provider'
import { generateItems, validateGeneratedItems } from './generate'
import { generateRootEtymology } from './root-etymology'
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
  updateGenerationJob,
} from '../generation-jobs'

export type MultiObjectAdapterKind = 'examples' | 'phrases' | 'mnemonics' | 'root-etymology'

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

/** 3 类先行适配器：examples / mnemonics / phrases */
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
  concurrency?: number
  deps?: Omit<MultiObjectAdapterDeps, 'config'> & { signal?: AbortSignal }
}

export interface RunMultiObjectGenerationResult {
  items: MultiObjectItem<unknown>[]
  usage: TokenUsage
  fallbackCount: number
  batches: number
  jobId?: string
}

/** 统一批量：按 batchSize 切 chunk，缺失/错误回退，结果/失败写 generationJob */
export async function runMultiObjectGeneration(opts: RunMultiObjectGenerationOptions): Promise<RunMultiObjectGenerationResult> {
  const adapter = MULTI_OBJECT_ADAPTERS[opts.kind]
  if (!adapter) throw new Error(`暂不支持的多对象类型：${opts.kind}`)
  const batchSize = opts.batchSize ?? 5
  const chunks = chunkMultiObjectSources(opts.sources, batchSize)
  const items: MultiObjectItem<unknown>[] = []
  let usage: TokenUsage = { input: 0, output: 0, total: 0 }
  let fallbackCount = 0
  if (opts.jobId) await updateGenerationJob(opts.jobId, { status: 'running' })
  try {
    for (const chunk of chunks) {
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
      if (opts.jobId) {
        for (const item of chunkResult.items) {
          if (item.error) {
            await appendGenerationJobFailed(opts.jobId, { wordId: item.wordId, message: item.error })
          } else {
            await appendGenerationJobResult(opts.jobId, {
              wordId: item.wordId,
              headword: chunk.find((source) => source.wordId === item.wordId)?.headword,
              kind: opts.kind,
            })
          }
        }
      }
    }
    if (opts.jobId) {
      const failed = items.filter((item) => Boolean(item.error)).length
      await updateGenerationJob(opts.jobId, { status: failed === items.length && items.length > 0 ? 'failed' : 'completed', cursor: opts.sources.length })
    }
    return { items, usage, fallbackCount, batches: chunks.length, ...(opts.jobId ? { jobId: opts.jobId } : {}) }
  } catch (error) {
    if (opts.jobId) {
      await updateGenerationJob(opts.jobId, { status: 'failed', error: error instanceof Error ? error.message : String(error) })
    }
    throw error
  }
}

/** 兼容：为后续补齐 types 留出口 */
export function getMultiObjectAdapter(kind: MultiObjectKind): MultiObjectAdapter | null {
  return MULTI_OBJECT_ADAPTERS[kind as MultiObjectAdapterKind] ?? null
}
