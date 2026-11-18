/**
 * Word / WordState 工厂 + 释义串解析（SPEC §1.3 / §1.4 / §1.6）。
 *
 * 数据层所有「原始输入 → 标准 Word」的转换都走这里：
 * - 导入（DeckFile / CSV / MaiMemo导入 / 内置词库种子）
 * - 词库管理（新建词库、手动词条）
 *
 * id 规则（§1.4）是跨端契约：
 *   wordId   = `${deckId}:${normalizeHeadword(headword)}`
 *   meaningId = `${wordId}#M${index+1}`
 * 除非调用方显式传入 `wordId`（迁移包保留文件 id），否则一律重算。
 */

import {
  createWordState,
  meaningIdOf,
  normalizeHeadword,
  wordIdOf,
} from '../core'
import type {
  Example,
  Meaning,
  Mnemonic,
  Phrase,
  Phonetic,
  Word,
  WordState,
} from '../core'

/** 一条释义的原始输入（pos 可选） */
export interface RawMeaningInput {
  pos?: string
  cn: string
}

/** 词条原始输入：导入/CSV/手动词条都归一到这里 */
export interface RawWordInput {
  headword: string
  /** 结构化释义；与 meaning 串合并 */
  meanings?: RawMeaningInput[]
  /** 释义串（可能含 `\n`，行首可带词性） */
  meaning?: string
  examples?: Example[]
  example?: string
  exampleTranslation?: string
  phonetic?: Phonetic | string
  mnemonics?: Mnemonic[]
  phrases?: Phrase[]
  tags?: string[]
  order?: number
  chapter?: string
  frequency?: number
  cefr?: string
  examCount?: number
  createdAt?: number
  /** 仅迁移包导入用：保留文件里的 wordId / meaning id（state 对齐） */
  wordId?: string
  meaningIds?: string[]
}

/** 词性前缀（`n.` / `vt.` / `phr.` / `n.&vt.` / `adj./adv.` 等） */
const POS_PREFIX = /^((?:[a-z]{1,5}\.|phr\.)(?:\s*[&/,，、]\s*(?:[a-z]{1,5}\.|phr\.))*)\s*/i

/** `n. 拥抱\nvt. 拥抱；信奉` → [{pos:'n.',cn:'拥抱'},{pos:'vt.',cn:'拥抱；信奉'}] */
export function parseMeaningString(raw: string | null | undefined): RawMeaningInput[] {
  if (typeof raw !== 'string') return []
  const out: RawMeaningInput[] = []
  for (const line of raw.split('\n')) {
    let text = line.trim()
    if (!text) continue
    if (!/[\u4e00-\u9fffA-Za-z]/.test(text)) continue
    let pos: string | undefined
    const match = POS_PREFIX.exec(text)
    if (match) {
      pos = match[1]!.replace(/\s+/g, '')
      text = text.slice(match[0].length).trim()
    }
    if (!text) continue
    out.push(pos ? { pos, cn: text } : { cn: text })
  }
  return out
}

/** 释义去重（按 cn；保留先出现的 pos） */
export function dedupeMeanings(meanings: RawMeaningInput[]): RawMeaningInput[] {
  const seen = new Set<string>()
  const out: RawMeaningInput[] = []
  for (const item of meanings) {
    const cn = (item.cn ?? '').trim()
    if (!cn) continue
    const key = cn.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item.pos ? { pos: item.pos, cn } : { cn })
  }
  return out
}

/** 音标归一：字符串 → {uk,us}；对象 → 去空 */
export function normalizePhonetic(
  phonetic: Phonetic | string | null | undefined,
): Phonetic | undefined {
  if (phonetic == null) return undefined
  if (typeof phonetic === 'string') {
    const value = phonetic.trim()
    return value ? { uk: value, us: value } : undefined
  }
  const uk = typeof phonetic.uk === 'string' ? phonetic.uk.trim() : ''
  const us = typeof phonetic.us === 'string' ? phonetic.us.trim() : ''
  if (!uk && !us) return undefined
  const out: Phonetic = {}
  if (uk) out.uk = uk
  if (us) out.us = us
  return out
}

function normalizeExamples(raw: Example[] | undefined): Example[] {
  if (!Array.isArray(raw)) return []
  const out: Example[] = []
  for (const item of raw) {
    const en = typeof item?.en === 'string' ? item.en.trim() : ''
    if (!en) continue
    const example: Example = { en }
    if (typeof item.cn === 'string' && item.cn.trim()) example.cn = item.cn.trim()
    if (typeof item.source === 'string' && item.source.trim()) example.source = item.source.trim()
    out.push(example)
  }
  return out
}

function normalizeTags(raw: string[] | undefined, extras: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const tag of [...(raw ?? []), ...extras]) {
    if (typeof tag !== 'string') continue
    const value = tag.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export interface BuildWordOptions {
  /** 覆盖 wordId（迁移包保留文件 id 用；默认按 §1.4 重算） */
  wordId?: string
  /** 覆盖 order（默认取 input.order，缺省 0） */
  order?: number
  /** 构建时间戳（默认 input.createdAt ?? 0；内置词库用固定常量保证可复现） */
  createdAt?: number
  /** 保留 input.meaningIds（长度匹配时；迁移包用） */
  preserveMeaningIds?: boolean
}

/**
 * 原始输入 → 标准 Word（唯一入口）。
 * 语义：
 * - meanings = input.meanings + parseMeaningString(input.meaning)，按 cn 去重；
 * - 无释义 → 用 headword 兜底并打 `no-meaning` tag（§1.3）；
 * - 至少 1 条 meaning（AC7）。
 */
export function buildWord(input: RawWordInput, deckId: string, opts: BuildWordOptions = {}): Word {
  const headword = String(input.headword ?? '')
    .trim()
    .replace(/\s+/g, ' ')
  const wordId = opts.wordId ?? wordIdOf(deckId, headword)

  const combined = dedupeMeanings([
    ...(input.meanings ?? []),
    ...parseMeaningString(input.meaning),
  ])
  const hasMeaning = combined.length > 0
  const rawMeanings: RawMeaningInput[] = hasMeaning ? combined : [{ cn: headword }]

  const preserveIds =
    opts.preserveMeaningIds &&
    Array.isArray(input.meaningIds) &&
    input.meaningIds.length === rawMeanings.length

  const meanings: Meaning[] = rawMeanings.map((item, index) => {
    const provided = preserveIds ? input.meaningIds?.[index] : undefined
    const id = provided && provided.trim() ? provided : meaningIdOf(wordId, index + 1)
    const meaning: Meaning = { id, cn: item.cn }
    if (item.pos) meaning.pos = item.pos
    return meaning
  })

  const examples = normalizeExamples(input.examples)
  if (input.example && input.example.trim()) {
    const example: Example = { en: input.example.trim() }
    if (input.exampleTranslation && input.exampleTranslation.trim()) {
      example.cn = input.exampleTranslation.trim()
    }
    examples.unshift(example)
  }

  const tags = normalizeTags(input.tags, hasMeaning ? [] : ['no-meaning'])
  const phonetic = normalizePhonetic(input.phonetic)

  const word: Word = {
    id: wordId,
    deckId,
    headword,
    headwordLower: normalizeHeadword(headword),
    meanings,
    examples: examples.slice(0, 8),
    mnemonics: Array.isArray(input.mnemonics) ? input.mnemonics : [],
    phrases: Array.isArray(input.phrases) ? input.phrases : [],
    tags,
    order: Number.isFinite(opts.order) ? opts.order! : Number.isFinite(input.order) ? input.order! : 0,
    createdAt: Number.isFinite(opts.createdAt)
      ? opts.createdAt!
      : Number.isFinite(input.createdAt)
        ? input.createdAt!
        : 0,
  }
  if (phonetic) word.phonetic = phonetic
  if (typeof input.chapter === 'string' && input.chapter.trim()) {
    word.chapter = input.chapter.trim()
  }
  if (Number.isFinite(input.frequency)) word.frequency = input.frequency
  if (typeof input.cefr === 'string' && input.cefr.trim()) word.cefr = input.cefr.trim()
  if (Number.isFinite(input.examCount)) word.examCount = input.examCount
  return word
}

/**
 * 新词状态（用 core 的 createWordState，保证与 scheduleNext 的 isFirstEver 分支一致）。
 * v2：把官方难度 `Word.difficulty` 作为 d0 先验传进去（缺失时 core 用 DEFAULT_PARAMS.d0=5），
 * 新词首评间隔由难度决定（SPEC-v2 §4.1）。
 */
export function buildInitialState(
  word: Pick<Word, 'id' | 'deckId' | 'difficulty'>,
  now: number = 0,
): WordState {
  return createWordState({
    wordId: word.id,
    deckId: word.deckId,
    difficulty: word.difficulty,
    now,
  })
}

/** 该词全部含义 id（进入注释面批量 +encounters 用） */
export function meaningIdsOf(word: Pick<Word, 'id' | 'meanings'>): string[] {
  return word.meanings.map((meaning) => meaning.id)
}
