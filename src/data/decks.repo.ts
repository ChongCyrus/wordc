/**
 * 词库管理（SPEC §2.3 / §8.4 / AC6）。
 *
 * 提供 UI 直接调用的 CRUD + 分页/搜索。**UI 不直接写 db**（§2.2-5）。
 * 所有写操作在 `db.transaction` 内完成，并同步维护 `deck.wordCount / updatedAt`。
 */

import { isDue, newDeckId, normalizeHeadword, wordIdOf } from '../core'
import type { Deck, DeckSource, Word } from '../core'
import { getDb } from './db'
import { BRAND } from '../app/brand'
import { DECK_SOURCES } from './builtin/deck-sources'
import { buildWord, buildInitialState } from './word-factory'
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

  // 快路径：无过滤/无搜索 → 直接走 [deckId+order] 索引分页
  if (filter === 'all' && !search && !tag) {
    const total = await db.words.where('deckId').equals(deckId).count()
    const words = await db.words
      .where('[deckId+order]')
      .between([deckId, -Infinity], [deckId, Infinity])
      .offset(offset)
      .limit(limit)
      .toArray()
    return { words, total, offset, limit }
  }

  // 慢路径：过滤/搜索需要在词库范围内扫描（≤6702 词，一次性在内存过滤）
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
  return {
    words: matches.slice(offset, offset + limit),
    total: matches.length,
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
export async function deleteDeck(deckId: string): Promise<void> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) return
  const now = Date.now()
  await db.transaction(
    'rw',
    [db.decks, db.words, db.states, db.reviewLogs, db.settings, db.meta],
    async () => {
    await db.decks.delete(deckId)
    await db.words.where('deckId').equals(deckId).delete()
    await db.states.where('deckId').equals(deckId).delete()
    await db.reviewLogs.where('deckId').equals(deckId).delete()
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
    if (selected?.value === deckId || !selected) {
      const remaining = await db.decks.toArray()
      const fallback =
        remaining.find((item) => item.isDefault)?.id ?? remaining[0]?.id ?? ''
      await db.settings.put({ key: 'data.selectedDeckId', value: fallback, updatedAt: now })
    }
    // 默认词库被删：把剩余的第一个设为默认
    if (deck.isDefault) {
      const remaining = await db.decks.toArray()
      const fallback = remaining[0]
      if (fallback) await db.decks.put({ ...fallback, isDefault: true, updatedAt: now })
    }
    },
  )
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
  await db.decks.bulkPut(
    decks.map((deck) => ({
      ...deck,
      isDefault: deck.id === preferred.id,
      updatedAt: deck.id === preferred.id ? now : deck.updatedAt,
    })),
  )
  return preferred.id
}

/** 设为默认词库（全局唯一） */
export async function setDefaultDeck(deckId: string): Promise<Deck> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const now = Date.now()
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
  const word = buildWord(input, deckId, { order, createdAt: now })
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
  const word = buildWord(input, deckId, { order, createdAt: existing?.createdAt ?? now })
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
  for (const input of inputs) {
    const headword = String(input.headword ?? '').trim()
    if (!headword) continue
    const normalized = normalizeHeadword(headword)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    words.push(
      buildWord(input, deckId, {
        order: input.order ?? startOrder + words.length,
        createdAt: now,
      }),
    )
  }
  if (words.length === 0) return []
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
  const word = buildWord(merged, existing.deckId, {
    wordId: existing.id,
    order: existing.order,
    createdAt: existing.createdAt,
  })
  if (existing.maimemoVocId) word.maimemoVocId = existing.maimemoVocId
  await db.words.put(word)
  return word
}

/** 删除词条（同时删学习状态与该词的 session 快照） */
export async function deleteWord(wordId: string): Promise<void> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) return
  const now = Date.now()
  await db.transaction('rw', db.decks, db.words, db.states, db.meta, async () => {
    await db.words.delete(wordId)
    await db.states.delete(wordId)
    await db.meta.delete(`session:${wordId}`)
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
