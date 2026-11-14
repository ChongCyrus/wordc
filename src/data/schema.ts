/**
 * 导入文件的运行时校验 + 规范化（SPEC §1.5 / §6 / §6.4）。
 *
 * 设计：
 * - zod 只做「形状/类型」校验，产出结构化 `ImportIssue`（含 path，UI 可逐条展示）；
 * - 规范化（去重/排序/补默认值/重算 id）在 `normalize*` 里做，产出**可直接写库**的 Word/Deck；
 * - `level:'error'` 的 issue 会让导入整体中止（调用方不写库）；`warning` 不阻断。
 *
 * 兼容策略：
 * - 词条接受 `headword`（新）或 `term`（旧词库导出格式的字段）；
 * - 词条/释义 id 缺省时自动按 §1.4 生成；DeckFile 导入一律重算 id（可公开分享），
 *   MigrationFile 导入保留文件 id（学习状态靠它对齐）。
 */

import { z } from 'zod'

/** F6 用户助记类型白名单 */
const USER_MNEMONIC_TYPES = new Set(['联想', '谐音', '词根', '词源', '串记', '口诀', '其他'])
import {
  meaningIdOf,
  normalizeHeadword,
  wordIdOf,
} from '../core'
import type {
  Deck,
  DeckFile,
  Example,
  ImportIssue,
  Meaning,
  MigrationFile,
  ReviewLog,
  SettingRecord,
  Word,
  WordState,
} from '../core'
import { buildWord } from './word-factory'
import type { RawWordInput } from './word-factory'
import type { DailyPlan } from './plan.types'
import type { ContentRejectRecord, PackItemRecord, PackRecord } from './packs/schema'
import { isSettingKey } from './settings.repo'

export const DECK_FORMAT = 'momo-deck'
export const MIGRATION_FORMAT = 'momo-migration'
export const FORMAT_VERSION = 1

// ============ 小工具 ============

/** 构造一条导入 issue */
export function makeIssue(
  level: ImportIssue['level'],
  code: ImportIssue['code'],
  message: string,
  extra: { path?: string; row?: number; field?: string } = {},
): ImportIssue {
  const issue: ImportIssue = { level, code, message }
  if (extra.path) issue.path = extra.path
  if (extra.row != null) issue.row = extra.row
  if (extra.field) issue.field = extra.field
  return issue
}

/** zod path → 'words[12].meanings[0].cn' */
export function formatPath(parts: ReadonlyArray<string | number | symbol | PropertyKey>): string {
  let out = ''
  for (const part of parts) {
    if (typeof part === 'number') out += `[${part}]`
    else if (out) out += `.${String(part)}`
    else out = String(part)
  }
  return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ZodIssueLike {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>
}

/** zod 错误 → ImportIssue（path 前缀用于区分 words/states） */
function fromZod(error: unknown, prefix = ''): ImportIssue[] {
  const err = error as ZodIssueLike
  if (!err?.issues) return [makeIssue('error', 'E_FIELD', '数据格式不正确')]
  return err.issues.map((item) => {
    const path = formatPath(item.path)
    return makeIssue('error', 'E_FIELD', item.message, {
      path: prefix ? (path ? `${prefix}.${path}` : prefix) : path,
      field: path ? formatPath(item.path.slice(-1)) : undefined,
    })
  })
}

// ============ zod schema（形状校验） ============

const exampleSchema = z.object({
  en: z.string(),
  cn: z.string().optional(),
  source: z.string().optional(),
})

const meaningSchema = z.object({
  id: z.string().optional(),
  pos: z.string().optional(),
  cn: z.string(),
  examples: z.array(exampleSchema).optional(),
})

const mnemonicSchema = z.object({
  type: z.string(),
  text: z.string(),
})

const phraseSchema = z.object({
  en: z.string(),
  cn: z.string(),
  /** task-42：归属含义 id（可选；旧数据缺失 = 词级） */
  meaningId: z.string().optional(),
})

const phoneticSchema = z.union([
  z.string(),
  z.object({ uk: z.string().optional(), us: z.string().optional() }),
])

/** 单条词条（宽松：id/order/可选数组都可缺，规范化时补） */
export const rawWordSchema = z.object({
  id: z.string().optional(),
  deckId: z.string().optional(),
  headword: z.string().optional(),
  term: z.string().optional(),
  headwordLower: z.string().optional(),
  phonetic: phoneticSchema.nullable().optional(),
  meanings: z.array(meaningSchema).optional(),
  meaning: z.string().nullable().optional(),
  examples: z.array(exampleSchema).optional(),
  example: z.string().nullable().optional(),
  exampleTranslation: z.string().nullable().optional(),
  mnemonics: z.array(mnemonicSchema).optional(),
  phrases: z.array(phraseSchema).optional(),
  tags: z.array(z.string()).optional(),
  order: z.number().optional(),
  frequency: z.number().optional(),
  cefr: z.string().optional(),
  examCount: z.number().optional(),
  chapter: z.string().optional(),
  maimemoVocId: z.string().optional(),
  /** 官方单词难度 1–10（task-25；导入时保留） */
  difficulty: z.number().optional(),
  /** F6：用户自定义笔记/助记（迁移/词库导出保留；不写入内容包） */
  userNotes: z
    .array(
      z.object({
        id: z.string().optional(),
        text: z.string(),
        meaningId: z.string().optional(),
      }),
    )
    .optional(),
  userMnemonics: z
    .array(
      z.object({
        id: z.string().optional(),
        type: z.string(),
        text: z.string(),
        meaningId: z.string().optional(),
      }),
    )
    .optional(),
  /** F6：被用户编辑/删除的 AI 助记 key 列表 */
  hiddenMnemonicKeys: z.array(z.string()).optional(),
  /** F8：生成元→含义 引申图 */
  derivationMap: z
    .object({
      rootLabel: z.string().optional(),
      text: z.string().optional(),
      mermaid: z.string().optional(),
      source: z.enum(['manual', 'ai']),
      updatedAt: z.number(),
    })
    .optional(),
  createdAt: z.number().optional(),
})

/** 词库元数据 */
export const deckSchema = z.object({
  id: z.string().min(1, '词库 id 不能为空'),
  name: z.string().min(1, '词库名称不能为空'),
  description: z.string().optional(),
  source: z.enum(['builtin', 'imported', 'custom', 'maimemo']).default('imported'),
  builtinKey: z.enum(['hongbaoshu-2025', 'kaoyan-2027-dagang']).optional(),
  wordCount: z.number().int().nonnegative().default(0),
  version: z.number().int().positive().default(1),
  license: z.string().optional(),
  isDefault: z.boolean().optional(),
  createdAt: z.number().default(0),
  updatedAt: z.number().default(0),
})

const meaningStatSchema = z.object({
  clicks: z.number(),
  encounters: z.number(),
})

/** 学习状态（迁移包） */
export const wordStateSchema = z.object({
  wordId: z.string().min(1),
  deckId: z.string().min(1),
  phase: z.enum(['new', 'learning', 'review', 'lapsed', 'mastered', 'suspended']),
  stability: z.number(),
  difficulty: z.number(),
  reps: z.number(),
  lapses: z.number(),
  firstSeenAt: z.number().nullable(),
  lastReviewedAt: z.number().nullable(),
  dueAt: z.number().nullable(),
  nextIntervalDays: z.number(),
  retrievability: z.number(),
  lastRating: z.enum(['familiar', 'vague', 'forgot']).nullable(),
  sameDayCount: z.number(),
  sameDayDate: z.string(),
  meaningStats: z.record(z.string(), meaningStatSchema),
  sameDayRequeued: z.number(),
  /** 官方「今日进度%」本地等价模型（dev-algo task-26；可选，旧迁移包缺失按 0） */
  todayProgress: z.number().optional(),
  todayProgressDate: z.string().optional(),
  /** v2 进度模型骨架（dev-algo 新增；可选，迁移时保留） */
  todayProgressLevel: z.number().optional(),
  canFinishToday: z.boolean().optional(),
  importedFrom: z.enum(['maimemo', 'backup']).optional(),
  importedAt: z.number().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

/** 复习日志（迁移包） */
export const reviewLogSchema = z.object({
  id: z.number().int().optional(),
  wordId: z.string().min(1),
  deckId: z.string().min(1),
  rating: z.enum(['familiar', 'vague', 'forgot']),
  reviewedAt: z.number(),
  stabilityBefore: z.number(),
  difficultyBefore: z.number(),
  stabilityAfter: z.number(),
  difficultyAfter: z.number(),
  elapsedDays: z.number(),
  nextIntervalDays: z.number(),
  retrievabilityAtReview: z.number().nullable(),
  longTermUpdate: z.boolean(),
  durationMs: z.number().optional(),
  // v2 回退/改判（可选；旧包缺失按 undefined = 不可撤销）
  stateBefore: wordStateSchema.nullable().optional(),
  corrected: z.boolean().optional(),
  reverted: z.boolean().optional(),
  correctedBy: z.number().optional(),
})

/** 今日计划评分记录（SPEC-v2 §3.4） */
const planRatingSchema = z.object({
  wordId: z.string().min(1),
  rating: z.enum(['familiar', 'vague', 'forgot']),
  reviewedAt: z.number(),
  longTermUpdate: z.boolean(),
  corrected: z.boolean().optional(),
  correctedBy: z.number().optional(),
})

/** 今日学习计划（SPEC-v2 §3.4；迁移包 v2 可选字段） */
export const dailyPlanSchema = z.object({
  id: z.string().min(1),
  date: z.string().min(1),
  deckId: z.string().min(1),
  wordIds: z.array(z.string()).default([]),
  index: z.number(),
  sources: z.record(z.string(), z.enum(['goal', 'extra', 'requeue'])).default({}),
  goals: z.object({
    dailyGoal: z.number(),
    dueCount: z.number(),
    newBudget: z.number(),
    extraCount: z.number(),
  }),
  ratings: z.array(planRatingSchema).default([]),
  wcCounts: z.record(z.string(), z.record(z.string(), z.number())).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().nullable(),
})

/** 设置行（key 合法性由 settings.repo 的 SETTING_KEYS 再校验） */
export const settingRecordSchema = z.object({
  key: z.string().min(1),
  value: z.unknown(),
  updatedAt: z.number(),
})

const deckFileMetaSchema = z.object({
  wordCount: z.number().optional(),
  license: z.string().optional(),
  sourceUrl: z.string().optional(),
  copyrightNotice: z.string().optional(),
})

/** DeckFile v1 的形状（format/formatVersion 先单独判，错误信息更友好） */
const deckFileSchema = z.object({
  format: z.literal(DECK_FORMAT),
  formatVersion: z.literal(FORMAT_VERSION),
  exportedAt: z.number(),
  generator: z.string(),
  deck: deckSchema,
  words: z.array(rawWordSchema),
  meta: deckFileMetaSchema.optional(),
})

/** MigrationFile v1 的形状 */
const migrationFileSchema = z.object({
  format: z.literal(MIGRATION_FORMAT),
  formatVersion: z.literal(FORMAT_VERSION),
  exportedAt: z.number(),
  generator: z.string(),
  appVersion: z.string(),
  dataVersion: z.literal(FORMAT_VERSION),
  counts: z.object({
    decks: z.number(),
    words: z.number(),
    states: z.number(),
    reviewLogs: z.number(),
    /** v2 可选：迁移包携带的今日 plan 条数（旧包缺省 0） */
    plans: z.number().optional(),
    /** v3 可选：内容包 / 拒绝记忆条数（旧包缺省） */
    contentPacks: z.number().optional(),
    contentRejects: z.number().optional(),
  }),
  data: z.object({
    decks: z.array(deckSchema),
    words: z.array(rawWordSchema),
    states: z.array(wordStateSchema),
    reviewLogs: z.array(reviewLogSchema),
    settings: z.array(settingRecordSchema),
    /** v2 可选：只带导出当天的今日计划（≤1–2 条）；旧包缺失 */
    plans: z.array(dailyPlanSchema).optional(),
    /** v3 可选（task-69）：内容包三表（备份/换机保留 AI/导入内容与拒绝记忆） */
    contentPacks: z.array(z.object({ id: z.string(), status: z.string() }).passthrough()).optional(),
    packItems: z
      .array(z.object({ id: z.string(), packId: z.string(), status: z.string() }).passthrough())
      .optional(),
    contentRejects: z
      .array(z.object({ id: z.string(), kind: z.string(), hash: z.string() }).passthrough())
      .optional(),
  }),
  checksum: z.string().min(1),
  meta: z
    .object({
      checksumAlgo: z.enum(['sha256', 'fnv1a64']).optional(),
    })
    .optional(),
})

export type RawWord = z.infer<typeof rawWordSchema>
export type RawDeck = z.infer<typeof deckSchema>
export type RawMigration = z.infer<typeof migrationFileSchema>

// ============ 规范化 ============

interface NormalizeWordResult {
  word: Word
  issues: ImportIssue[]
}

/** 单条 raw word → 标准 Word */
export function normalizeWordRecord(
  raw: RawWord,
  deckId: string,
  index: number,
  opts: { preserveIds: boolean; now: number },
): NormalizeWordResult {
  const issues: ImportIssue[] = []
  const path = `words[${index}]`
  const headwordRaw = raw.headword ?? raw.term ?? ''
  const headword = String(headwordRaw)
    .trim()
    .replace(/\s+/g, ' ')
  if (!headword) {
    issues.push(
      makeIssue('error', 'E_FIELD', '词条缺少 headword/term', { path: `${path}.headword` }),
    )
    // 用一个占位值继续，调用方看到 error 会整体中止，不会写库
    return {
      word: buildWord(
        { headword: `invalid-word-${index + 1}`, order: index + 1, tags: ['no-meaning'] },
        deckId,
        { order: index + 1, createdAt: opts.now },
      ),
      issues,
    }
  }

  if (raw.deckId && raw.deckId !== deckId) {
    issues.push(
      makeIssue(
        'warning',
        'W_SKIPPED',
        `词条 ${headword} 的 deckId 与词库不一致，已按词库 id 重算`,
        { path: `${path}.deckId` },
      ),
    )
  }

  const computedId = wordIdOf(deckId, headword)
  const providedId = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : ''
  const wordId = opts.preserveIds && providedId ? providedId : computedId
  if (!opts.preserveIds && providedId && providedId !== computedId) {
    issues.push(
      makeIssue('warning', 'W_SKIPPED', `词条 ${headword} 的 id 已按规则重算`, {
        path: `${path}.id`,
      }),
    )
  }

  const meaningIds = raw.meanings?.map((meaning) => meaning.id).filter(Boolean)
  const meaningsInput = raw.meanings?.map((meaning) => ({
    pos: meaning.pos,
    cn: meaning.cn,
  }))
  const preservedMeaningIds =
    opts.preserveIds && meaningIds && meaningIds.length === (raw.meanings?.length ?? 0)
      ? (meaningIds as string[])
      : undefined

  const input: RawWordInput = {
    headword,
    meanings: meaningsInput,
    meaning: raw.meaning ?? undefined,
    examples: raw.examples as Example[] | undefined,
    example: raw.example ?? undefined,
    exampleTranslation: raw.exampleTranslation ?? undefined,
    phonetic: raw.phonetic ?? undefined,
    mnemonics: raw.mnemonics?.map((item) => ({
      type: item.type as Word['mnemonics'][number]['type'],
      text: item.text,
    })),
    phrases: raw.phrases,
    tags: raw.tags,
    order: raw.order,
    chapter: raw.chapter,
    frequency: raw.frequency,
    cefr: raw.cefr,
    examCount: raw.examCount,
    createdAt: raw.createdAt,
    meaningIds: preservedMeaningIds,
  }
  const word = buildWord(input, deckId, {
    wordId,
    order: raw.order ?? index + 1,
    createdAt: raw.createdAt ?? opts.now,
    preserveMeaningIds: Boolean(preservedMeaningIds),
  })
  if (opts.preserveIds && providedId) word.headwordLower = normalizeHeadword(headword)
  if (raw.maimemoVocId) word.maimemoVocId = raw.maimemoVocId
  // F6：用户笔记/助记随迁移/词库导出保留（缺失则省略，避免空数组）
  if (Array.isArray(raw.userNotes) && raw.userNotes.length > 0) {
    const notes = raw.userNotes
      .map((note, index) => ({
        id: String(note.id ?? `user-note-${word.id}-${index + 1}`),
        text: String(note.text ?? '').trim(),
        ...(note.meaningId ? { meaningId: note.meaningId } : {}),
      }))
      .filter((note) => note.text.length > 0)
    if (notes.length > 0) word.userNotes = notes
  }
  if (Array.isArray(raw.userMnemonics) && raw.userMnemonics.length > 0) {
    const mnemonics = raw.userMnemonics
      .map((mnemonic, index) => ({
        id: String(mnemonic.id ?? `user-mnemonic-${word.id}-${index + 1}`),
        type: (USER_MNEMONIC_TYPES.has(mnemonic.type) ? mnemonic.type : '其他') as NonNullable<Word['userMnemonics']>[number]['type'],
        text: String(mnemonic.text ?? '').trim(),
        ...(mnemonic.meaningId ? { meaningId: mnemonic.meaningId } : {}),
      }))
      .filter((mnemonic) => mnemonic.text.length > 0)
    if (mnemonics.length > 0) word.userMnemonics = mnemonics
  }
  if (Array.isArray(raw.hiddenMnemonicKeys)) {
    const hidden = [...new Set(raw.hiddenMnemonicKeys.filter((key): key is string => typeof key === 'string' && key.length > 0))]
    if (hidden.length > 0) word.hiddenMnemonicKeys = hidden
  }
  if (raw.derivationMap) {
    const map = raw.derivationMap
    const rootLabel = String(map.rootLabel ?? '').trim()
    const text = String(map.text ?? '').trim()
    const mermaid = String(map.mermaid ?? '').trim()
    if (rootLabel || text || mermaid) {
      word.derivationMap = {
        ...(rootLabel ? { rootLabel } : {}),
        ...(text ? { text } : {}),
        ...(mermaid ? { mermaid } : {}),
        source: map.source === 'ai' ? 'ai' : 'manual',
        updatedAt: Number.isFinite(map.updatedAt) ? map.updatedAt : Date.now(),
      }
    }
  }
  if (Number.isFinite(raw.difficulty)) {
    word.difficulty = Math.min(10, Math.max(1, Math.round(raw.difficulty!)))
  }
  // id / meaning id 与文件不一致时给 warning（迁移包依赖 id 对齐，不重算）
  if (opts.preserveIds && providedId === computedId) {
    for (let i = 0; i < word.meanings.length; i += 1) {
      const provided = meaningIds?.[i]
      if (provided && provided !== word.meanings[i]!.id) {
        issues.push(
          makeIssue('warning', 'W_SKIPPED', '释义 id 与规则不符，已按文件保留', {
            path: `${path}.meanings[${i}].id`,
          }),
        )
        break
      }
    }
  }
  if (word.tags.includes('no-meaning')) {
    issues.push(
      makeIssue('warning', 'W_NO_MEANING', `词条 ${headword} 无释义，已用单词本身兜底并标记`, {
        path: `${path}.meanings`,
      }),
    )
  }
  return { word, issues }
}

interface NormalizeWordsResult {
  words: Word[]
  issues: ImportIssue[]
}

/** 批量 raw words → 标准 Word（去重、排序） */
export function normalizeWordRecords(
  rawWords: RawWord[],
  deckId: string,
  opts: { preserveIds: boolean; now: number },
): NormalizeWordsResult {
  const issues: ImportIssue[] = []
  const byId = new Map<string, Word>()
  let duplicateCount = 0
  rawWords.forEach((raw, index) => {
    const result = normalizeWordRecord(raw, deckId, index, opts)
    issues.push(...result.issues)
    const existing = byId.get(result.word.id)
    if (existing) {
      duplicateCount += 1
      return
    }
    byId.set(result.word.id, result.word)
  })
  if (duplicateCount > 0) {
    issues.push(
      makeIssue(
        'warning',
        'W_SKIPPED',
        `词库内有 ${duplicateCount} 条重复词条（按 id 去重，保留先出现的）`,
        { path: 'words' },
      ),
    )
  }
  const words = [...byId.values()].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return { words, issues }
}

/** deck 规范化：补默认值、wordCount 与 words 对齐、默认词库唯一 */
export function normalizeDeck(raw: RawDeck, words: Word[], issues: ImportIssue[]): Deck {
  const deck: Deck = {
    id: raw.id,
    name: raw.name.trim(),
    source: raw.source,
    wordCount: words.length,
    version: raw.version,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt || raw.createdAt || 0,
  }
  if (raw.description) deck.description = raw.description
  if (raw.builtinKey) deck.builtinKey = raw.builtinKey
  if (raw.license) deck.license = raw.license
  if (raw.isDefault !== undefined) deck.isDefault = raw.isDefault
  if (raw.license && raw.wordCount && raw.wordCount !== words.length) {
    issues.push(
      makeIssue('warning', 'W_SKIPPED', `词库声明的 wordCount 与实际词条数不一致，已按实际数量修正`, {
        path: 'deck.wordCount',
      }),
    )
  }
  return deck
}

// ============ DeckFile ============

export interface ParsedDeckFile {
  file: DeckFile
  deck: Deck
  words: Word[]
  issues: ImportIssue[]
}

/** 解析结果：ok=false 时 issues 一定含 error（调用方不得写库） */
export type ParseResult<T> = { ok: true; value: T; issues: ImportIssue[] } | { ok: false; issues: ImportIssue[] }

/** 解析并规范化 DeckFile（调用方负责先做 JSON.parse） */
export function parseDeckFile(raw: unknown): ParseResult<ParsedDeckFile> {
  const issues: ImportIssue[] = []
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [makeIssue('error', 'E_FORMAT', '不是有效的 JSON 对象')] }
  }
  if (raw.format !== DECK_FORMAT) {
    return {
      ok: false,
      issues: [
        makeIssue('error', 'E_FORMAT', `不是词库文件（format 应为 ${DECK_FORMAT}）`, {
          path: 'format',
        }),
      ],
    }
  }
  if (raw.formatVersion !== FORMAT_VERSION) {
    return {
      ok: false,
      issues: [
        makeIssue('error', 'E_VERSION', `词库文件版本不支持：${String(raw.formatVersion)}`, {
          path: 'formatVersion',
        }),
      ],
    }
  }
  const parsed = deckFileSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, issues: fromZod(parsed.error) }
  }
  const now = Date.now()
  const rawDeck = parsed.data.deck
  const normalized = normalizeWordRecords(parsed.data.words, rawDeck.id, {
    preserveIds: false,
    now,
  })
  issues.push(...normalized.issues)
  const deck = normalizeDeck(rawDeck, normalized.words, issues)
  const meta = parsed.data.meta ?? {}
  if (meta.license && !deck.license) deck.license = meta.license

  const file: DeckFile = {
    format: DECK_FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: parsed.data.exportedAt,
    generator: parsed.data.generator,
    deck,
    words: normalized.words,
    meta: {
      wordCount: normalized.words.length,
      ...(deck.license ? { license: deck.license } : {}),
      ...(meta.sourceUrl ? { sourceUrl: meta.sourceUrl } : {}),
      ...(meta.copyrightNotice ? { copyrightNotice: meta.copyrightNotice } : {}),
    },
  }
  return { ok: true, value: { file, deck, words: normalized.words, issues }, issues }
}

// ============ MigrationFile ============

export interface ParsedMigrationFile {
  file: MigrationFile
  decks: Deck[]
  words: Word[]
  states: WordState[]
  reviewLogs: ReviewLog[]
  settings: SettingRecord[]
  /** v2：导入包携带的今日 plan（旧包为空数组） */
  plans: DailyPlan[]
  /** v3：内容包三表（旧包为空数组；task-69） */
  contentPacks: PackRecord[]
  packItems: PackItemRecord[]
  contentRejects: ContentRejectRecord[]
  issues: ImportIssue[]
}

/** 解析并规范化 MigrationFile（checksum 由 import-export 单独校验） */
export function parseMigrationFile(raw: unknown): ParseResult<ParsedMigrationFile> {
  if (!isPlainObject(raw)) {
    return { ok: false, issues: [makeIssue('error', 'E_FORMAT', '不是有效的 JSON 对象')] }
  }
  if (raw.format !== MIGRATION_FORMAT) {
    return {
      ok: false,
      issues: [
        makeIssue('error', 'E_FORMAT', `不是可迁移包（format 应为 ${MIGRATION_FORMAT}）`, {
          path: 'format',
        }),
      ],
    }
  }
  if (raw.formatVersion !== FORMAT_VERSION || raw.dataVersion !== FORMAT_VERSION) {
    return {
      ok: false,
      issues: [
        makeIssue('error', 'E_VERSION', '可迁移包版本不支持，请升级 App 后重试', {
          path: 'formatVersion',
        }),
      ],
    }
  }
  const parsed = migrationFileSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, issues: fromZod(parsed.error) }
  }
  const data = parsed.data.data
  const now = Date.now()
  const issues: ImportIssue[] = []

  const decks: Deck[] = []
  const seenDeckIds = new Set<string>()
  const wordsByDeck = new Map<string, RawWord[]>()
  for (const word of data.words) {
    const deckId = word.deckId ?? ''
    if (!deckId) continue
    const list = wordsByDeck.get(deckId) ?? []
    list.push(word)
    wordsByDeck.set(deckId, list)
  }

  const allWords: Word[] = []
  for (const rawDeck of data.decks) {
    if (seenDeckIds.has(rawDeck.id)) {
      issues.push(
        makeIssue('warning', 'W_SKIPPED', `重复的词库 id：${rawDeck.id}，已跳过后一个`, {
          path: 'data.decks',
        }),
      )
      continue
    }
    seenDeckIds.add(rawDeck.id)
    const normalized = normalizeWordRecords(wordsByDeck.get(rawDeck.id) ?? [], rawDeck.id, {
      preserveIds: true,
      now,
    })
    issues.push(...normalized.issues)
    const deck = normalizeDeck(rawDeck, normalized.words, issues)
    decks.push(deck)
    allWords.push(...normalized.words)
  }

  // 没有任何 deck 的孤词（极少见）：报 warning 并跳过
  const wordIds = new Set(allWords.map((word) => word.id))
  const orphanWords = wordsByDeck.size > seenDeckIds.size
  if (orphanWords) {
    issues.push(
      makeIssue('warning', 'W_SKIPPED', '有部分单词不属于包内任何词库，已跳过', {
        path: 'data.words',
      }),
    )
  }

  // 默认词库唯一
  let defaultSeen = false
  for (const deck of decks) {
    if (!deck.isDefault) continue
    if (defaultSeen) {
      delete deck.isDefault
      issues.push(
        makeIssue('warning', 'W_SKIPPED', `词库 ${deck.name} 被多个词库标记为默认，已取消`, {
          path: 'data.decks',
        }),
      )
    } else {
      defaultSeen = true
    }
  }

  // states：保留原值（AC5 往返逐字段一致），只做引用检查
  const missingWords = data.states.filter((state) => !wordIds.has(state.wordId))
  if (missingWords.length > 0) {
    issues.push(
      makeIssue(
        'warning',
        'W_SKIPPED',
        `${missingWords.length} 条学习状态找不到对应词条（仍会保留，可能来自已删除词库）`,
        { path: 'data.states' },
      ),
    )
  }

  const settingsRecords: SettingRecord[] = []
  for (const record of data.settings) {
    if (!isSettingKey(record.key)) {
      issues.push(
        makeIssue('warning', 'W_SKIPPED', `未知设置项 ${record.key}，已跳过`, {
          path: `data.settings`,
        }),
      )
      continue
    }
    settingsRecords.push(record as SettingRecord)
  }

  const importedPlans: DailyPlan[] = (data.plans ?? []) as DailyPlan[]
  const contentPacks = (data.contentPacks ?? []) as unknown as PackRecord[]
  const packItems = (data.packItems ?? []) as unknown as PackItemRecord[]
  const contentRejects = (data.contentRejects ?? []) as unknown as ContentRejectRecord[]
  const file: MigrationFile = {
    format: MIGRATION_FORMAT,
    formatVersion: FORMAT_VERSION,
    exportedAt: parsed.data.exportedAt,
    generator: parsed.data.generator,
    appVersion: parsed.data.appVersion,
    dataVersion: FORMAT_VERSION,
    counts: {
      decks: decks.length,
      words: allWords.length,
      states: data.states.length,
      reviewLogs: data.reviewLogs.length,
      ...(importedPlans.length > 0 ? { plans: importedPlans.length } : {}),
      ...(contentPacks.length > 0 ? { contentPacks: contentPacks.length } : {}),
      ...(contentRejects.length > 0 ? { contentRejects: contentRejects.length } : {}),
    } as MigrationFile['counts'] & { plans?: number; contentPacks?: number; contentRejects?: number },
    data: {
      decks,
      words: allWords,
      states: data.states,
      reviewLogs: data.reviewLogs,
      settings: settingsRecords,
      ...(importedPlans.length > 0 ? { plans: importedPlans } : {}),
    } as MigrationFile['data'] & { plans?: DailyPlan[] },
    checksum: parsed.data.checksum,
    ...(parsed.data.meta ? { meta: parsed.data.meta } : {}),
  }
  return {
    ok: true,
    value: {
      file,
      decks,
      words: allWords,
      states: data.states,
      reviewLogs: data.reviewLogs,
      settings: settingsRecords,
      plans: importedPlans,
      contentPacks,
      packItems,
      contentRejects,
      issues,
    },
    issues,
  }
}

/** id 规则自检（单测/QA 用）：返回不符合 §1.4 的词条路径 */
export function findIdRuleViolations(deckId: string, words: Word[]): string[] {
  const violations: string[] = []
  words.forEach((word, index) => {
    if (word.id !== wordIdOf(deckId, word.headword)) {
      violations.push(`words[${index}].id`)
    }
    if (word.headwordLower !== normalizeHeadword(word.headword)) {
      violations.push(`words[${index}].headwordLower`)
    }
    word.meanings.forEach((meaning: Meaning, meaningIndex) => {
      if (meaning.id !== meaningIdOf(word.id, meaningIndex + 1)) {
        violations.push(`words[${index}].meanings[${meaningIndex}].id`)
      }
    })
  })
  return violations
}
