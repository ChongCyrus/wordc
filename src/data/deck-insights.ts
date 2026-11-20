/** 0.3.87/task-259：词库单元聚合、进度定位、不熟悉度排行（只读） */
import { familiarity } from '../core'
import type { Word, WordState } from '../core'
import { getDb } from './db'

export interface DeckChapterSummary {
  chapter: string
  total: number
  learned: number
  newCount: number
  dueCount: number
  /** 已学词的含义级 familiarity 均值（无 encounters 时为 null） */
  avgFamiliarity: number | null
}

export interface WordWithFamiliarity {
  word: Word
  state: WordState | null
  /** 含义级 familiarity 均值（无有效 encounters 为 null） */
  familiarity: number | null
}

export interface DeckChapterWords {
  words: WordWithFamiliarity[]
  total: number
  page: number
  pageSize: number
}

export interface DeckProgressLocation {
  lastLearnedChapter: string | null
  learnedInChapter: number
  chapterTotal: number
  overallLearned: number
  total: number
}

export interface WordFamiliarityRankingItem extends WordWithFamiliarity {
  /** 含义级 familiarity 最大值（无有效 encounters 为 null） */
  maxFamiliarity: number | null
}

export interface WordFamiliarityRanking {
  items: WordFamiliarityRankingItem[]
  total: number
  page: number
  pageSize: number
}

const DEFAULT_CHAPTER = '未分单元'

function chapterOf(word: Word): string {
  return (word.chapter ?? '').trim() || DEFAULT_CHAPTER
}

function wordFamiliarity(state: WordState | undefined): { avg: number | null; max: number | null } {
  if (!state) return { avg: null, max: null }
  const values = (Object.values(state.meaningStats ?? {}) as Array<{ clicks: number; encounters: number }>)
    .filter((stat) => stat && stat.encounters > 0)
    .map((stat) => familiarity(stat.clicks, stat.encounters))
    .filter((value): value is number => value != null)
  if (values.length === 0) return { avg: null, max: null }
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    max: Math.max(...values),
  }
}

async function deckWords(deckId: string): Promise<Word[]> {
  return getDb().words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .toArray()
}

async function deckStates(deckId: string): Promise<Map<string, WordState>> {
  const rows = await getDb().states.where('deckId').equals(deckId).toArray()
  return new Map(rows.map((state) => [state.wordId, state]))
}

/** 单元聚合：按词库 order 首次出现顺序（Unit1..基础词..超纲词） */
export async function getDeckChapters(deckId: string, now = Date.now()): Promise<DeckChapterSummary[]> {
  const words = await deckWords(deckId)
  const states = await deckStates(deckId)
  const map = new Map<string, { total: number; learned: number; dueCount: number; fams: number[] }>()
  for (const word of words) {
    const chapter = chapterOf(word)
    const bucket = map.get(chapter) ?? { total: 0, learned: 0, dueCount: 0, fams: [] }
    bucket.total += 1
    const state = states.get(word.id)
    if (state && state.phase !== 'new') {
      bucket.learned += 1
      if (state.dueAt != null && state.dueAt <= now) bucket.dueCount += 1
      const fam = wordFamiliarity(state)
      if (fam.avg != null) bucket.fams.push(fam.avg)
    }
    map.set(chapter, bucket)
  }
  return [...map.entries()].map(([chapter, bucket]) => ({
    chapter,
    total: bucket.total,
    learned: bucket.learned,
    newCount: bucket.total - bucket.learned,
    dueCount: bucket.dueCount,
    avgFamiliarity:
      bucket.fams.length > 0 ? bucket.fams.reduce((sum, value) => sum + value, 0) / bucket.fams.length : null,
  }))
}

/** 单元内词条分页（含 state/familiarity） */
export async function getWordsByChapter(input: {
  deckId: string
  chapter: string
  filter?: 'all' | 'learned' | 'new'
  query?: string
  page?: number
  pageSize?: number
  now?: number
}): Promise<DeckChapterWords> {
  const filter = input.filter ?? 'all'
  const q = String(input.query ?? '').trim().toLowerCase()
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize ?? 50)))
  const [words, states] = await Promise.all([deckWords(input.deckId), deckStates(input.deckId)])
  let rows = words.filter((word) => chapterOf(word) === input.chapter)
  if (filter === 'learned') rows = rows.filter((word) => states.get(word.id)?.phase !== undefined && states.get(word.id)!.phase !== 'new')
  else if (filter === 'new') rows = rows.filter((word) => !states.has(word.id) || states.get(word.id)!.phase === 'new')
  if (q) {
    rows = rows.filter(
      (word) =>
        word.headword.toLowerCase().includes(q) ||
        word.headwordLower.includes(q) ||
        word.meanings.some((meaning) => meaning.cn.toLowerCase().includes(q)),
    )
  }
  const total = rows.length
  const pageRows = rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize)
  return {
    words: pageRows.map((word) => {
      const state = states.get(word.id) ?? null
      return { word, state, familiarity: wordFamiliarity(state ?? undefined).avg }
    }),
    total,
    page,
    pageSize,
  }
}

/** 词库当前位置：按最近学习词所在的章节；无学习记录返回 null 章节 */
export async function getDeckProgressLocation(deckId: string): Promise<DeckProgressLocation> {
  const [words, states] = await Promise.all([deckWords(deckId), deckStates(deckId)])
  const byId = new Map(words.map((word) => [word.id, word]))
  const learned = [...states.values()].filter(
    (state) => state.phase !== 'new' && byId.has(state.wordId),
  )
  const total = words.length
  if (learned.length === 0) {
    return { lastLearnedChapter: null, learnedInChapter: 0, chapterTotal: 0, overallLearned: 0, total }
  }
  learned.sort((a, b) => {
    const atA = a.lastReviewedAt ?? a.firstSeenAt ?? 0
    const atB = b.lastReviewedAt ?? b.firstSeenAt ?? 0
    return atB - atA
  })
  const latestWord = byId.get(learned[0]!.wordId)!
  const chapter = chapterOf(latestWord)
  const chapterWords = words.filter((word) => chapterOf(word) === chapter)
  const chapterLearned = chapterWords.filter((word) => {
    const state = states.get(word.id)
    return state != null && state.phase !== 'new'
  }).length
  return {
    lastLearnedChapter: chapter,
    learnedInChapter: chapterLearned,
    chapterTotal: chapterWords.length,
    overallLearned: learned.length,
    total,
  }
}

/** 完整不熟悉度排行：familiarity 均值排序；unfamiliar 升序 / familiar 降序；tie-break order→id */
export async function getWordFamiliarityRanking(input: {
  deckId: string
  order?: 'unfamiliar' | 'familiar'
  query?: string
  page?: number
  pageSize?: number
  onlyLearned?: boolean
  now?: number
}): Promise<WordFamiliarityRanking> {
  const order = input.order ?? 'unfamiliar'
  const onlyLearned = input.onlyLearned !== false
  const q = String(input.query ?? '').trim().toLowerCase()
  const page = Math.max(1, Math.floor(input.page ?? 1))
  const pageSize = Math.max(1, Math.min(200, Math.floor(input.pageSize ?? 50)))
  const [words, states] = await Promise.all([deckWords(input.deckId), deckStates(input.deckId)])
  let rows = words.map((word) => {
    const state = states.get(word.id) ?? null
    const fam = wordFamiliarity(state ?? undefined)
    return { word, state, familiarity: fam.avg, maxFamiliarity: fam.max }
  })
  if (onlyLearned) rows = rows.filter((row) => row.state != null && row.state.phase !== 'new')
  if (q) {
    rows = rows.filter(
      (row) =>
        row.word.headword.toLowerCase().includes(q) ||
        row.word.headwordLower.includes(q) ||
        row.word.meanings.some((meaning) => meaning.cn.toLowerCase().includes(q)),
    )
  }
  const rank = (value: number | null) => (value == null ? (order === 'unfamiliar' ? -Infinity : Infinity) : value)
  rows.sort((a, b) => {
    const av = rank(a.familiarity)
    const bv = rank(b.familiarity)
    if (av !== bv) return order === 'unfamiliar' ? av - bv : bv - av
    if (a.word.order !== b.word.order) return a.word.order - b.word.order
    return a.word.id.localeCompare(b.word.id)
  })
  const total = rows.length
  return {
    items: rows.slice((page - 1) * pageSize, (page - 1) * pageSize + pageSize),
    total,
    page,
    pageSize,
  }
}
