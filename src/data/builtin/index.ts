/**
 * 内置词库（AC7 / SPEC §1.6 / §6.5）。
 *
 * 内置词库列表由 `deck-sources.ts` 配置（私版：受限商业词表 + 大纲；公开版 sanitize 后仅大纲），
 * 词库文件由 `build-builtin-decks.mjs` 生成「紧凑列式 JSON」，词数/版本以 `manifest.json` 为准。
 *
 * 打包策略：**动态 import**（`?raw` 再 JSON.parse）→ Vite 拆成独立 chunk，首屏主 bundle 不含
 * 词库数据（首屏 gzip 目标 < 300KB）；种子在启动后后台执行，一次写入 Dexie，之后读库不读文件。
 *
 * 幂等/升级：`meta.builtin.seeded = { [key]: dataVersion }`（key 由 deck-sources 决定）。
 * - 期望版本来自构建产物 `manifest.json`（静态 import，很小），**不需要解析词库 JSON 就能判断**；
 * - 版本一致且词条数吻合 → 跳过（不解析 JSON，快）；
 * - 版本不一致（数据更新）→ 重新种子：**替换该库 words**，同 wordId 的 states（学习进度）保留，
 *   新数据里已删除的词，其 states / session 快照一并清理，避免孤儿数据。
 */

import type { Deck, ImportIssue, MetaRecord, SettingRecord, Word } from '../../core'
import { getDb } from '../db'
import { wordIdOf } from '../../core'
import { buildWord } from '../word-factory'
import { BRAND } from '../../app/brand'
import { DECK_SOURCES } from './deck-sources'
import rawManifest from './manifest.json'

/** 内置词库 id 列表（完全由 `deck-sources.ts` 派生；公开版 sanitize 后仅剩大纲） */
export const BUILTIN_DECK_IDS: readonly string[] = DECK_SOURCES.map((source) => source.deckId)
export type BuiltinDeckId = string

/** `meta.builtin.seeded` 的值：每个内置词库 key 当前已种子化的 **dataVersion**（开放式，勿写死 key） */
export type BuiltinSeedMeta = Record<string, number | undefined>

/** 构建产物 manifest（版本清单） */
interface BuiltinManifest {
  decks: Array<{ key: string; deckId: string; dataVersion: number; file: string; wordCount: number }>
}

const MANIFEST = rawManifest as unknown as BuiltinManifest
/** key → 期望的 dataVersion（来自构建脚本写的 manifest.json，单一事实来源） */
const EXPECTED_DATA_VERSION: Record<string, number> = Object.fromEntries(
  MANIFEST.decks.map((deck) => [deck.key, deck.dataVersion]),
)

export interface BuiltinSeedResult {
  /** 当前 db 里的全部词库（种子后） */
  decks: Deck[]
  /** 本次实际写入/更新的内置词库 */
  seeded: BuiltinDeckId[]
  /** 版本已是最新而跳过写入的内置词库 */
  skipped: BuiltinDeckId[]
  /** 失败信息（单个词库失败不阻塞另一个） */
  issues: ImportIssue[]
}

/** 紧凑文件格式（由 build-builtin-decks.mjs 生成；列顺序见 columns 字段） */
export interface BuiltinDeckFile {
  format: 'momo-builtin-deck'
  formatVersion: 1
  /** 词库内容版本（v2 起由构建脚本写入；缺失时回退 deck.version） */
  dataVersion?: number
  generatedAt: number
  generator: string
  deck: Deck
  defaultTags: string[]
  meta: {
    wordCount: number
    dataVersion?: number
    license?: string
    copyrightNotice?: string
    sourceUrl?: string
    sourceFile?: string
    sourceEntries?: number
    /** 含义切分规则版本（task-16，v1） */
    meaningSplitVersion?: number
    meaningSplit?: {
      before: number
      after: number
      truncatedWords: number
      noMeaningWords: number
      maxPerWord: number
      rule: string
    }
    /** task-42：词组按含义归属的统计（assigned/total/coverage/rule） */
    phraseMeaning?: {
      rule: string
      assigned: number
      total: number
      coverage: number
    }
    /** 官方单词难度来源（Dataverse，CC BY-NC 4.0）与覆盖统计 */
    difficultySource?: {
      file: string
      doi: string
      license: string
      field: string
      matched: number
      total: number
      coverage: number
      missingFallback: string
    }
  }
  columns: string[]
  words: Array<Array<string | number | string[] | null>>
}

interface BuiltinDefinition {
  key: string
  deckId: BuiltinDeckId
  load: () => Promise<string>
}

/** 内置词库定义（唯一来源 = deck-sources.ts；公开版 sanitize 后只剩大纲） */
const DEFINITIONS: readonly BuiltinDefinition[] = DECK_SOURCES

export function isBuiltinDeckId(value: unknown): value is BuiltinDeckId {
  return typeof value === 'string' && (BUILTIN_DECK_IDS as readonly string[]).includes(value)
}

/**
 * 解析紧凑文件的 phrases 列：`[[en, cn, meaningIndex?], ...]` → `Word.phrases`（最多 8 条）。
 * task-42：第三项可选 = 归属含义序号（1 起，loader 还原成 `${wordId}#M{n}`；也兼容直接给完整 id 字符串）；
 * 旧数据缺第三项 → 词级（undefined）。
 */
export function parsePhrases(
  value: unknown,
  wordId = '',
): Array<{ en: string; cn: string; meaningId?: string }> {
  if (!Array.isArray(value)) return []
  const out: Array<{ en: string; cn: string; meaningId?: string }> = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!Array.isArray(item) || item.length < 2) continue
    const en = typeof item[0] === 'string' ? item[0].trim() : ''
    const cn = typeof item[1] === 'string' ? item[1].trim() : ''
    if (!en || !cn) continue
    const key = `${en.toLowerCase()}\u0000${cn}`
    if (seen.has(key)) continue
    seen.add(key)
    const phrase: { en: string; cn: string; meaningId?: string } = { en, cn }
    if (typeof item[2] === 'string' && item[2].trim()) {
      phrase.meaningId = item[2].trim()
    } else if (typeof item[2] === 'number' && Number.isInteger(item[2]) && item[2] >= 1 && wordId) {
      phrase.meaningId = `${wordId}#M${item[2]}`
    }
    out.push(phrase)
    if (out.length >= 8) break
  }
  return out
}

/** 解析紧凑文件 → Deck + Word[] + dataVersion */
export function parseBuiltinDeckFile(raw: string): {
  deck: Deck
  words: Word[]
  meta: BuiltinDeckFile['meta']
  dataVersion: number
} {
  const parsed = JSON.parse(raw) as BuiltinDeckFile
  if (parsed?.format !== 'momo-builtin-deck') {
    throw new Error('内置词库文件格式不正确（format 应为 momo-builtin-deck）')
  }
  if (parsed.formatVersion !== 1) {
    throw new Error(`内置词库文件版本不支持：${String(parsed.formatVersion)}`)
  }
  const columns = Array.isArray(parsed.columns) ? parsed.columns : []
  const columnIndex = new Map<string, number>(columns.map((name, index) => [name, index]))
  const deck = parsed.deck
  const defaultTags = Array.isArray(parsed.defaultTags) ? parsed.defaultTags : []
  const createdAt = Number.isFinite(parsed.generatedAt) ? parsed.generatedAt : deck.createdAt

  const rows = Array.isArray(parsed.words) ? parsed.words : []
  const words: Word[] = rows.map((row, index) => {
    const read = (name: string): unknown => {
      const idx = columnIndex.get(name)
      return idx == null ? undefined : row[idx]
    }
    const term = String(read('term') ?? '').trim()
    const extraTags = Array.isArray(read('extraTags'))
      ? (read('extraTags') as string[]).filter((tag) => typeof tag === 'string')
      : []
    // 官方单词难度（1–10）：未命中 → 兜底 5 + difficulty-estimated tag（task-25）
    const difficultyRaw = read('difficulty')
    const hasDifficulty =
      typeof difficultyRaw === 'number' && Number.isFinite(difficultyRaw) && difficultyRaw > 0
    const difficulty = hasDifficulty
      ? Math.min(10, Math.max(1, Math.round(difficultyRaw)))
      : 5
    const tags = [...defaultTags, ...extraTags]
    if (!hasDifficulty) tags.push('difficulty-estimated')
    const word = buildWord(
      {
        headword: term,
        order: Number.isFinite(read('order')) ? (read('order') as number) : index + 1,
        meaning: typeof read('meaning') === 'string' ? (read('meaning') as string) : undefined,
        example: typeof read('example') === 'string' ? (read('example') as string) : undefined,
        exampleTranslation:
          typeof read('exampleTranslation') === 'string'
            ? (read('exampleTranslation') as string)
            : undefined,
        chapter: typeof read('chapter') === 'string' ? (read('chapter') as string) : undefined,
        frequency: Number.isFinite(read('frequency')) ? (read('frequency') as number) : undefined,
        cefr: typeof read('cefr') === 'string' ? (read('cefr') as string) : undefined,
        examCount: Number.isFinite(read('examCount')) ? (read('examCount') as number) : undefined,
        phonetic: typeof read('phonetic') === 'string' ? (read('phonetic') as string) : undefined,
        tags,
        phrases: parsePhrases(read('phrases'), wordIdOf(deck.id, term)),
      },
      deck.id,
      {
        order: Number.isFinite(read('order')) ? (read('order') as number) : index + 1,
        createdAt,
      },
    )
    word.difficulty = difficulty
    return word
  })
  // 防御：文件内顺序应已按 order 排好；这里再排一次，保证「顺序学习」稳定
  words.sort((a, b) => (a.order !== b.order ? a.order - b.order : a.id < b.id ? -1 : 1))
  const dataVersion =
    Number.isFinite(parsed.dataVersion) && (parsed.dataVersion as number) > 0
      ? (parsed.dataVersion as number)
      : Number.isFinite(deck.version) && deck.version > 0
        ? deck.version
        : 1
  return {
    deck: { ...deck, version: dataVersion, wordCount: words.length },
    words,
    meta: parsed.meta,
    dataVersion,
  }
}

/** 读 `meta.builtin.seeded` */
async function readSeedMeta(): Promise<BuiltinSeedMeta> {
  const db = getDb()
  const row = await db.meta.get('builtin.seeded')
  const value = row?.value as BuiltinSeedMeta | undefined
  return value && typeof value === 'object' ? value : {}
}

/** 已种子化且词条数吻合 → 无需重新解析 JSON */
async function isUpToDate(definition: BuiltinDefinition, seeded: BuiltinSeedMeta): Promise<boolean> {
  const db = getDb()
  const expected = EXPECTED_DATA_VERSION[definition.key]
  if (!expected) return false
  // 记录里的版本与构建产物版本不一致 → 需要重新种子（老安装也能拿到数据更新）
  if (seeded[definition.key] !== expected) return false
  const deck = await db.decks.get(definition.deckId)
  if (!deck) return false
  if (deck.version !== expected) return false
  const count = await db.words.where('deckId').equals(definition.deckId).count()
  return count === deck.wordCount && count > 0
}

async function seedOne(
  definition: BuiltinDefinition,
): Promise<{ deck: Deck; dataVersion: number }> {
  const db = getDb()
  const raw = await definition.load()
  const { deck, words, dataVersion } = parseBuiltinDeckFile(raw)
  if (words.length === 0) throw new Error('内置词库词条为空，请重新构建词库文件')
  const now = Date.now()
  await db.transaction('rw', db.decks, db.words, db.states, db.meta, async () => {
    // 升级/重装：先记旧词 id，再整体替换该库词条（同 wordId 的 states 学习进度保留）
    const oldWordIds = (await db.words
      .where('deckId')
      .equals(definition.deckId)
      .primaryKeys()) as string[]
    await db.words.where('deckId').equals(definition.deckId).delete()
    // task-58：默认在学词库由 BRAND.defaultDeckId 决定；公开版（仅大纲）也要标记 isDefault
    await db.decks.put({
      ...deck,
      isDefault: deck.isDefault || definition.deckId === BRAND.defaultDeckId,
      updatedAt: now,
    })
    // §6.5：bulkPut 分批 500 条，手机端写入更稳
    const CHUNK = 500
    for (let i = 0; i < words.length; i += CHUNK) {
      await db.words.bulkPut(words.slice(i, i + CHUNK))
    }
    // 新数据里已不存在的词：清理孤儿 states 与 session 快照（避免脏数据长期滞留）
    const newWordIds = new Set(words.map((word) => word.id))
    const orphans = oldWordIds.filter((wordId) => !newWordIds.has(wordId))
    if (orphans.length > 0) {
      await db.states.bulkDelete(orphans)
      await db.meta.bulkDelete(orphans.map((wordId) => `session:${wordId}`))
    }

    // 含义按语义拆分后 meaningId 顺序会变：清理 states 里失效的 meaningStats key（保留仍有效的）
    const meaningIdsByWord = new Map(words.map((word) => [word.id, new Set(word.meanings.map((m) => m.id))]))
    const statesForDeck = await db.states.where('deckId').equals(definition.deckId).toArray()
    const cleanedStates: typeof statesForDeck = []
    for (const state of statesForDeck) {
      const valid = meaningIdsByWord.get(state.wordId)
      if (!valid) continue
      const stats = state.meaningStats ?? {}
      const keys = Object.keys(stats)
      const keptKeys = keys.filter((key) => valid.has(key))
      if (keptKeys.length === keys.length) continue
      const nextStats: typeof stats = {}
      for (const key of keptKeys) nextStats[key] = stats[key]!
      cleanedStates.push({ ...state, meaningStats: nextStats, updatedAt: now })
    }
    if (cleanedStates.length > 0) await db.states.bulkPut(cleanedStates)

    // 旧 meaningId 的 w-c 会话快照也失效：清掉该词库的 session 快照（评分后本来也会删）
    const sessionKeys = (await db.meta
      .where('key')
      .startsWith(`session:${definition.deckId}:`)
      .primaryKeys()) as string[]
    if (sessionKeys.length > 0) await db.meta.bulkDelete(sessionKeys)
  })
  return { deck, dataVersion }
}

let inFlight: Promise<BuiltinSeedResult> | null = null

/**
 * 确保内置词库已种子化（幂等、可并发调用）。
 *
 * - 首次启动 / 内置词库版本升级 / 手动 `resetDatabase` 后调用；
 * - 单个词库失败只记 issue，不阻塞另一个（SPEC §6.5）；
 * - 不写 states（新词状态懒创建，见 study.repo.ts 顶部说明）。
 */
export async function ensureBuiltinDecks(opts: { force?: boolean } = {}): Promise<BuiltinSeedResult> {
  if (inFlight && !opts.force) return inFlight
  const run = (async (): Promise<BuiltinSeedResult> => {
    const db = getDb()
    const issues: ImportIssue[] = []
    const seeded: BuiltinDeckId[] = []
    const skipped: BuiltinDeckId[] = []
    const seedMeta = await readSeedMeta()
    const nextMeta: BuiltinSeedMeta = { ...seedMeta }

    for (const definition of DEFINITIONS) {
      try {
        if (!opts.force && (await isUpToDate(definition, seedMeta))) {
          skipped.push(definition.deckId)
          continue
        }
        const result = await seedOne(definition)
        nextMeta[definition.key] = result.dataVersion
        seeded.push(definition.deckId)
      } catch (error) {
        issues.push({
          level: 'error',
          code: 'E_IO',
          message: `内置词库 ${definition.deckId} 加载失败：${
            error instanceof Error ? error.message : String(error)
          }（可重试或手动导入）`,
          field: definition.deckId,
        })
      }
    }

    if (seeded.length > 0 || Object.keys(nextMeta).length !== Object.keys(seedMeta).length) {
      const record: MetaRecord<BuiltinSeedMeta> = {
        key: 'builtin.seeded',
        value: nextMeta,
        updatedAt: Date.now(),
      }
      await db.meta.put(record)
    }

    // 首次种子后确保「当前在学词库」有效
    const [settingsRow, decks] = await Promise.all([db.settings.get('data.selectedDeckId'), db.decks.toArray()])
    const selectedId = settingsRow?.value as string | undefined
    const selectedExists = selectedId ? decks.some((deck) => deck.id === selectedId) : false
    if (!selectedExists && decks.length > 0) {
      const fallback =
        decks.find((deck) => deck.id === BRAND.defaultDeckId) ??
        decks.find((deck) => deck.isDefault) ??
        decks.find((deck) => deck.id === DECK_SOURCES[0]?.deckId) ??
        decks[0]!
      const selectedRecord: SettingRecord = {
        key: 'data.selectedDeckId',
        value: fallback.id,
        updatedAt: Date.now(),
      }
      await db.settings.put(selectedRecord)
    }

    // task-69：builtin 数据版本升级会整体替换 words → 已应用的内容包条目必须重放（幂等、只补缺）
    if (seeded.length > 0) {
      try {
        const { reapplyAppliedPacks } = await import('../packs.repo')
        await reapplyAppliedPacks()
      } catch {
        // 重放失败不阻塞种子；用户下次打开/重新应用仍可恢复
      }
    }

    const finalDecks = await (async () => {
      const all = await db.decks.toArray()
      return all.sort((a, b) => {
        if (Boolean(a.isDefault) !== Boolean(b.isDefault)) return a.isDefault ? -1 : 1
        if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
      })
    })()

    return { decks: finalDecks, seeded, skipped, issues }
  })()
  inFlight = run
  try {
    return await run
  } finally {
    if (inFlight === run) inFlight = null
  }
}
