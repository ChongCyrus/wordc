/** 0.6.0/task-285：全类型 AI 目标构建器（复用 AdvancedFilter 求交 seed wordIds） */
import type { AdvancedFilter } from './advanced-filter'
import { queryAdvancedFilter } from './advanced-filter'
import { getDb } from './db'
import { getEffectiveContent } from './packs.repo'

export type GenerationTargetKind =
  | 'examples'
  | 'phrases'
  | 'mnemonics'
  | 'semantics'
  | 'core-sense'
  | 'overview'
  | 'meaning-mnemonic'
  | 'root-etymology'
  | 'derivation'
  | 'rare-meanings'

export interface GenerationTargetItem {
  wordId: string
  headword: string
  headwordLower: string
  /** 0.6.3：目标级唯一 key（kind:wordId#m/c），创建 job 时直接带上 */
  targetKey?: string
  /** 含义级目标（semantics/meaning-mnemonic） */
  meaningId?: string
  meaningIndex?: number
  /** 本义级目标（core-sense/overview） */
  coreSenseIndex?: number
  coreSenseLabel?: string
}

export interface BuildGenerationTargetsInput {
  kind: GenerationTargetKind
  /** 基础集合（seed）；与 filter 求交 */
  wordIds: readonly string[]
  deckId?: string
  filter?: AdvancedFilter
  /** 每类附加配置（mode/limits 等） */
  config?: Record<string, unknown>
}

export interface BuildGenerationTargetsResult {
  kind: GenerationTargetKind
  targets: GenerationTargetItem[]
  sourceWordCount: number
  /** 过滤后候选词数（扩展含义/本义前） */
  filteredWordCount: number
  totalTargets: number
  config: Record<string, unknown>
  issues: Array<{ wordId?: string; message: string }>
}

export const GENERATION_TARGET_KINDS: readonly GenerationTargetKind[] = [
  'examples',
  'phrases',
  'mnemonics',
  'semantics',
  'core-sense',
  'overview',
  'meaning-mnemonic',
  'root-etymology',
  'derivation',
  'rare-meanings',
]

const WORD_LEVEL = new Set<GenerationTargetKind>([
  'examples',
  'phrases',
  'mnemonics',
  'root-etymology',
  'derivation',
  'rare-meanings',
])

function baseConfig(kind: GenerationTargetKind, extra?: Record<string, unknown>): Record<string, unknown> {
  return { kinds: [kind], ...(extra ?? {}) }
}

/** 单类型目标构建：seed wordIds → AdvancedFilter 求交 → 按类型展开 */
export async function buildGenerationTargets(input: BuildGenerationTargetsInput): Promise<BuildGenerationTargetsResult> {
  if (!GENERATION_TARGET_KINDS.includes(input.kind)) throw new Error(`未知生成类型：${input.kind}`)
  const seed = [...new Set(input.wordIds.filter(Boolean))]
  const issues: Array<{ wordId?: string; message: string }> = []
  const db = getDb()
  let filteredIds = seed
  if (input.filter) {
    const result = await queryAdvancedFilter({
      ...(input.deckId ? { deckId: input.deckId } : {}),
      wordIds: seed,
      filter: input.filter,
      limit: 1000,
      offset: 0,
    })
    filteredIds = result.words.map((item) => item.word.id)
  }
  const rows = await db.words.bulkGet(filteredIds)
  const words = filteredIds.map((id) => rows.find((row) => row?.id === id)).filter((word) => Boolean(word))
  const targets: GenerationTargetItem[] = []
  if (WORD_LEVEL.has(input.kind)) {
    for (const word of words) {
      if (!word) continue
      targets.push({
        wordId: word.id,
        headword: word.headword,
        headwordLower: word.headwordLower,
        targetKey: `${input.kind}:${word.id}`,
      })
    }
  } else {
    for (const word of words) {
      if (!word) continue
      if (input.kind === 'semantics' || input.kind === 'meaning-mnemonic') {
        if (word.meanings.length < 2 && input.kind === 'semantics') continue
        word.meanings.forEach((meaning, index) => {
          targets.push({
            wordId: word.id,
            headword: word.headword,
            headwordLower: word.headwordLower,
            targetKey: `${input.kind}:${word.id}#m${index + 1}`,
            meaningId: meaning.id,
            meaningIndex: index + 1,
          })
        })
        continue
      }
      // core-sense / overview
      try {
        const effective = await getEffectiveContent(word.id)
        const coreSenses = effective?.coreSenses ?? []
        if (coreSenses.length === 0) {
          issues.push({ wordId: word.id, message: '无本义内容，已跳过' })
          continue
        }
        coreSenses.forEach((sense) => {
          targets.push({
            wordId: word.id,
            headword: word.headword,
            headwordLower: word.headwordLower,
            targetKey: `${input.kind}:${word.id}#c${sense.index}`,
            coreSenseIndex: sense.index,
            coreSenseLabel: sense.label,
          })
        })
      } catch (error) {
        issues.push({ wordId: word.id, message: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  const config = baseConfig(input.kind, input.config)
  return {
    kind: input.kind,
    targets,
    sourceWordCount: input.wordIds.length,
    filteredWordCount: filteredIds.length,
    totalTargets: targets.length,
    config,
    issues,
  }
}

/** 多类型目标构建（同一批 seed/filter），返回按 kind 的 targets 合并视图 */
export async function buildMultiKindGenerationTargets(input: {
  kinds: readonly GenerationTargetKind[]
  wordIds: readonly string[]
  deckId?: string
  filter?: AdvancedFilter
  configByKind?: Partial<Record<GenerationTargetKind, Record<string, unknown>>>
}): Promise<{
  kinds: GenerationTargetKind[]
  byKind: Partial<Record<GenerationTargetKind, BuildGenerationTargetsResult>>
  targets: Array<GenerationTargetItem & { kind: GenerationTargetKind }>
}> {
  const byKind: Partial<Record<GenerationTargetKind, BuildGenerationTargetsResult>> = {}
  const targets: Array<GenerationTargetItem & { kind: GenerationTargetKind }> = []
  for (const kind of input.kinds) {
    const result = await buildGenerationTargets({
      kind,
      wordIds: input.wordIds,
      ...(input.deckId ? { deckId: input.deckId } : {}),
      ...(input.filter ? { filter: input.filter } : {}),
      ...(input.configByKind?.[kind] ? { config: input.configByKind[kind] } : {}),
    })
    byKind[kind] = result
    for (const target of result.targets) targets.push({ ...target, kind })
  }
  return { kinds: [...input.kinds], byKind, targets }
}
