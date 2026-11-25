/**
 * 词库管理（SPEC §2.3 / §8.4 / AC6）。
 *
 * 提供 UI 直接调用的 CRUD + 分页/搜索。**UI 不直接写 db**（§2.2-5）。
 * 所有写操作在 `db.transaction` 内完成，并同步维护 `deck.wordCount / updatedAt`。
 */

import { familiarity, isDue, newDeckId, normalizeHeadword, wordIdOf } from '../core'
import type { Deck, DeckSource, Word } from '../core'
import { getDb } from './db'
import { BRAND } from '../app/brand'
import { DECK_SOURCES } from './builtin/deck-sources'
import { buildWord, buildInitialState } from './word-factory'
import { scrubPlansForRemovedWords } from './word-mutation'
import { getLearningWriteSource } from './learning-write-source'
import { sqliteQuery, sqliteTx } from './native-sqlite'
import { mapSqlitePlanRow } from './sqlite-read'
import { planRow } from './plan-sqlite'
import { bumpDataEpoch } from './data-epoch'
import { assertIdbMutationAllowed } from './learning-write-source'
import { withDataWriteLock } from './write-lock'
import {
  ContentWriteError,
  getContentWriteSource,
  saveContentEntitiesChunked,
} from './content-write-source'
import type { ContentEntityRow, SaveContentEntitiesResult } from './content-write-source'
import { wordOverlayOf } from './content-snapshot'
import type { RawWordInput } from './word-factory'

/** 词库学习进度（词库列表/详情页用） */
export interface DeckProgress {
  deckId: string
  /** 词条总数 */
  wordCount: number
  /** 已学（phase !== 'new'） */
  studiedCount: number
  /** 未学 */
  newCount: number
  learningCount: number
  reviewCount: number
  lapsedCount: number
  masteredCount: number
  suspendedCount: number
  /** 今天到期（含已过期） */
  dueCount: number
  /** 已学占比 0–1 */
  progress: number
}

/** 词库详情页分页查询 */
export interface WordPageQuery {
  offset?: number
  limit?: number
  /** all=全部 / new=未学 / studied=已学 */
  filter?: 'all' | 'new' | 'studied'
  /** 搜索：英文前缀/包含 或 中文释义包含（大小写不敏感） */
  search?: string
  tag?: string
  /** 0.3.89 补：排序（默认 order；familiarity 缺失最后；due 升序无 due 最后） */
  sort?: 'order' | 'alpha' | 'due' | 'familiarity'
  /** 0.3.91：方向，默认 asc */
  direction?: 'asc' | 'desc'
  /** 0.3.94：不熟悉度维度（sort=familiarity 时生效） */
  dimension?: 'meaning' | 'coreSense'
}

export interface WordPage {
  words: Word[]
  total: number
  offset: number
  limit: number
}

export interface CreateDeckInput {
  name: string
  description?: string
  source?: DeckSource
  license?: string
  words?: RawWordInput[]
}

const MAX_PAGE_LIMIT = 500

function normalizeDeckName(name: string): string {
  const value = String(name ?? '').trim()
  if (!value) throw new Error('词库名称不能为空')
  if (value.length > 64) throw new Error('词库名称不能超过 64 个字符')
  return value
}

async function assertNameAvailable(name: string, exceptDeckId?: string): Promise<void> {
  const db = getDb()
  const same = await db.decks.where('name').equals(name).first()
  if (same && same.id !== exceptDeckId) throw new Error(`已存在同名词库：${name}`)
}

/** 词库内最大 order（新增词条时接着排） */
async function maxOrder(deckId: string): Promise<number> {
  const db = getDb()
  const last = await db.words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .last()
  return last?.order ?? 0
}

async function refreshDeckCount(deckId: string, now: number): Promise<Deck | undefined> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) return undefined
  const wordCount = await db.words.where('deckId').equals(deckId).count()
  if (deck.wordCount !== wordCount) {
    const next: Deck = { ...deck, wordCount, updatedAt: now }
    await db.decks.put(next)
    return next
  }
  return deck
}

// ============ 0.14 自定义内容统一写源（B4） ============

/**
 * 自定义 deck/word 的 content_kv 行（key 规范：`deck:<id>` / `word:<id>`）。
 * 内置不可变词正文不进入 content_kv（本文件的写入口只处理用户新建/导入的自定义内容）。
 */
export function contentRowOfDeck(deck: Deck): ContentEntityRow {
  return { key: `deck:${deck.id}`, kind: 'deck', json: JSON.stringify(deck), updatedAt: deck.updatedAt }
}

export function contentRowOfWord(word: Word, updatedAt: number = Number(word.createdAt) || Date.now()): ContentEntityRow {
  return { key: `word:${word.id}`, kind: 'word', json: JSON.stringify(word), updatedAt }
}

/** sqlite 内容写源失败：抛结构化错误（已写条数写进 message），**不回写 IDB** */
function contentWriteFailure(label: string, result: SaveContentEntitiesResult, total: number): ContentWriteError {
  return new ContentWriteError(
    `${label}内容写入 SQLite 失败（已写 ${result.written}/${total} 条，失败批未回写 IDB）：${result.error ?? '未知错误'}`,
    'CONTENT_SQLITE_WRITE_FAILED',
  )
}

/** 写自定义 deck/word 内容行（sqlite 模式；成功后由 saveContentEntities* 写 IDB cache） */
async function saveCustomContentRows(rows: readonly ContentEntityRow[]): Promise<SaveContentEntitiesResult> {
  const saved = await saveContentEntitiesChunked(rows)
  // B-P1-2：分批失败时补偿已写前缀（tombstone），避免留下半成品 deck/词
  if (!saved.ok && saved.written > 0) {
    const prefix = rows.slice(0, saved.written).map((row) => ({ ...row, json: 'null', deleted: true }))
    try {
      const { writeContentRows } = await import('./content-store')
      await writeContentRows(prefix as never)
    } catch {
      /* 补偿失败由调用方结构化错误暴露 */
    }
  }
  return saved
}

/**
 * 新建/导入自定义词：word 正文行 + （wordCount 变化时）deck 元数据行同批写。
 * deck 行放最后：部分失败时只可能少记 wordCount（下次写入按 IDB cache 实际计数自愈）。
 */
async function saveCustomWordRows(
  deck: Deck,
  words: readonly Word[],
  now: number,
  countAfter: number,
  label: string,
): Promise<void> {
  const rows: ContentEntityRow[] = words.map((word) => contentRowOfWord(word, word.createdAt || now))
  if (countAfter !== deck.wordCount) rows.push(contentRowOfDeck({ ...deck, wordCount: countAfter, updatedAt: now }))
  const saved = await saveCustomContentRows(rows)
  if (!saved.ok) throw contentWriteFailure(label, saved, rows.length)
}

/** 0.15：重建 Word（update/upsert/批量）时保留用户 overlay，避免刷新词条丢笔记/助记/词源/引申图 */
function withPreservedWordOverlay(word: Word, existing: Word | undefined): Word {
  if (!existing) return word
  const overlay = wordOverlayOf(existing as unknown as Record<string, unknown>)
  return Object.keys(overlay).length > 0 ? ({ ...word, ...overlay } as Word) : word
}

/** 内置词库（正文来自打包资源）判定：其词正文不进 content_kv，删除时只清 overlay */
function isBuiltinDeck(deck: Deck): boolean {
  if (deck.builtinKey) return true
  if (deck.source === 'builtin') return true
  return DECK_SOURCES.some((source) => source.deckId === deck.id)
}

/** 0.14：sqlite 内容源下内置词正文不可变（来自打包资源），禁止按普通词编辑/删除 */
async function assertBuiltinWordMutable(word: Word, action: string): Promise<void> {
  // 0.15：内置 deck 里用户后加的 custom 词是可变的；只有打包正文 fail-closed
  if (word.custom === true) return
  const deck = await getDb().decks.get(word.deckId)
  if (deck && isBuiltinDeck(deck)) {
    // 0.14 遗留：用户后加词可能没有 custom 标记。按打包词表差集识别并补标记，避免误拦截。
    const source = DECK_SOURCES.find((item) => item.deckId === deck.id)
    if (source) {
      try {
        const { parseBuiltinDeckFile } = await import('./builtin')
        const parsed = parseBuiltinDeckFile(await source.load())
        if (!parsed.words.some((item) => item.id === word.id)) {
          const next = { ...word, custom: true as const }
          await getDb().words.put(next)
          return
        }
      } catch {
        /* 读取打包正文失败时保持 fail-closed */
      }
    }
    throw new Error(`E_UNSUPPORTED: sqlite 内容写源下内置词库词条不支持${action}（正文来自打包资源）`)
  }
}

/** 删除自定义词：word tombstone + deck.wordCount 行；SQLite 成功后才由 helper 写 IDB cache */
async function tombstoneWordContent(word: Word, now: number): Promise<void> {
  const db = getDb()
  const deck = await db.decks.get(word.deckId)
  const countAfter = Math.max(0, (await db.words.where('deckId').equals(word.deckId).count()) - 1)
  const rows: ContentEntityRow[] = [
    { key: `word:${word.id}`, kind: 'word', json: 'null', deleted: true, updatedAt: now },
    { key: `word-overlay:${word.id}`, kind: 'word-overlay', json: 'null', deleted: true, updatedAt: now },
  ]
  if (deck && countAfter !== deck.wordCount) rows.push(contentRowOfDeck({ ...deck, wordCount: countAfter, updatedAt: now }))
  const saved = await saveCustomContentRows(rows)
  if (!saved.ok) throw contentWriteFailure('删除词条', saved, rows.length)
}

/** 词 overlay 内容行（无 overlay 返回 null；删除补偿恢复用） */
function wordOverlayContentRow(word: Word, now: number): ContentEntityRow | null {
  const overlay = wordOverlayOf(word as unknown as Record<string, unknown>)
  if (Object.keys(overlay).length === 0) return null
  return { key: `word-overlay:${word.id}`, kind: 'word-overlay', json: JSON.stringify(overlay), updatedAt: now }
}

/**
 * 删除词库的内容 tombstone：deck 行 + 自定义词行；
 * 内置词库只 tombstone overlay 行（词正文来自资源，不进 content_kv）。
 * 默认词库被删时，把兜底词库的新默认标记同批写入（避免 cache 领先事实源）。
 */
async function tombstoneDeckContent(deck: Deck, now: number, defaultFallbackDeckId?: string | null): Promise<void> {
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  const rows: ContentEntityRow[] = [
    { key: `deck:${deck.id}`, kind: 'deck', json: 'null', deleted: true, updatedAt: now },
  ]
  if (isBuiltinDeck(deck)) {
    for (const word of words) {
      const overlay = wordOverlayOf(word as unknown as Record<string, unknown>)
      if (Object.keys(overlay).length > 0) {
        rows.push({ key: `word-overlay:${word.id}`, kind: 'word-overlay', json: 'null', deleted: true, updatedAt: now })
      }
    }
  } else {
    for (const word of words) {
      rows.push({ key: `word:${word.id}`, kind: 'word', json: 'null', deleted: true, updatedAt: now })
      // P1：自定义 deck 删除时同批清 overlay，避免重新导入同 deck 后旧笔记复活
      if (wordOverlayContentRow(word, now)) {
        rows.push({ key: `word-overlay:${word.id}`, kind: 'word-overlay', json: 'null', deleted: true, updatedAt: now })
      }
    }
  }
  if (defaultFallbackDeckId) {
    const fallback = await db.decks.get(defaultFallbackDeckId)
    if (fallback) rows.push(contentRowOfDeck({ ...fallback, isDefault: true, updatedAt: now }))
  }
  const saved = await saveCustomContentRows(rows)
  if (!saved.ok) throw contentWriteFailure('删除词库', saved, rows.length)
}

/**
 * 删除补偿：content tombstone 成功后 facts 级联失败 → 用删除前快照把 content 行 upsert 回来
 * （SQLite 恢复 + helper 写回 IDB cache），再抛出原始错误；恢复也失败时给结构化错误。
 */
async function restoreContentAfterFailedDelete(rows: readonly ContentEntityRow[], cause: unknown): Promise<never> {
  const causeMessage = cause instanceof Error ? cause.message : String(cause)
  try {
    const saved = await saveCustomContentRows(rows)
    if (!saved.ok) throw new Error(saved.error ?? '未知错误')
  } catch (restoreError) {
    const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError)
    throw new ContentWriteError(
      `删除失败（${causeMessage}），且内容恢复失败（${restoreMessage}）；请从备份恢复`,
      'CONTENT_SQLITE_ROLLBACK_FAILED',
    )
  }
  throw cause instanceof Error ? cause : new Error(causeMessage)
}

/** 写单条 deck 内容行（sqlite 模式） */
async function savedDeckContent(deck: Deck, label: string): Promise<void> {
  const rows = [contentRowOfDeck(deck)]
  const saved = await saveCustomContentRows(rows)
  if (!saved.ok) throw contentWriteFailure(label, saved, rows.length)
}

// ============ 查询 ============

/** 全部词库：默认词库（isDefault）优先，其余按创建时间升序 */
export async function listDecks(): Promise<Deck[]> {
  const db = getDb()
  const decks = await db.decks.toArray()
  return decks.sort((a, b) => {
    if (Boolean(a.isDefault) !== Boolean(b.isDefault)) return a.isDefault ? -1 : 1
    if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 单个词库 */
export async function getDeck(deckId: string): Promise<Deck | null> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  return deck ?? null
}

/** 词库学习进度（未学的词条没有 states 行，按 wordCount - 已学 计算） */
export async function getDeckProgress(deckId: string, now: number = Date.now()): Promise<DeckProgress> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  const wordCount = deck ? await db.words.where('deckId').equals(deckId).count() : 0
  const states = await db.states.where('deckId').equals(deckId).toArray()
  let learningCount = 0
  let reviewCount = 0
  let lapsedCount = 0
  let masteredCount = 0
  let suspendedCount = 0
  let dueCount = 0
  for (const state of states) {
    if (state.phase === 'learning') learningCount += 1
    else if (state.phase === 'review') reviewCount += 1
    else if (state.phase === 'lapsed') lapsedCount += 1
    else if (state.phase === 'mastered') masteredCount += 1
    else if (state.phase === 'suspended') suspendedCount += 1
    if (isDue(state, now)) dueCount += 1
  }
  const studiedCount = states.filter((state) => state.phase !== 'new').length
  return {
    deckId,
    wordCount,
    studiedCount,
    newCount: Math.max(0, wordCount - studiedCount),
    learningCount,
    reviewCount,
    lapsedCount,
    masteredCount,
    suspendedCount,
    dueCount,
    progress: wordCount > 0 ? studiedCount / wordCount : 0,
  }
}

/** 分页取词（词库详情页；大词库用虚拟滚动 + 这里分页） */
export async function getWordsPage(deckId: string, query: WordPageQuery = {}): Promise<WordPage> {
  const db = getDb()
  const limit = Math.min(MAX_PAGE_LIMIT, Math.max(1, Math.floor(query.limit ?? 50)))
  const offset = Math.max(0, Math.floor(query.offset ?? 0))
  const filter = query.filter ?? 'all'
  const search = (query.search ?? '').trim()
  const tag = (query.tag ?? '').trim()
  const sort = query.sort ?? 'order'
  const direction = query.direction ?? 'asc'
  const sign = direction === 'desc' ? -1 : 1

  // 快路径：无过滤/无搜索且默认 order/asc → 直接走 [deckId+order] 索引分页
  if (filter === 'all' && !search && !tag && sort === 'order' && direction === 'asc') {
    const total = await db.words.where('deckId').equals(deckId).count()
    const words = await db.words
      .where('[deckId+order]')
      .between([deckId, -Infinity], [deckId, Infinity])
      .offset(offset)
      .limit(limit)
      .toArray()
    return { words, total, offset, limit }
  }

  // 慢路径：过滤/搜索需要在词库范围内扫描（≤5528 词，一次性在内存过滤）
  const all = await db.words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .toArray()
  const states = await db.states.where('deckId').equals(deckId).toArray()
  const studied = new Set(states.filter((state) => state.phase !== 'new').map((state) => state.wordId))
  const lowerQuery = search.toLowerCase()

  const matches = all.filter((word) => {
    if (tag && !word.tags.includes(tag)) return false
    if (filter === 'new' && studied.has(word.id)) return false
    if (filter === 'studied' && !studied.has(word.id)) return false
    if (!lowerQuery) return true
    if (word.headwordLower.includes(lowerQuery)) return true
    return word.meanings.some((meaning) => meaning.cn.toLowerCase().includes(lowerQuery))
  })
  const stateById = new Map(states.map((state) => [state.wordId, state]))
  // 0.3.92：预计算 familiarity，避免排序比较器里 O(n) find（词库 5528 时性能断崖）
  const familiarityById = new Map<string, number | null>()
  const dimension = query.dimension ?? 'meaning'
  for (const state of states) {
    const stats = dimension === 'coreSense' ? state.coreSenseStats : state.meaningStats
    const values = Object.values(stats ?? {})
      .filter((stat) => stat && stat.encounters > 0)
      .map((stat) => familiarity(stat.clicks, stat.encounters))
      .filter((value): value is number => value != null)
    familiarityById.set(
      state.wordId,
      values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length,
    )
  }
  const sorted = [...matches]
  sorted.sort((a, b) => {
    const byOrder = a.order - b.order || a.id.localeCompare(b.id)
    if (sort === 'alpha') {
      const cmp = a.headwordLower.localeCompare(b.headwordLower)
      return cmp !== 0 ? sign * cmp : byOrder
    }
    if (sort === 'due' || sort === 'familiarity') {
      const av = sort === 'due' ? (stateById.get(a.id)?.dueAt ?? Infinity) : (familiarityById.get(a.id) ?? Infinity)
      const bv = sort === 'due' ? (stateById.get(b.id)?.dueAt ?? Infinity) : (familiarityById.get(b.id) ?? Infinity)
      if (av !== bv) return av === Infinity ? 1 : bv === Infinity ? -1 : sign * (av - bv)
      return byOrder
    }
    return sign * byOrder
  })
  return {
    words: sorted.slice(offset, offset + limit),
    total: sorted.length,
    offset,
    limit,
  }
}

/** 取单个词条 */
export async function getWord(wordId: string): Promise<Word | null> {
  const db = getDb()
  const word = await db.words.get(wordId)
  return word ?? null
}

/** 按 id 批量取词（渲染队列用） */
export async function getWords(wordIds: readonly string[]): Promise<Word[]> {
  const db = getDb()
  const rows = await db.words.bulkGet([...wordIds])
  return rows.filter((word): word is Word => Boolean(word))
}

/**
 * 搜索词条：英文前缀（走 headwordLower 索引）优先，其次中文释义包含；结果按 order 升序。
 */
export async function searchWords(
  deckId: string | null,
  rawQuery: string,
  limit = 20,
): Promise<Word[]> {
  const db = getDb()
  const query = rawQuery.trim()
  if (!query || limit <= 0) return []
  const lower = query.toLowerCase()
  const max = Math.min(MAX_PAGE_LIMIT, Math.floor(limit))

  const prefix = await db.words.where('headwordLower').startsWith(lower).toArray()
  const scoped = (list: Word[]) =>
    deckId == null ? list : list.filter((word) => word.deckId === deckId)
  const result = new Map<string, Word>()
  for (const word of scoped(prefix)) {
    if (result.size >= max) break
    result.set(word.id, word)
  }
  if (result.size < max) {
    // 中文/包含搜索：在词库范围内扫（有 deckId 才有界；无 deckId 时最多扫 5000 条）
    const base = deckId
      ? await db.words.where('[deckId+order]').between([deckId, -Infinity], [deckId, Infinity]).toArray()
      : await db.words.orderBy('headwordLower').limit(5000).toArray()
    for (const word of base) {
      if (result.size >= max) break
      if (result.has(word.id)) continue
      if (word.headwordLower.includes(lower) || word.meanings.some((m) => m.cn.toLowerCase().includes(lower))) {
        result.set(word.id, word)
      }
    }
  }
  return [...result.values()]
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    })
    .slice(0, max)
}

// ============ 写操作 ============

/** 新建词库（可同时带初始词条）；重名会 throw */
export async function createDeck(input: string | CreateDeckInput): Promise<Deck> {
  const db = getDb()
  const options: CreateDeckInput = typeof input === 'string' ? { name: input } : input
  const name = normalizeDeckName(options.name)
  await assertNameAvailable(name)
  const now = Date.now()
  const deckCount = await db.decks.count()
  // 先钉死 deckId 再建词（Word.id 依赖 deckId）
  let deckId = newDeckId(name, now)
  while (await db.decks.get(deckId)) deckId = `${deckId}-${Math.random().toString(36).slice(2, 6)}`
  const finalWords = (options.words ?? []).map((raw, index) =>
    buildWord(raw, deckId, { order: raw.order ?? index + 1, createdAt: now }),
  )
  const deck: Deck = {
    id: deckId,
    name,
    source: options.source ?? 'custom',
    wordCount: finalWords.length,
    version: 1,
    isDefault: deckCount === 0,
    createdAt: now,
    updatedAt: now,
  }
  if (options.description) deck.description = options.description
  if (options.license) deck.license = options.license
  // 0.14 B4：sqlite 内容写源——先写 content_kv（deck/word 行），成功后才由写源 helper 写 IDB cache；
  // 失败直接抛结构化错误，IDB 不落任何新建内容（避免双源）。
  if ((await getContentWriteSource()) === 'sqlite') {
    const rows: ContentEntityRow[] = [contentRowOfDeck(deck), ...finalWords.map((word) => contentRowOfWord(word, now))]
    const saved = await saveCustomContentRows(rows)
    if (!saved.ok) throw contentWriteFailure('新建词库', saved, rows.length)
    // 第一个词库自动设为在学（settings 事实源写入，不属于内容写源）
    if (deckCount === 0) {
      await db.settings.put({ key: 'data.selectedDeckId', value: deckId, updatedAt: now })
    }
    return deck
  }
  await db.transaction('rw', db.decks, db.words, db.settings, async () => {
    await db.decks.put(deck)
    if (finalWords.length > 0) await db.words.bulkPut(finalWords)
    // 第一个词库自动设为在学（避免空库时 selectedDeckId 指向不存在的库）
    if (deckCount === 0) {
      await db.settings.put({ key: 'data.selectedDeckId', value: deckId, updatedAt: now })
    }
  })
  return deck
}

/** 重命名词库 */
export async function renameDeck(deckId: string, name: string): Promise<Deck> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const nextName = normalizeDeckName(name)
  await assertNameAvailable(nextName, deckId)
  const next: Deck = { ...deck, name: nextName, updatedAt: Date.now() }
  if ((await getContentWriteSource()) === 'sqlite') {
    await savedDeckContent(next, '重命名词库')
    return next
  }
  await db.decks.put(next)
  return next
}

/** 更新词库元数据（名称/描述/许可/默认标记） */
export async function updateDeck(
  deckId: string,
  patch: { name?: string; description?: string; license?: string; isDefault?: boolean },
): Promise<Deck> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const now = Date.now()
  const next: Deck = { ...deck, updatedAt: now }
  if (patch.name !== undefined) {
    next.name = normalizeDeckName(patch.name)
    await assertNameAvailable(next.name, deckId)
  }
  if (patch.description !== undefined) next.description = patch.description
  if (patch.license !== undefined) next.license = patch.license
  if (patch.isDefault !== undefined) next.isDefault = patch.isDefault
  if ((await getContentWriteSource()) === 'sqlite') {
    if (patch.isDefault === true) {
      // 默认词库全局唯一：只把 isDefault 变化的 deck 行写 content_kv（同批）。
      // isDefault 是可变 deck 元数据：内置 deck 行也允许写入 content_kv（内置不可变的是词正文）。
      const decks = await db.decks.toArray()
      const beforeJson = new Map(decks.map((item) => [item.id, JSON.stringify(item)]))
      const all = decks.map((item) =>
        item.id === deckId ? { ...next, isDefault: true } : { ...item, isDefault: false },
      )
      const changed = all.filter((item) => beforeJson.get(item.id) !== JSON.stringify(item))
      if (changed.length > 0) {
        const saved = await saveCustomContentRows(changed.map((item) => contentRowOfDeck(item)))
        if (!saved.ok) throw contentWriteFailure('更新词库', saved, changed.length)
      }
    } else {
      await savedDeckContent(next, '更新词库')
    }
    return next
  }
  await db.transaction('rw', db.decks, async () => {
    if (patch.isDefault === true) {
      // 默认词库全局唯一
      const all = await db.decks.toArray()
      await db.decks.bulkPut(
        all.map((item) =>
          item.id === deckId ? { ...next, isDefault: true } : { ...item, isDefault: false },
        ),
      )
    } else {
      await db.decks.put(next)
    }
  })
  return next
}

/**
 * 删除词库（同时删词条/学习状态/该库复习日志）。
 * 若删的是当前在学词库，会把 `data.selectedDeckId` 切到默认词库/其它词库。
 * 内置词库删除后会清掉 `meta.builtin.seeded` 对应记录，下次 ensureBuiltinDecks 可重装。
 */
type DeleteDeckOptions = {
  /** 0.10.0：该库有学习进度时必须先备份；不提供且 unsafe!=true 时拒绝 */
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  unsafe?: boolean
}

export async function deleteDeck(
  deckId: string,
  opts: DeleteDeckOptions = {},
): Promise<void> {
  const contentSqlite = (await getContentWriteSource()) === 'sqlite'
  if (contentSqlite) {
    const deck = await getDb().decks.get(deckId)
    // 0.14 fail-closed：内置词库正文来自打包资源，删除会清 builtin.seeded（下次 seed 复活），
    // 且 content_kv tombstone 与 ensureBuiltinDecks/cache 重建存在冲突；如需删除请先切回 idb。
    if (deck && isBuiltinDeck(deck)) {
      throw new Error('E_UNSUPPORTED: sqlite 内容写源暂不支持删除内置词库（正文来自打包资源，删除会与内置 seed/缓存重建冲突）')
    }
  }
  if (getLearningWriteSource() === 'sqlite') {
    return withDataWriteLock(() => deleteDeckSqlite(deckId, opts, contentSqlite))
  }
  assertIdbMutationAllowed('删除词库')
  if (contentSqlite) return withDataWriteLock(() => deleteDeckContentSqlite(deckId, opts))
  return withDataWriteLock(() => deleteDeckInner(deckId, opts))
}

/** 删除前必备份校验（0.10.0：有学习进度时必须先成功预备份） */
async function requireDeckDeleteBackup(deck: Deck, opts: DeleteDeckOptions): Promise<void> {
  const db = getDb()
  const stateCount = await db.states.where('deckId').equals(deck.id).count()
  if (stateCount > 0 && !opts.unsafe) {
    if (!opts.preBackup) throw new Error('该词库有学习进度，删除前必须先备份')
    const backup = await opts.preBackup()
    if (backup && backup.ok === false) throw new Error(`预备份失败，已拒绝删除：${backup.error ?? '未知错误'}`)
  }
}

/**
 * IDB cache + facts 级联删除（调用方已读取 deck 并完成 preBackup）。
 * - content 写源 sqlite：deck/word 行已由 tombstone 从 cache 删除，这里只清 facts/缓存残余；
 * - `defaultAlreadyHandled=true` 时默认标记已在 content_kv 写好（cache 已同步），不再写 IDB。
 */
async function deleteDeckIdbCascade(
  deck: Deck,
  now: number,
  opts: { defaultAlreadyHandled?: boolean } = {},
): Promise<void> {
  const db = getDb()
  await db.transaction(
    'rw',
    [db.decks, db.words, db.states, db.plans, db.reviewLogs, db.settings, db.meta],
    async () => {
      await db.decks.delete(deck.id)
      await db.words.where('deckId').equals(deck.id).delete()
      await db.states.where('deckId').equals(deck.id).delete()
      await db.reviewLogs.where('deckId').equals(deck.id).delete()
      await db.plans.where('deckId').equals(deck.id).delete()
      // 内置词库：清种子记录，允许重新种子
      if (deck.builtinKey) {
        const seeded = await db.meta.get('builtin.seeded')
        const value = seeded?.value as Record<string, number> | undefined
        if (value && deck.builtinKey in value) {
          const next = { ...value }
          delete next[deck.builtinKey]
          await db.meta.put({ key: 'builtin.seeded', value: next, updatedAt: now })
        }
      }
      // 当前在学词库被删：切到默认/第一个
      const selected = await db.settings.get('data.selectedDeckId')
      if (selected?.value === deck.id || !selected) {
        const remaining = await db.decks.toArray()
        const fallback = remaining.find((item) => item.isDefault)?.id ?? remaining[0]?.id ?? ''
        await db.settings.put({ key: 'data.selectedDeckId', value: fallback, updatedAt: now })
      }
      // 默认词库被删：把剩余的第一个设为默认（content sqlite 已在 content_kv 写)
      if (deck.isDefault && opts.defaultAlreadyHandled !== true) {
        const remaining = await db.decks.toArray()
        const fallback = remaining[0]
        if (fallback) await db.decks.put({ ...fallback, isDefault: true, updatedAt: now })
      }
    },
  )
}

/**
 * 删除词库前的内容快照（deck 行 + 其词行 + 兜底默认 deck 旧行），用于 facts 失败时补偿恢复。
 * 必须在 tombstone 之前调用（此时 IDB cache 仍是删除前状态）。
 */
async function deckDeleteContentSnapshot(
  deck: Deck,
  now: number,
): Promise<{ rows: ContentEntityRow[]; defaultFallbackId: string | null }> {
  const db = getDb()
  const words = await db.words.where('deckId').equals(deck.id).toArray()
  const remaining = (await db.decks.toArray()).filter((item) => item.id !== deck.id)
  const defaultFallbackId = deck.isDefault ? remaining[0]?.id ?? null : null
  const rows: ContentEntityRow[] = [
    contentRowOfDeck(deck),
    ...words.map((word) => contentRowOfWord(word, word.createdAt || now)),
    ...words.map((word) => wordOverlayContentRow(word, now)).filter((row): row is ContentEntityRow => Boolean(row)),
  ]
  if (defaultFallbackId) {
    const fallback = await db.decks.get(defaultFallbackId)
    if (fallback) rows.push(contentRowOfDeck(fallback))
  }
  return { rows, defaultFallbackId }
}

/** 0.14：sqlite 内容写源删词库——先 tombstone content_kv（失败不删 IDB），再级联删 facts/cache；facts 失败补偿恢复 content */
async function deleteDeckContentSqlite(deckId: string, opts: DeleteDeckOptions): Promise<void> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) return
  await requireDeckDeleteBackup(deck, opts)
  const now = Date.now()
  // 默认词库被删：兜底词库的新默认标记与 tombstone 同批写 content_kv
  const { rows: snapshot, defaultFallbackId } = await deckDeleteContentSnapshot(deck, now)
  await tombstoneDeckContent(deck, now, defaultFallbackId)
  try {
    await deleteDeckIdbCascade(deck, now, { defaultAlreadyHandled: true })
  } catch (error) {
    await restoreContentAfterFailedDelete(snapshot, error)
  }
  await bumpDataEpoch('deleteDeck')
}

/** A2：sqlite 模式删除词库，先删 SQLite facts（单 tx），成功后再删 IDB cache；content sqlite 时先 tombstone */
async function deleteDeckSqlite(
  deckId: string,
  opts: DeleteDeckOptions,
  contentSqlite = false,
): Promise<void> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) return
  await requireDeckDeleteBackup(deck, opts)
  const now = Date.now()
  const remaining = (await db.decks.toArray()).filter((item) => item.id !== deckId)
  const selected = await db.settings.get('data.selectedDeckId')
  const fallback = remaining.find((item) => item.isDefault)?.id ?? remaining[0]?.id ?? ''
  let snapshot: ContentEntityRow[] | null = null
  if (contentSqlite) {
    const captured = await deckDeleteContentSnapshot(deck, now)
    snapshot = captured.rows
    await tombstoneDeckContent(deck, now, captured.defaultFallbackId)
  }
  try {
    const ops: unknown[] = [
      { op: 'delete', table: 'states', where: { deck_id: deckId } },
      { op: 'delete', table: 'review_logs', where: { deck_id: deckId } },
      { op: 'delete', table: 'plans', where: { deck_id: deckId } },
    ]
    if (selected?.value === deckId || !selected) {
      ops.push({ op: 'upsert', table: 'settings', row: { key: 'data.selectedDeckId', value_json: JSON.stringify(fallback), updated_at: Date.now() } })
    }
    const tx = await sqliteTx(ops)
    if (tx.ok === false) throw new Error(tx.message ?? '删除词库 SQLite 事务失败')
    await deleteDeckIdbCascade(deck, now, { defaultAlreadyHandled: contentSqlite })
  } catch (error) {
    if (snapshot) await restoreContentAfterFailedDelete(snapshot, error)
    throw error
  }
  await bumpDataEpoch('deleteDeck')
}

async function deleteDeckInner(
  deckId: string,
  opts: DeleteDeckOptions = {},
): Promise<void> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) return
  await requireDeckDeleteBackup(deck, opts)
  const now = Date.now()
  await deleteDeckIdbCascade(deck, now)
  await bumpDataEpoch('deleteDeck')
}

/**
 * 保证「默认词库」全局唯一（导入/恢复后调用）。
 * - 优先保留 `preferredDeckId`（调用方导入前记录的本机默认词库）；
 * - 否则保留现有默认中的第一个；没有默认则把第一个词库设为默认；
 * - 返回最终默认词库 id（无词库返回 null）。
 */
export async function ensureSingleDefaultDeck(
  preferredDeckId?: string | null,
): Promise<string | null> {
  const db = getDb()
  const decks = await db.decks.toArray()
  if (decks.length === 0) return null
  const defaults = decks.filter((deck) => deck.isDefault)
  const preferred =
    (preferredDeckId ? decks.find((deck) => deck.id === preferredDeckId) : undefined) ??
    defaults[0] ??
    decks.find((deck) => deck.id === BRAND.defaultDeckId) ??
    decks.find((deck) => deck.id === DECK_SOURCES[0]?.deckId) ??
    decks[0]!
  if (defaults.length === 1 && preferred.id === defaults[0]!.id) return preferred.id
  const now = Date.now()
  const mapped = decks.map((deck) => ({
    ...deck,
    isDefault: deck.id === preferred.id,
    updatedAt: deck.id === preferred.id ? now : deck.updatedAt,
  }))
  // 0.14 B4：sqlite 内容写源下默认标记（deck 内容）必须同步 content_kv；只写实际变化行
  if ((await getContentWriteSource()) === 'sqlite') {
    const beforeJson = new Map(decks.map((deck) => [deck.id, JSON.stringify(deck)]))
    const changed = mapped.filter((deck) => beforeJson.get(deck.id) !== JSON.stringify(deck))
    if (changed.length > 0) {
      const saved = await saveCustomContentRows(changed.map((deck) => contentRowOfDeck(deck)))
      if (!saved.ok) throw contentWriteFailure('默认词库标记', saved, changed.length)
    }
    return preferred.id
  }
  await db.decks.bulkPut(mapped)
  return preferred.id
}

/**
 * 设为默认词库（全局唯一）。
 * 0.14 注：isDefault 是可变 deck 元数据；sqlite 内容写源下即使目标是内置词库，
 * 也允许把该 deck 行写入 content_kv（内置不可变的是词正文，不是默认标记）。
 */
export async function setDefaultDeck(deckId: string): Promise<Deck> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const now = Date.now()
  if ((await getContentWriteSource()) === 'sqlite') {
    const decks = await db.decks.toArray()
    const beforeJson = new Map(decks.map((item) => [item.id, JSON.stringify(item)]))
    const all = decks.map((item) => ({
      ...item,
      isDefault: item.id === deckId,
      updatedAt: item.id === deckId ? now : item.updatedAt,
    }))
    const changed = all.filter((item) => beforeJson.get(item.id) !== JSON.stringify(item))
    if (changed.length > 0) {
      const saved = await saveCustomContentRows(changed.map((item) => contentRowOfDeck(item)))
      if (!saved.ok) throw contentWriteFailure('设为默认词库', saved, changed.length)
    }
    return { ...deck, isDefault: true, updatedAt: now }
  }
  await db.transaction('rw', db.decks, db.settings, async () => {
    const all = await db.decks.toArray()
    await db.decks.bulkPut(
      all.map((item) => ({
        ...item,
        isDefault: item.id === deckId,
        updatedAt: item.id === deckId ? now : item.updatedAt,
      })),
    )
  })
  return { ...deck, isDefault: true, updatedAt: now }
}

/** 添加单个词条（同 headword 已存在 → throw） */
export async function addWord(deckId: string, input: RawWordInput): Promise<Word> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const headword = String(input.headword ?? '').trim()
  if (!headword) throw new Error('单词不能为空')
  const wordId = wordIdOf(deckId, headword)
  const existing = await db.words.get(wordId)
  if (existing) throw new Error(`词条已存在：${existing.headword}`)
  const now = Date.now()
  const order = input.order ?? (await maxOrder(deckId)) + 1
  const word = buildWord(input, deckId, { order, createdAt: now, custom: true })
  if ((await getContentWriteSource()) === 'sqlite') {
    const countAfter = (await db.words.where('deckId').equals(deckId).count()) + 1
    await saveCustomWordRows(deck, [word], now, countAfter, '添加词条')
    return word
  }
  await db.transaction('rw', db.decks, db.words, async () => {
    await db.words.put(word)
    await refreshDeckCount(deckId, now)
  })
  return word
}

/** 添加/更新词条（按 headword 兼容 upsert；已存在则合并释义） */
export async function upsertWord(deckId: string, input: RawWordInput): Promise<Word> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const headword = String(input.headword ?? '').trim()
  if (!headword) throw new Error('单词不能为空')
  const wordId = wordIdOf(deckId, headword)
  const existing = await db.words.get(wordId)
  const now = Date.now()
  const order = input.order ?? existing?.order ?? (await maxOrder(deckId)) + 1
  if (existing && isBuiltinDeck(deck) && existing.custom !== true) {
    throw new Error('E_UNSUPPORTED: 内置词库词条正文不支持 upsert（正文来自打包资源）')
  }
  const built = buildWord(input, deckId, { order, createdAt: existing?.createdAt ?? now, custom: true })
  const word = withPreservedWordOverlay(built, existing)
  if ((await getContentWriteSource()) === 'sqlite') {
    const current = await db.words.where('deckId').equals(deckId).count()
    await saveCustomWordRows(deck, [word], now, existing ? current : current + 1, '添加词条')
    return word
  }
  await db.transaction('rw', db.decks, db.words, async () => {
    await db.words.put(word)
    await refreshDeckCount(deckId, now)
  })
  return word
}

/**
 * 批量加词（导入/批量粘贴用）。
 * 同一次调用内按 headword 去重；返回实际写入的词条。
 */
export async function addWords(deckId: string, inputs: readonly RawWordInput[]): Promise<Word[]> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const now = Date.now()
  const startOrder = (await maxOrder(deckId)) + 1
  const seen = new Set<string>()
  const words: Word[] = []
  const existingWords = new Map<string, Word>()
  const candidateIds = inputs.map((input) => wordIdOf(deckId, String(input.headword ?? '').trim()))
  const existingRows = await db.words.bulkGet(candidateIds)
  existingRows.forEach((row, index) => { if (row) existingWords.set(candidateIds[index]!, row) })
  for (const input of inputs) {
    const headword = String(input.headword ?? '').trim()
    if (!headword) continue
    const normalized = normalizeHeadword(headword)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    words.push(
      withPreservedWordOverlay(
        buildWord(input, deckId, {
          order: input.order ?? startOrder + words.length,
          createdAt: now,
          custom: true,
        }),
        existingWords.get(wordIdOf(deckId, headword)),
      ),
    )
  }
  if (words.length === 0) return []
  if ((await getContentWriteSource()) === 'sqlite') {
    const countAfter = (await db.words.where('deckId').equals(deckId).count()) + words.length
    await saveCustomWordRows(deck, words, now, countAfter, '批量加词')
    return words
  }
  await db.transaction('rw', db.decks, db.words, async () => {
    await db.words.bulkPut(words)
    await refreshDeckCount(deckId, now)
  })
  return words
}

/**
 * 更新词条（手动词库管理）。
 * - 支持改释义/例句/音标/标签/章节；
 * - **不支持改拼写**（id 规则固定，改拼写请删了重加）；
 * - 释义重排会重算 meaning id（原不熟悉度计数会失效，提示 UI 慎用）。
 */
export async function updateWord(wordId: string, patch: Partial<RawWordInput>): Promise<Word> {
  const db = getDb()
  const existing = await db.words.get(wordId)
  if (!existing) throw new Error('词条不存在')
  if (patch.headword && normalizeHeadword(patch.headword) !== existing.headwordLower) {
    throw new Error('暂不支持修改单词拼写，请删除后重新添加')
  }
  const merged: RawWordInput = {
    headword: existing.headword,
    meanings: patch.meanings ?? existing.meanings.map((m) => ({ pos: m.pos, cn: m.cn })),
    meaning: patch.meaning,
    examples: patch.examples ?? existing.examples,
    example: patch.example,
    exampleTranslation: patch.exampleTranslation,
    phonetic: patch.phonetic ?? existing.phonetic,
    mnemonics: patch.mnemonics ?? existing.mnemonics,
    phrases: patch.phrases ?? existing.phrases,
    tags: patch.tags ?? existing.tags,
    order: existing.order,
    chapter: patch.chapter ?? existing.chapter,
    frequency: patch.frequency ?? existing.frequency,
    cefr: patch.cefr ?? existing.cefr,
    examCount: patch.examCount ?? existing.examCount,
    createdAt: existing.createdAt,
  }
  const built = buildWord(merged, existing.deckId, {
    wordId: existing.id,
    order: existing.order,
    createdAt: existing.createdAt,
    custom: existing.custom === true,
  })
  const word = withPreservedWordOverlay(built, existing)
  if (existing.maimemoVocId) word.maimemoVocId = existing.maimemoVocId
  if ((await getContentWriteSource()) === 'sqlite') {
    await assertBuiltinWordMutable(existing, '编辑')
    const rows = [contentRowOfWord(word, Date.now())]
    const saved = await saveCustomContentRows(rows)
    if (!saved.ok) throw contentWriteFailure('更新词条', saved, rows.length)
    return word
  }
  await db.words.put(word)
  return word
}

/** 删除词条（同时删学习状态与该词的 session 快照） */
export async function deleteWord(wordId: string): Promise<void> {
  const contentSqlite = (await getContentWriteSource()) === 'sqlite'
  if (getLearningWriteSource() === 'sqlite') return withDataWriteLock(() => deleteWordSqlite(wordId, contentSqlite))
  assertIdbMutationAllowed('删除词条')
  if (contentSqlite) return withDataWriteLock(() => deleteWordContentSqlite(wordId))
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) return
  const now = Date.now()
  await db.transaction('rw', [db.decks, db.words, db.states, db.plans, db.reviewLogs, db.meta], async () => {
    await db.words.delete(wordId)
    await db.states.delete(wordId)
    await db.meta.delete(`session:${wordId}`)
    await scrubPlansForRemovedWords([wordId], { deckId: word.deckId, now })
    await db.reviewLogs.where('wordId').equals(wordId).delete()
    await refreshDeckCount(word.deckId, now)
  })
}

/** 0.14：sqlite 内容写源删自定义词——先 tombstone content_kv（失败不删 IDB），再清 facts；facts 失败补偿恢复 content */
async function deleteWordContentSqlite(wordId: string): Promise<void> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) return
  await assertBuiltinWordMutable(word, '删除')
  const now = Date.now()
  const deck = await db.decks.get(word.deckId)
  const snapshot: ContentEntityRow[] = [contentRowOfWord(word, word.createdAt || now)]
  const overlayRow = wordOverlayContentRow(word, now)
  if (overlayRow) snapshot.push(overlayRow)
  if (deck) snapshot.push(contentRowOfDeck(deck))
  await tombstoneWordContent(word, now)
  try {
    await db.transaction('rw', [db.decks, db.words, db.states, db.plans, db.reviewLogs, db.meta], async () => {
      // cache 已由 tombstone 删除；这里幂等兜底（cache 写入失败时仍保持一致）
      await db.words.delete(wordId)
      await db.states.delete(wordId)
      await db.meta.delete(`session:${wordId}`)
      await scrubPlansForRemovedWords([wordId], { deckId: word.deckId, now })
      await db.reviewLogs.where('wordId').equals(wordId).delete()
      await refreshDeckCount(word.deckId, now)
    })
  } catch (error) {
    await restoreContentAfterFailedDelete(snapshot, error)
  }
}

/** A2：sqlite 模式删除词条，先删 SQLite state/log + 更新 plans（单 tx），成功后删 IDB cache */
async function deleteWordSqlite(wordId: string, contentSqlite = false): Promise<void> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) return
  const now = Date.now()
  if (!contentSqlite) {
    await deleteWordSqliteFacts(word, now)
    return
  }
  await assertBuiltinWordMutable(word, '删除')
  // 0.14：sqlite 内容写源先 tombstone；facts 失败用快照补偿恢复 content
  const deck = await db.decks.get(word.deckId)
  const snapshot: ContentEntityRow[] = [contentRowOfWord(word, word.createdAt || now)]
  const overlayRow = wordOverlayContentRow(word, now)
  if (overlayRow) snapshot.push(overlayRow)
  if (deck) snapshot.push(contentRowOfDeck(deck))
  await tombstoneWordContent(word, now)
  try {
    await deleteWordSqliteFacts(word, now)
  } catch (error) {
    await restoreContentAfterFailedDelete(snapshot, error)
  }
}

/** 词条 SQLite facts 删除（states/logs/plans + IDB cache） */
async function deleteWordSqliteFacts(word: Word, now: number): Promise<void> {
  const db = getDb()
  const wordId = word.id
  const plansResponse = await sqliteQuery({ table: 'plans', where: { deck_id: word.deckId }, limit: 1000 }, 5_000)
  const planRows = ((plansResponse.rows as Array<Record<string, unknown>> | undefined) ?? []).map(mapSqlitePlanRow)
  const ops: unknown[] = [
    { op: 'delete', table: 'states', where: { word_id: wordId } },
    { op: 'delete', table: 'review_logs', where: { word_id: wordId } },
  ]
  for (const plan of planRows) {
    if (!plan.wordIds.includes(wordId)) continue
    const wordIds = plan.wordIds.filter((id) => id !== wordId)
    const sources = { ...plan.sources }
    delete sources[wordId]
    let index = 0
    for (let i = 0; i < Math.min(plan.index, plan.wordIds.length); i += 1) {
      if (plan.wordIds[i] !== wordId) index += 1
    }
    ops.push({
      op: 'upsert',
      table: 'plans',
      row: planRow({
        ...plan,
        wordIds,
        sources,
        index,
        ratings: plan.ratings.filter((rating) => rating.wordId !== wordId),
        completedAt: wordIds.length > 0 && index >= wordIds.length ? plan.completedAt : null,
        updatedAt: now,
      }),
    })
  }
  const tx = await sqliteTx(ops)
  if (tx.ok === false) throw new Error(tx.message ?? '删除词条 SQLite 事务失败')
  await db.transaction('rw', [db.decks, db.words, db.states, db.plans, db.reviewLogs, db.meta], async () => {
    await db.words.delete(wordId)
    await db.states.delete(wordId)
    await db.meta.delete(`session:${wordId}`)
    await scrubPlansForRemovedWords([wordId], { deckId: word.deckId, now })
    await db.reviewLogs.where('wordId').equals(wordId).delete()
    await refreshDeckCount(word.deckId, now)
  })
}

/** 内部：确保某词库存在且有初始 state 的辅助（study.repo 用） */
export async function ensureWordStateRow(word: Pick<Word, 'id' | 'deckId'>, now = 0) {
  const db = getDb()
  const existing = await db.states.get(word.id)
  if (existing) return existing
  const state = buildInitialState(word, now)
  await db.states.put(state)
  return state
}
