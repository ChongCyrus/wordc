/**
 * 0.8.0：加权记忆「只记词根缀」映射构建（纯函数，无 IO）。
 *
 * 输入当前词的 rootEtymology.parts，输出：
 * - 每个词根/缀：键=text（含类型），值=meaning，附 2–3 个典型代表词；
 * - 最后一卡：完整词 → composition（缺失时用 parts 拼接兜底）。
 */
export type RootAffixPartType = 'prefix' | 'root' | 'suffix' | 'other'

export interface RootAffixPart {
  type: string
  text: string
  meaning: string
}

export interface RootAffixWord {
  id?: string
  headword: string
  difficulty?: number | null
  meanings?: Array<{ cn?: string }>
}

export interface RootAffixExample {
  wordId?: string
  headword: string
  meaning?: string
}

export interface RootAffixPartMapping {
  kind: 'part'
  type: RootAffixPartType
  key: string
  value: string
  examples: RootAffixExample[]
}

export interface RootAffixWordMapping {
  kind: 'word'
  key: string
  value: string
  examples: []
}

export type RootAffixMappingItem = RootAffixPartMapping | RootAffixWordMapping

export interface BuildRootAffixMappingsOptions {
  deckWords?: RootAffixWord[]
  /** 每个 part 附带的代表词数量，默认 3 */
  limit?: number
  /** 代表词最短词根长度（含），默认 2 */
  minStemLength?: number
}

export interface RootAffixMappingsResult {
  ok: boolean
  items: RootAffixMappingItem[]
  reason?: 'no-root-etymology' | 'no-parts'
}

const TYPE_ORDER: Record<string, number> = { prefix: 0, root: 1, suffix: 2, other: 3 }

function normalizeType(type: string): RootAffixPartType {
  return type === 'prefix' || type === 'root' || type === 'suffix' ? type : 'other'
}

/** 去掉连字符、首尾空白，统一小写用于匹配 */
export function normalizeAffixText(text: string): string {
  return String(text ?? '')
    .trim()
    .replace(/^[-–—]+|[-–—]+$/g, '')
    .trim()
    .toLowerCase()
}

function matchPart(part: RootAffixPartType, stem: string, headword: string): boolean {
  const word = headword.toLowerCase()
  if (!stem || word === stem) return false
  if (part === 'prefix') return word.startsWith(stem) && word.length > stem.length
  if (part === 'suffix') return word.endsWith(stem) && word.length > stem.length
  return word.includes(stem)
}

function firstMeaningCn(word: RootAffixWord): string | undefined {
  const cn = word.meanings?.find((meaning) => String(meaning?.cn ?? '').trim())?.cn
  return cn ? String(cn).trim() : undefined
}

function difficultyOf(word: RootAffixWord): number {
  const value = Number(word.difficulty)
  return Number.isFinite(value) && value > 0 ? value : 5
}

/**
 * 从词库中挑代表词：同位置匹配 → 排除当前词 → 去重 → 词短优先 → 难度低优先 → 字母序。
 * 只做本地匹配，不调 AI；无匹配返回空数组。
 */
export function pickRepresentativeWords(
  part: RootAffixPartType,
  text: string,
  headword: string,
  deckWords: RootAffixWord[],
  limit = 3,
  minStemLength = 2,
): RootAffixExample[] {
  const stem = normalizeAffixText(text)
  if (stem.length < Math.max(1, minStemLength)) return []
  const current = headword.trim().toLowerCase()
  const seen = new Set<string>([current])
  const matched: RootAffixWord[] = []
  for (const word of deckWords) {
    const form = String(word?.headword ?? '').trim()
    if (!form) continue
    const lower = form.toLowerCase()
    if (seen.has(lower)) continue
    if (!matchPart(part, stem, form)) continue
    seen.add(lower)
    matched.push(word)
  }
  matched.sort((a, b) => {
    const la = a.headword.trim().length
    const lb = b.headword.trim().length
    if (la !== lb) return la - lb
    const da = difficultyOf(a)
    const db = difficultyOf(b)
    if (da !== db) return da - db
    return a.headword.localeCompare(b.headword)
  })
  return matched.slice(0, Math.max(0, limit)).map((word) => {
    const meaning = firstMeaningCn(word)
    return {
      ...(word.id ? { wordId: word.id } : {}),
      headword: word.headword.trim(),
      ...(meaning ? { meaning } : {}),
    }
  })
}

function fallbackComposition(parts: RootAffixPart[]): string {
  const chain = parts
    .map((part) => `${String(part.text ?? '').trim()}（${String(part.meaning ?? '').trim()}）`)
    .join(' + ')
  const firstMeaning = parts[0]?.meaning ? String(parts[0].meaning).trim() : ''
  const tail = firstMeaning ? `→ ${firstMeaning}` : ''
  return `组合：${chain}${tail}`
}

/** 构建「只记词根缀」模式的卡片序列（parts + 最后一卡完整词）。 */
export function buildRootAffixMappings(
  word: { headword: string; rootEtymology?: { parts?: RootAffixPart[]; composition?: string } | null },
  opts: BuildRootAffixMappingsOptions = {},
): RootAffixMappingsResult {
  const etymology = word?.rootEtymology
  if (!etymology) return { ok: false, items: [], reason: 'no-root-etymology' }
  const parts = (etymology.parts ?? [])
    .map((part) => {
      const type = normalizeType(String(part?.type ?? ''))
      const text = String(part?.text ?? '').trim()
      const meaning = String(part?.meaning ?? '').trim()
      return { type, text, meaning }
    })
    .filter((part) => part.text && part.meaning)
  if (parts.length === 0) return { ok: false, items: [], reason: 'no-parts' }

  const deckWords = opts.deckWords ?? []
  const limit = Math.max(0, Math.min(6, Math.floor(opts.limit ?? 3)))
  const minStemLength = Math.max(1, Math.floor(opts.minStemLength ?? 2))
  const items: RootAffixMappingItem[] = parts
    .slice()
    .sort((a, b) => (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9))
    .map((part) => ({
      kind: 'part' as const,
      type: part.type,
      key: part.text,
      value: part.meaning,
      examples: pickRepresentativeWords(
        part.type,
        part.text,
        word.headword,
        deckWords,
        limit,
        minStemLength,
      ),
    }))

  const composition = String(etymology.composition ?? '').trim()
  items.push({
    kind: 'word',
    key: String(word.headword ?? '').trim(),
    value: composition || fallbackComposition(parts),
    examples: [],
  })
  return { ok: true, items }
}
