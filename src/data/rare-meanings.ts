/** 0.3.61：不常考含义标记 + 学习/记忆过滤。注释面仍显示全部，只有记忆/加权记忆可隐藏。 */
import { getDb } from './db'
import type { Meaning, Word } from '../core/types'

async function getWordOrThrow(wordId: string): Promise<Word> {
  const word = await getDb().words.get(wordId)
  if (!word) throw new Error(`单词不存在：${wordId}`)
  return word
}

export async function getRareMeaningIds(wordId: string): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  const valid = new Set(word.meanings.map((meaning) => meaning.id))
  return (word.rareMeaningIds ?? []).filter((id) => valid.has(id))
}

/** 设置 rare 含义 id（去重/过滤非法；空数组=清空）；返回保存值 */
export async function setRareMeaningIds(wordId: string, meaningIds: string[]): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  const valid = new Set(word.meanings.map((meaning) => meaning.id))
  const next = [...new Set(meaningIds)].filter((id) => valid.has(id))
  if (next.length > 0) word.rareMeaningIds = next
  else delete word.rareMeaningIds
  await getDb().words.put(word)
  return next
}

/** AI 输出 rareMeaningIndexes（1 起）→ 含义 id 后保存；方便批量标记调用 */
export async function setRareMeaningIndexes(wordId: string, indexes: number[]): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  const ids = indexes
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= word.meanings.length)
    .map((index) => word.meanings[index - 1]!.id)
  return setRareMeaningIds(wordId, ids)
}

/** 用户手动切换某含义的 rare 标记（dev-ui 点按用；与 AI 批量应用同一套规范化） */
export async function toggleRareMeaningId(wordId: string, meaningId: string, rare?: boolean): Promise<string[]> {
  const word = await getWordOrThrow(wordId)
  if (!word.meanings.some((meaning) => meaning.id === meaningId)) {
    throw new Error(`含义不存在：${meaningId}`)
  }
  const current = new Set(word.rareMeaningIds ?? [])
  const next = rare ?? !current.has(meaningId)
  if (next) current.add(meaningId)
  else current.delete(meaningId)
  return setRareMeaningIds(wordId, [...current])
}

export async function clearRareMeaningIds(wordId: string): Promise<void> {
  await setRareMeaningIds(wordId, [])
}

/** 纯函数：hideRareMeanings=true 时过滤 rareMeaningIds 对应 c；否则原样返回 */
export function filterStudyMeanings(word: Word, hideRareMeanings = true): Meaning[] {
  if (!hideRareMeanings || !word.rareMeaningIds || word.rareMeaningIds.length === 0) return word.meanings
  const rare = new Set(word.rareMeaningIds)
  return word.meanings.filter((meaning) => !rare.has(meaning.id))
}

/** 异步便捷版（useStudySession/记忆队列用） */
export async function getStudyMeanings(wordId: string, hideRareMeanings = true): Promise<Meaning[]> {
  const word = await getWordOrThrow(wordId)
  return filterStudyMeanings(word, hideRareMeanings)
}

// ============ 0.3.69：不常考「本义」（coreSenses）标记 ============

import { getEffectiveContent } from './packs.repo'
import type { RareCoreSense } from '../core/types'

export type { RareCoreSense } from '../core/types'

export interface RareCoreSenseView {
  coreSenseIndex: number
  label: string
  gloss?: string
  origin?: string
  marked: boolean
  match?: 'label' | 'index'
}

export interface RareCoreSenseViews {
  current: RareCoreSenseView[]
  /** 对不上当前 coreSenses 的旧标记（本义被替换/删除；保留可见可清） */
  stale: RareCoreSense[]
}

export async function listRareCoreSenses(wordId: string): Promise<RareCoreSense[]> {
  const word = await getWordOrThrow(wordId)
  return word.rareCoreSenses ?? []
}

/** 当前 coreSenses 与 marked 视图；label 优先、index 兜底；对不上→stale */
export async function listRareCoreSenseViews(wordId: string): Promise<RareCoreSenseViews> {
  const word = await getWordOrThrow(wordId)
  const effective = await getEffectiveContent(wordId)
  const coreSenses = effective?.coreSenses ?? []
  const entries = [...(word.rareCoreSenses ?? [])]
  const used = new Set<RareCoreSense>()
  const matchedByIndex = new Array<{ entry: RareCoreSense; match: 'label' | 'index' } | null>(coreSenses.length).fill(null)
  // 1) label 优先（一次性先占位，避免 index 兜底把 label 匹配项抢走）
  coreSenses.forEach((sense, senseIndex) => {
    const byLabel = entries.find((entry) => !used.has(entry) && entry.label === sense.label)
    if (byLabel) {
      used.add(byLabel)
      matchedByIndex[senseIndex] = { entry: byLabel, match: 'label' }
    }
  })
  // 2) index 兜底（仅对还没有 label 匹配的当前本义）
  coreSenses.forEach((sense, senseIndex) => {
    if (matchedByIndex[senseIndex]) return
    const byIndex = entries.find((entry) => !used.has(entry) && entry.coreSenseIndex === sense.index)
    if (byIndex) {
      used.add(byIndex)
      matchedByIndex[senseIndex] = { entry: byIndex, match: 'index' }
    }
  })
  const current: RareCoreSenseView[] = coreSenses.map((sense, senseIndex) => {
    const matched = matchedByIndex[senseIndex]
    return {
      coreSenseIndex: sense.index,
      label: sense.label,
      ...(sense.note ? { gloss: sense.note } : {}),
      ...(sense.origin ? { origin: sense.origin } : {}),
      marked: Boolean(matched),
      ...(matched ? { match: matched.match } : {}),
    }
  })
  return { current, stale: entries.filter((entry) => !used.has(entry)) }
}

/** 当前匹配上的本义序号（badge 用；stale 不含） */
export async function getRareCoreSenseIndexes(wordId: string): Promise<number[]> {
  const views = await listRareCoreSenseViews(wordId)
  return views.current.filter((view) => view.marked).map((view) => view.coreSenseIndex)
}

/** 手动设置标记（label 快照；过滤非法/去重） */
export async function setRareCoreSenses(
  wordId: string,
  entries: Array<{ coreSenseIndex: number; label: string; updatedAt?: number }>,
): Promise<RareCoreSense[]> {
  const word = await getWordOrThrow(wordId)
  const seen = new Set<number>()
  const list: RareCoreSense[] = []
  for (const entry of entries) {
    const label = String(entry.label ?? '').trim()
    if (!label || !Number.isInteger(entry.coreSenseIndex) || entry.coreSenseIndex < 1) continue
    if (seen.has(entry.coreSenseIndex)) continue
    seen.add(entry.coreSenseIndex)
    list.push({
      coreSenseIndex: entry.coreSenseIndex,
      label,
      updatedAt: typeof entry.updatedAt === 'number' && Number.isFinite(entry.updatedAt) ? entry.updatedAt : Date.now(),
    })
  }
  if (list.length > 0) word.rareCoreSenses = list
  else delete word.rareCoreSenses
  await getDb().words.put(word)
  return list
}

/** AI 输出 rareCoreSenseIndexes（1 起）→ 当前 coreSenses label 快照后落库；非法索引过滤 */
export async function setRareCoreSenseIndexes(wordId: string, indexes: number[]): Promise<RareCoreSense[]> {
  const effective = await getEffectiveContent(wordId)
  const coreSenses = effective?.coreSenses ?? []
  if (indexes.length === 0) {
    await setRareCoreSenses(wordId, [])
    return []
  }
  const entries = [...new Set(indexes)]
    .filter((index) => Number.isInteger(index) && index >= 1 && index <= coreSenses.length)
    .map((index) => ({ coreSenseIndex: index, label: coreSenses[index - 1]!.label }))
  return setRareCoreSenses(wordId, entries)
}

export async function clearRareCoreSenses(wordId: string): Promise<void> {
  await setRareCoreSenses(wordId, [])
}

// ============ 0.3.97/task-282：批量不常考候选 / checkedAt / 批次状态 ============

import { localDateKey } from '../core'
import type { WordState } from '../core/types'
import type { FamiliarityDimension } from './deck-insights'

/** 当前批量不常考规则版本；增量 unchecked = 无 checkedAt 或版本不一致 */
export const RARE_MARK_VERSION = '0.3.97'

export type RareMarkStatus = 'unchecked' | 'unmarked' | 'marked' | 'all'
export type RareMarkSource = 'selected' | 'word' | 'unit' | 'deck' | 'filtered' | 'today'

export interface RareMarkCandidatesInput {
  source: RareMarkSource
  wordIds?: readonly string[]
  deckId?: string
  chapter?: string
  query?: string
  learned?: boolean
  dimension?: FamiliarityDimension
  rareStatus?: RareMarkStatus
  limit?: number
  offset?: number
}

export interface RareMarkCandidateWord {
  word: Word
  rareStatus: Exclude<RareMarkStatus, 'all'>
  checkedAt?: number
  markVersion?: string
  learned: boolean
  meaningFamiliarity: number | null
  coreSenseFamiliarity: number | null
  /** 按 dimension 选中的不熟悉度 */
  familiarity: number | null
}

export interface RareMarkCounts {
  all: number
  unchecked: number
  unmarked: number
  marked: number
  learned: number
}

export interface RareMarkCandidatesResult {
  source: RareMarkSource
  /** 过滤 rareStatus 后的总数（分页前） */
  total: number
  words: RareMarkCandidateWord[]
  counts: RareMarkCounts
  limit: number
  offset: number
}

function hasAnyRareMark(word: Word): boolean {
  return (word.rareMeaningIds?.length ?? 0) > 0 || (word.rareCoreSenses?.length ?? 0) > 0
}

export function rareMarkStatusOf(word: Word, version = RARE_MARK_VERSION): Exclude<RareMarkStatus, 'all'> {
  const checked = word.rareMarkCheckedAt != null && (word.rareMarkVersion == null || word.rareMarkVersion === version)
  if (!checked) return 'unchecked'
  return hasAnyRareMark(word) ? 'marked' : 'unmarked'
}

function averageStats(stats: Record<string, { clicks: number; encounters: number }> | undefined): number | null {
  if (!stats) return null
  const values = Object.values(stats)
    .filter((stat) => stat && stat.encounters > 0)
    .map((stat) => Math.min(1, Math.max(0, stat.clicks / stat.encounters)))
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

async function collectRareCandidateRows(input: RareMarkCandidatesInput): Promise<Word[]> {
  const db = getDb()
  const source = input.source
  if (source === 'selected' || source === 'word') {
    const ids = [...new Set((input.wordIds ?? []).filter(Boolean))]
    if (ids.length === 0) return []
    const rows = await db.words.bulkGet(ids)
    return ids.map((id) => rows.find((row) => row?.id === id)).filter((word): word is Word => Boolean(word))
  }
  if (source === 'today') {
    const plan = await db.plans.where('date').equals(localDateKey(Date.now())).toArray()
    const planIds = plan.flatMap((row) => row.wordIds)
    if (planIds.length > 0) {
      const rows = await db.words.bulkGet([...new Set(planIds)])
      return rows.filter((word): word is Word => Boolean(word))
    }
    const logs = await db.reviewLogs.toArray()
    const ids = [...new Set(logs.map((log) => log.wordId))]
    const rows = await db.words.bulkGet(ids)
    return rows.filter((word): word is Word => Boolean(word))
  }
  const deckId = input.deckId
  if (!deckId) return []
  const all = await db.words.where('deckId').equals(deckId).toArray()
  if (source === 'unit') {
    if (!input.chapter) throw new Error('unit 来源需要 chapter')
    return all.filter((word) => word.chapter === input.chapter)
  }
  if (source === 'deck') return all
  const query = input.query?.trim().toLowerCase() ?? ''
  return all.filter((word) => {
    if (!query) return true
    return (
      word.headwordLower.includes(query) ||
      word.meanings.some((meaning) => meaning.cn.toLowerCase().includes(query))
    )
  })
}

/** 批量不常考候选：分页 + 状态 counts；source 支持选词/单词/单元/词库/搜索过滤/今日 */
export async function getRareMarkCandidates(input: RareMarkCandidatesInput): Promise<RareMarkCandidatesResult> {
  const db = getDb()
  const limit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 50)))
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  const dimension = input.dimension ?? 'meaning'
  let rows = await collectRareCandidateRows(input)
  const states = await db.states.toArray()
  const stateById = new Map(states.map((state) => [state.wordId, state]))
  const learnedOf = (wordId: string) => {
    const state = stateById.get(wordId)
    return state != null && state.phase !== 'new'
  }
  if (input.learned === true) rows = rows.filter((word) => learnedOf(word.id))
  else if (input.learned === false) rows = rows.filter((word) => !learnedOf(word.id))
  const counts: RareMarkCounts = {
    all: rows.length,
    unchecked: 0,
    unmarked: 0,
    marked: 0,
    learned: rows.filter((word) => learnedOf(word.id)).length,
  }
  const withStatus = rows.map((word) => {
    const status = rareMarkStatusOf(word)
    counts[status] += 1
    const state: WordState | undefined = stateById.get(word.id)
    const meaningFamiliarity = averageStats(state?.meaningStats)
    const coreSenseFamiliarity = averageStats(state?.coreSenseStats)
    return {
      word,
      rareStatus: status,
      ...(word.rareMarkCheckedAt != null ? { checkedAt: word.rareMarkCheckedAt } : {}),
      ...(word.rareMarkVersion ? { markVersion: word.rareMarkVersion } : {}),
      learned: learnedOf(word.id),
      meaningFamiliarity,
      coreSenseFamiliarity,
      familiarity: dimension === 'coreSense' ? coreSenseFamiliarity : meaningFamiliarity,
    } satisfies RareMarkCandidateWord
  })
  const status = input.rareStatus ?? 'unchecked'
  const filtered = status === 'all' ? withStatus : withStatus.filter((item) => item.rareStatus === status)
  return {
    source: input.source,
    total: filtered.length,
    words: filtered.slice(offset, offset + limit),
    counts,
    limit,
    offset,
  }
}

export interface RareMarkApplyItem {
  wordId: string
  /** 逐含义选择：1 起索引或含义 id；与 rareCoreSenses 可同时 */
  rareMeaningIndexes?: number[]
  rareMeaningIds?: string[]
  rareCoreSenseIndexes?: number[]
  rareCoreSenseLabels?: string[]
  error?: string
}

export interface RareMarkApplyResult {
  checked: number
  updated: number
  failed: Array<{ wordId: string; error: string }>
}

/**
 * 应用本次 AI/人工结果：对每个处理词（成功）写入 rareMarkCheckedAt/version；
 * 保留已有标记，对本次选择做并集；支持逐含义/逐本义。失败词不 stamp。
 */
export async function applyRareMarkResults(
  items: readonly RareMarkApplyItem[],
  opts: { now?: number; version?: string } = {},
): Promise<RareMarkApplyResult> {
  const db = getDb()
  const now = opts.now ?? Date.now()
  const version = opts.version ?? RARE_MARK_VERSION
  const failed: Array<{ wordId: string; error: string }> = []
  let checked = 0
  let updated = 0
  for (const item of items) {
    if (item.error) {
      failed.push({ wordId: item.wordId, error: item.error })
      continue
    }
    try {
      const word = await db.words.get(item.wordId)
      if (!word) throw new Error(`单词不存在：${item.wordId}`)
      const validMeaningIds = new Set(word.meanings.map((meaning) => meaning.id))
      const nextMeaningIds = new Set((word.rareMeaningIds ?? []).filter((id) => validMeaningIds.has(id)))
      for (const index of item.rareMeaningIndexes ?? []) {
        const meaning = word.meanings[index - 1]
        if (meaning) nextMeaningIds.add(meaning.id)
      }
      for (const id of item.rareMeaningIds ?? []) if (validMeaningIds.has(id)) nextMeaningIds.add(id)
      const nextMeanings = [...nextMeaningIds]
      const effective = await getEffectiveContent(item.wordId)
      const coreSenses = effective?.coreSenses ?? []
      const nextCore = [...(word.rareCoreSenses ?? [])]
      const pushCore = (coreSenseIndex: number, label: string) => {
        if (nextCore.some((entry) => entry.coreSenseIndex === coreSenseIndex || entry.label === label)) return
        nextCore.push({ coreSenseIndex, label, updatedAt: now })
      }
      for (const index of item.rareCoreSenseIndexes ?? []) {
        const sense = coreSenses[index - 1]
        if (sense) pushCore(sense.index, sense.label)
      }
      for (const label of item.rareCoreSenseLabels ?? []) {
        const sense = coreSenses.find((entry) => entry.label === label)
        if (sense) pushCore(sense.index, sense.label)
      }
      const next: Word = {
        ...word,
        ...(nextMeanings.length > 0 ? { rareMeaningIds: nextMeanings } : {}),
        ...(nextCore.length > 0 ? { rareCoreSenses: nextCore } : {}),
        rareMarkCheckedAt: now,
        rareMarkVersion: version,
      }
      await db.words.put(next)
      checked += 1
      if (nextMeanings.length > 0 || nextCore.length > 0) updated += 1
    } catch (error) {
      failed.push({ wordId: item.wordId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { checked, updated, failed }
}

// ============ 0.3.97：批次状态持久化（关闭再开可继续/失败可重取） ============

export const RARE_BATCH_META_KEY = 'rareBatch.lastJob'
export interface RareMarkBatchJob {
  id: string
  source?: RareMarkSource
  filter?: Omit<RareMarkCandidatesInput, 'source'> & { source?: RareMarkSource }
  cursor: number
  failed: Array<{ wordId: string; error: string }>
  results: Array<{ wordId: string; checkedAt: number; markedCount: number }>
  createdAt: number
  updatedAt: number
  done?: boolean
}

export async function saveRareMarkBatchJob(job: RareMarkBatchJob): Promise<void> {
  await getDb().meta.put({ key: RARE_BATCH_META_KEY, value: { ...job, updatedAt: Date.now() }, updatedAt: Date.now() })
}

export async function getRareMarkBatchJob(): Promise<RareMarkBatchJob | null> {
  const row = await getDb().meta.get(RARE_BATCH_META_KEY)
  return (row?.value as RareMarkBatchJob | undefined) ?? null
}

export async function clearRareMarkBatchJob(): Promise<void> {
  await getDb().meta.delete(RARE_BATCH_META_KEY)
}
