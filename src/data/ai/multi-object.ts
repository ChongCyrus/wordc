/** 0.4.1/task-285：AI 单请求多对象协议（一次 N 个词；缺失/格式错误回退单词语义调用） */
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import type { AiConfig } from './types'

export const MULTI_OBJECT_DEFAULT_SIZE = 5
export const MULTI_OBJECT_MAX_SIZE = 20

export type MultiObjectKind =
  | 'examples'
  | 'phrases'
  | 'root-etymology'
  | 'derivation'
  | 'mnemonics'
  | 'core-sense'
  | 'overview'
  | 'semantics'
  | 'meaning-mnemonic'
  | 'rare-meanings'

export interface MultiObjectSource {
  wordId: string
  headword: string
  /** 0.6.3：目标级唯一键（同词多含义/本义必需）；缺省用 wordId */
  targetKey?: string
  /** 额外上下文（含义/本义/词性等） */
  context?: Record<string, unknown>
}

export interface MultiObjectItem<T = unknown> {
  wordId: string
  targetKey?: string
  payload?: T
  error?: string
  /** 是否走了单对象回退 */
  fallback?: boolean
}

export interface MultiObjectGenerateResult<T = unknown> {
  items: MultiObjectItem<T>[]
  usage: { input: number; output: number; total: number }
  batchSize: number
  fallbackCount: number
}

export type MultiObjectItemValidator<T> = (raw: unknown, source: MultiObjectSource) => T

const KIND_GUIDE: Record<MultiObjectKind, string> = {
  examples: '返回 {wordId, examples:[{en,cn}]}',
  phrases: '返回 {wordId, phrases:[{en,cn}]}',
  'root-etymology':
    '返回 {wordId, parts:[{type:"prefix|root|suffix|other",text,meaning}], etymology?, composition?}；每个 part 必须带 meaning',
  derivation: '返回 {wordId, items:[{rootLabel,rootMeaning?,lines:[{text,meaningIndexes}]}]}',
  mnemonics: '返回 {wordId, mnemonics:[{type,text}]}',
  'core-sense': '返回 {wordId, examples:[{en,cn}]}（本义例句）',
  overview: '返回 {wordId, text}（本义串联助记 60–160 字）',
  semantics: '返回 {wordId, coreSenses:[{index,label,note?,confidence}], meaningMap:[{meaningIndex,coreSenseIndex}]}',
  'meaning-mnemonic': '返回 {wordId, mnemonics:[{type,text}]}（含义级助记）',
  'rare-meanings': '返回 {wordId, rareMeaningIndexes:[number], rareCoreSenseIndexes?:[number]}',
}

export function clampMultiObjectSize(value: unknown, fallback = MULTI_OBJECT_DEFAULT_SIZE): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(MULTI_OBJECT_MAX_SIZE, n))
}

export function buildMultiObjectSystemPrompt(kind: MultiObjectKind): string {
  return [
    '你是考研英语内容生成器。',
    `本次类型：${kind}。${KIND_GUIDE[kind]}`,
    '一次处理多个单词：严格输出 JSON 对象 {"items":[...]}，每个 item 必须带 wordId，且只能使用用户给出的 wordId。',
    '只输出 JSON。无法生成某个词时不要编造，可省略该词或给空数组（调用方会回退单词生成）。',
  ].join('\n')
}

export function buildMultiObjectUserPrompt(kind: MultiObjectKind, sources: MultiObjectSource[]): string {
  const rows = sources.map((source) => ({
    wordId: source.wordId,
    targetKey: source.targetKey ?? source.wordId,
    headword: source.headword,
    ...(source.context ? { context: source.context } : {}),
  }))
  return [`类型：${kind}`, `请一次生成以下 ${rows.length} 个词：`, JSON.stringify(rows)].join('\n')
}

export interface ParseMultiObjectOptions<T> {
  kind: MultiObjectKind
  expected: readonly MultiObjectSource[]
  validateItem: MultiObjectItemValidator<T>
}

export function parseMultiObjectResponse<T>(
  raw: unknown,
  opts: ParseMultiObjectOptions<T>,
): { items: MultiObjectItem<T>[]; missing: MultiObjectSource[] } {
  const expectedKeyOf = (source: MultiObjectSource) => source.targetKey ?? source.wordId
  const sourceByKey = new Map(opts.expected.map((source) => [expectedKeyOf(source), source]))
  const sourceByWord = new Map<string, MultiObjectSource[]>()
  for (const source of opts.expected) {
    const list = sourceByWord.get(source.wordId) ?? []
    list.push(source)
    sourceByWord.set(source.wordId, list)
  }
  const rows =
    raw && typeof raw === 'object' && Array.isArray((raw as { items?: unknown }).items)
      ? ((raw as { items: unknown[] }).items)
      : Array.isArray(raw)
        ? raw
        : null
  if (!rows) throw new AiRequestError('AI_FORMAT', '多对象返回缺少 items 数组')
  const claimed = new Set<string>()
  const items: MultiObjectItem<T>[] = []
  for (const row of rows) {
    const rawRow = row as { wordId?: unknown; targetKey?: unknown } | null
    const wordId = typeof rawRow?.wordId === 'string' ? rawRow.wordId : undefined
    const targetKey = typeof rawRow?.targetKey === 'string' ? rawRow.targetKey : undefined
    let source: MultiObjectSource | undefined
    if (targetKey) source = sourceByKey.get(targetKey)
    if (!source && wordId) {
      // 兼容旧 mock：无 targetKey 时仅匹配该 word 第一个未占用 target；
      // 同词多 target 的其余目标会走 fallback，避免错误合并。
      source = (sourceByWord.get(wordId) ?? []).find((candidate) => !claimed.has(expectedKeyOf(candidate)))
    }
    if (!source) continue
    const key = expectedKeyOf(source)
    if (claimed.has(key)) continue
    claimed.add(key)
    try {
      const payload = opts.validateItem(row, source)
      items.push({ wordId: source.wordId, targetKey: key, payload })
    } catch (error) {
      items.push({ wordId: source.wordId, targetKey: key, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const missing = opts.expected.filter((source) => !claimed.has(expectedKeyOf(source)))
  return { items, missing }
}

export interface GenerateMultiObjectOptions<T> {
  provider?: LlmProvider
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  batchSize?: number
  /** 单对象回退（缺失/格式错误时逐个调用） */
  fallbackSingle?: (source: MultiObjectSource, signal: AbortSignal) => Promise<T>
  /** 校验单对象载荷（也用于回退结果） */
  validateItem: MultiObjectItemValidator<T>
}

/** 一次请求生成 N 个对象；缺失/格式错误按 wordId 回退单对象调用；返回数组按 wordId。 */
export async function generateMultiObject<T>(
  kind: MultiObjectKind,
  sources: MultiObjectSource[],
  config: AiConfig,
  opts: GenerateMultiObjectOptions<T>,
): Promise<MultiObjectGenerateResult<T>> {
  const batchSize = clampMultiObjectSize(opts.batchSize, Math.min(MULTI_OBJECT_DEFAULT_SIZE, Math.max(1, sources.length)))
  const batch = sources.slice(0, batchSize)
  if (batch.length === 0) {
    return { items: [], usage: { input: 0, output: 0, total: 0 }, batchSize, fallbackCount: 0 }
  }
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  let items: MultiObjectItem<T>[] = []
  let usage = { input: 0, output: 0, total: 0 }
  let missing: MultiObjectSource[] = batch
  try {
    const res = await provider.chat(
      {
        messages: [
          { role: 'system', content: buildMultiObjectSystemPrompt(kind) },
          { role: 'user', content: buildMultiObjectUserPrompt(kind, batch) },
        ],
        temperature: 0.2,
        jsonMode: true,
      },
      config,
      controller.signal,
    )
    usage = res.usage
    const extracted = extractJsonObject(res.text)
    if (!extracted.json) throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
    const parsed = parseMultiObjectResponse(extracted.json, { kind, expected: batch, validateItem: opts.validateItem })
    items = parsed.items
    missing = parsed.missing
  } catch (error) {
    // 整包解析失败：所有词回退单对象（若提供）
    if (!opts.fallbackSingle) throw error
    items = []
    missing = batch
    void error
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
  }
  const sourceByKeyLocal = (key: string) => batch.find((source) => (source.targetKey ?? source.wordId) === key)
  let fallbackCount = 0
  if (opts.fallbackSingle) {
    const keyOf = (source: MultiObjectSource) => source.targetKey ?? source.wordId
    const failedSources = items
      .filter((item) => item.error)
      .map((item) => sourceByKeyLocal(item.targetKey ?? item.wordId))
      .filter((source): source is MultiObjectSource => Boolean(source))
    const needFallback = [...missing, ...failedSources]
    const results = new Map<string, MultiObjectItem<T>>()
    for (const item of items) {
      if (!item.error) results.set(item.targetKey ?? item.wordId, item)
    }
    for (const source of needFallback) {
      const key = keyOf(source)
      if (results.has(key)) continue
      try {
        const payload = await opts.fallbackSingle(source, controller.signal)
        results.set(key, { wordId: source.wordId, targetKey: key, payload, fallback: true })
        fallbackCount += 1
      } catch (error) {
        results.set(key, {
          wordId: source.wordId,
          targetKey: key,
          error: error instanceof Error ? error.message : String(error),
          fallback: true,
        })
      }
    }
    items = batch.map((source) => results.get(keyOf(source)) ?? { wordId: source.wordId, targetKey: keyOf(source), error: '未生成' })
  }
  return { items, usage, batchSize, fallbackCount }
}

/** 供任务/预算层：按 batchSize 把目标切分为多请求 */
export function chunkMultiObjectSources(
  sources: readonly MultiObjectSource[],
  batchSize: number,
): MultiObjectSource[][] {
  const size = clampMultiObjectSize(batchSize)
  const chunks: MultiObjectSource[][] = []
  for (let i = 0; i < sources.length; i += size) chunks.push(sources.slice(i, i + size))
  return chunks
}
