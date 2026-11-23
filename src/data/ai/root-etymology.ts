/** 0.3.98/task-283：AI 词根词缀词源分解（严格校验，不编造） */
import { createLlmProvider, AiRequestError, type LlmProvider } from './provider'
import { extractJsonObject } from './generate'
import { addUsage, emptyUsage, estimateCost } from './cost'
import type { AiConfig, TokenUsage } from './types'
import { validateRootEtymologyDraft, type RootEtymologyDraft } from '../root-etymology'
import type { Meaning } from '../../core/types'

export const ROOT_ETYMOLOGY_PROMPT_VERSION = 'root-etymology-v1'

export interface RootEtymologyPromptSource {
  wordId: string
  headword: string
  meanings: Array<{ cn: string; pos?: string }>
  coreSenses?: Array<{ index: number; label: string; note?: string }>
}

export interface GenerateRootEtymologyOptions {
  provider?: LlmProvider
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

export interface RootEtymologyGenerateResult {
  draft: RootEtymologyDraft
  usage: TokenUsage
  promptVersion: string
}

export function buildRootEtymologySystemPrompt(): string {
  return [
    '你是考研英语词源老师。请分解单词的词根词缀并给出可靠词源。',
    '严格 JSON：{"parts":[{"type":"prefix|root|suffix|other","text":"...","meaning":"...","note":"..."}],"etymology":"...","composition":"..."}',
    '只输出 JSON。不能确认时 parts 返回 []，并在 etymology 说明「无法可靠确认」，不要编造。',
  ].join('\n')
}

export function buildRootEtymologyUserPrompt(source: RootEtymologyPromptSource): string {
  const senses = (source.coreSenses ?? []).map((sense) => `${sense.index}. ${sense.label}${sense.note ? `（${sense.note}）` : ''}`)
  return [
    `单词：${source.headword}`,
    `含义：${source.meanings.map((meaning) => meaning.cn).join('；')}`,
    senses.length > 0 ? `本义：${senses.join(' / ')}` : '',
    '请只基于可确认的词源事实输出。',
  ]
    .filter(Boolean)
    .join('\n')
}

export async function generateRootEtymology(
  source: RootEtymologyPromptSource,
  config: AiConfig,
  opts: GenerateRootEtymologyOptions = {},
): Promise<RootEtymologyGenerateResult> {
  const provider = opts.provider ?? createLlmProvider({ fetchImpl: opts.fetchImpl })
  const signal = opts.signal ?? new AbortController().signal
  const res = await provider.chat(
    {
      messages: [
        { role: 'system', content: buildRootEtymologySystemPrompt() },
        { role: 'user', content: buildRootEtymologyUserPrompt(source) },
      ],
      temperature: 0.1,
      jsonMode: true,
    },
    config,
    signal,
  )
  const extracted = extractJsonObject(res.text)
  if (!extracted.json) throw new AiRequestError('AI_FORMAT', extracted.error ?? 'AI 返回不是合法 JSON')
  let draft: RootEtymologyDraft
  try {
    draft = validateRootEtymologyDraft(extracted.json)
  } catch (error) {
    throw new AiRequestError('AI_FORMAT', error instanceof Error ? error.message : String(error))
  }
  return { draft, usage: res.usage, promptVersion: ROOT_ETYMOLOGY_PROMPT_VERSION }
}

export interface RootEtymologyBatchItemResult {
  source: RootEtymologyPromptSource
  draft?: RootEtymologyDraft
  usage?: TokenUsage
  error?: string
  /** 无法确认属于正常空结果，不算失败 */
  empty?: boolean
}

export interface RootEtymologyBatchResult {
  results: RootEtymologyBatchItemResult[]
  usage: TokenUsage
  costYuan: number
  failed: number
}

export interface GenerateRootEtymologyBatchOptions extends GenerateRootEtymologyOptions {
  concurrency?: number
  timeoutMs?: number
  onProgress?: (progress: { done: number; total: number; wordId: string; ok: boolean }) => void
}

/** 批量生成：并发池 + 单条失败隔离；空结果不导致整批失败 */
export async function generateRootEtymologyBatch(
  sources: RootEtymologyPromptSource[],
  config: AiConfig,
  opts: GenerateRootEtymologyBatchOptions = {},
): Promise<RootEtymologyBatchResult> {
  const concurrency = Math.max(1, Math.min(5, Math.floor(opts.concurrency ?? 2)))
  const results = new Array<RootEtymologyBatchItemResult>(sources.length)
  let cursor = 0
  let done = 0
  const run = async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= sources.length) return
      const source = sources[index]!
      try {
        const result = await generateRootEtymology(source, config, opts)
        results[index] = { source, draft: result.draft, usage: result.usage, empty: result.draft.parts.length === 0 }
      } catch (error) {
        results[index] = {
          source,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      done += 1
      opts.onProgress?.({ done, total: sources.length, wordId: source.wordId, ok: results[index]!.error == null })
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, sources.length)) }, () => run()))
  let usage = emptyUsage()
  let failed = 0
  for (const result of results) {
    if (result.usage) usage = addUsage(usage, result.usage)
    if (result.error) failed += 1
  }
  return { results, usage, costYuan: estimateCost(usage, config.model), failed }
}

export function toRootEtymologyPromptSource(word: {
  id: string
  headword: string
  meanings: Meaning[]
}, coreSenses?: Array<{ index: number; label: string; note?: string }>): RootEtymologyPromptSource {
  return {
    wordId: word.id,
    headword: word.headword,
    meanings: word.meanings.map((meaning) => ({ cn: meaning.cn, ...(meaning.pos ? { pos: meaning.pos } : {}) })),
    ...(coreSenses && coreSenses.length > 0 ? { coreSenses } : {}),
  }
}
