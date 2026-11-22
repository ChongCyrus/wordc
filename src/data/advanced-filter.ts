/** 0.4.0/task-283：高级筛选属性组（组内 OR / 组间 AND|OR）+ 保存索引集 */
import { localDateKey } from '../core'
import type { Word, WordState } from '../core/types'
import { getDb } from './db'
import { rareMarkStatusOf } from './rare-meanings'

export type FilterGroupMatch = 'and' | 'or'
export type FilterField =
  | 'learned'
  | 'today'
  | 'unit'
  | 'selected'
  | 'rare'
  | 'etymology'
  | 'familiarity'
  | 'due'
  | 'headword'

export type FilterOperator = 'eq' | 'neq' | 'gte' | 'lte' | 'between' | 'in' | 'contains'

export interface FilterCondition {
  field: FilterField
  op: FilterOperator
  value?: string | number | boolean | string[]
  min?: number
  max?: number
}

export interface FilterGroup {
  id?: string
  match: FilterGroupMatch
  conditions: FilterCondition[]
}

export interface AdvancedFilter {
  /** 组间关系 */
  match: FilterGroupMatch
  groups: FilterGroup[]
}

export interface AdvancedFilterQuery {
  deckId?: string
  /** selected 条件/限定范围 */
  wordIds?: readonly string[]
  filter: AdvancedFilter
  groupBy?: 'chapter' | 'learned' | 'rare' | 'etymology'
  sort?: 'order' | 'alpha' | 'familiarity' | 'due' | 'chapter'
  direction?: 'asc' | 'desc'
  now?: number
  limit?: number
  offset?: number
}

export interface AdvancedFilterItem {
  word: Word
  state: WordState | null
  learned: boolean
  today: boolean
  rareStatus: 'unchecked' | 'unmarked' | 'marked'
  etymologyStatus: 'unchecked' | 'none' | 'ai' | 'manual'
  meaningFamiliarity: number | null
  coreSenseFamiliarity: number | null
  familiarity: number | null
}

export interface AdvancedFilterGroupSummary {
  key: string
  count: number
  wordIds: string[]
}

export interface AdvancedFilterResult {
  total: number
  words: AdvancedFilterItem[]
  groups: AdvancedFilterGroupSummary[]
  limit: number
  offset: number
}

function average(stats: Record<string, { clicks: number; encounters: number }> | undefined): number | null {
  if (!stats) return null
  const values = Object.values(stats)
    .filter((stat) => stat && stat.encounters > 0)
    .map((stat) => Math.min(1, Math.max(0, stat.clicks / stat.encounters)))
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function matchCondition(item: AdvancedFilterItem, condition: FilterCondition, ctx: {
  todayIds: Set<string>
  selectedIds: Set<string>
}): boolean {
  const actual = (() => {
    switch (condition.field) {
      case 'learned':
        return item.learned
      case 'today':
        return ctx.todayIds.has(item.word.id)
      case 'unit':
        return item.word.chapter ?? ''
      case 'selected':
        return ctx.selectedIds.has(item.word.id)
      case 'rare':
        return item.rareStatus
      case 'etymology':
        return item.etymologyStatus
      case 'familiarity':
        return item.familiarity
      case 'due':
        return item.state?.dueAt ?? null
      case 'headword':
        return item.word.headwordLower
    }
  })()
  // 0.4.4：同属性多值（单元/rare/etymology 等）——数组值按 in 语义，组内即 OR
  if (Array.isArray(condition.value)) {
    const values = condition.value
    if (condition.op === 'neq') return !values.includes(actual as never)
    if (condition.op === 'eq' || condition.op === 'in') return values.includes(actual as never)
    return false
  }
  switch (condition.op) {
    case 'eq':
      if (condition.field === 'headword') return String(actual).includes(String(condition.value ?? '').toLowerCase())
      return actual === condition.value
    case 'neq':
      return actual !== condition.value
    case 'gte':
      return actual != null && Number(actual) >= Number(condition.value ?? condition.min ?? 0)
    case 'lte':
      return actual != null && Number(actual) <= Number(condition.value ?? condition.max ?? 0)
    case 'between': {
      if (actual == null) return false
      const n = Number(actual)
      const min = condition.min ?? -Infinity
      const max = condition.max ?? Infinity
      return n >= min && n <= max
    }
    case 'in':
      return Array.isArray(condition.value) && condition.value.includes(actual as never)
    case 'contains':
      return String(actual).toLowerCase().includes(String(condition.value ?? '').toLowerCase())
    default:
      return false
  }
}

function groupMatches(item: AdvancedFilterItem, group: FilterGroup, ctx: Parameters<typeof matchCondition>[2]): boolean {
  if (group.conditions.length === 0) return true
  return group.match === 'and'
    ? group.conditions.every((condition) => matchCondition(item, condition, ctx))
    : group.conditions.some((condition) => matchCondition(item, condition, ctx))
}

/** 高级筛选：组内/组间关系、属性条件、分组、排序、分页 total */
export async function queryAdvancedFilter(input: AdvancedFilterQuery): Promise<AdvancedFilterResult> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const limit = Math.max(1, Math.min(1000, Math.floor(input.limit ?? 50)))
  const offset = Math.max(0, Math.floor(input.offset ?? 0))
  let words: Word[]
  if (input.wordIds && input.wordIds.length > 0) {
    const ids = [...new Set(input.wordIds)]
    const rows = await db.words.bulkGet(ids)
    words = ids.map((id) => rows.find((row) => row?.id === id)).filter((word): word is Word => Boolean(word))
  } else if (input.deckId) {
    words = await db.words.where('deckId').equals(input.deckId).toArray()
  } else {
    words = await db.words.toArray()
  }
  const states = await db.states.toArray()
  const stateById = new Map(states.map((state) => [state.wordId, state]))
  const plan = await db.plans.where('date').equals(localDateKey(now)).toArray()
  const todayIds = new Set(plan.flatMap((row) => row.wordIds))
  const selectedIds = new Set(input.wordIds ?? [])
  const items: AdvancedFilterItem[] = words.map((word) => {
    const state = stateById.get(word.id) ?? null
    const meaning = average(state?.meaningStats)
    const core = average(state?.coreSenseStats)
    const status = rareMarkStatusOf(word)
    return {
      word,
      state,
      learned: state != null && state.phase !== 'new',
      today: todayIds.has(word.id),
      rareStatus: status,
      etymologyStatus: word.rootEtymology
        ? word.rootEtymology.source
        : word.rootEtymologyCheckedAt != null
          ? 'unchecked'
          : 'none',
      meaningFamiliarity: meaning,
      coreSenseFamiliarity: core,
      familiarity: meaning,
    }
  })
  const groups = input.filter.groups
  const filtered = items.filter((item) => {
    if (groups.length === 0) return true
    const ctx = { todayIds, selectedIds }
    return input.filter.match === 'and'
      ? groups.every((group) => groupMatches(item, group, ctx))
      : groups.some((group) => groupMatches(item, group, ctx))
  })
  const sort = input.sort ?? 'order'
  const dir = input.direction === 'desc' ? -1 : 1
  const valueOf = (item: AdvancedFilterItem): number | string => {
    switch (sort) {
      case 'alpha':
        return item.word.headwordLower
      case 'familiarity':
        return item.familiarity ?? Infinity
      case 'due':
        return item.state?.dueAt ?? Infinity
      case 'chapter':
        return item.word.chapter ?? ''
      default:
        return item.word.order
    }
  }
  filtered.sort((a, b) => {
    const av = valueOf(a)
    const bv = valueOf(b)
    if (av === bv) return a.word.order - b.word.order
    return av < bv ? -dir : dir
  })
  const groupMap = new Map<string, string[]>()
  if (input.groupBy) {
    for (const item of filtered) {
      const key =
        input.groupBy === 'learned'
          ? item.learned
            ? '已学'
            : '未学'
          : input.groupBy === 'rare'
            ? item.rareStatus
            : input.groupBy === 'etymology'
              ? item.etymologyStatus
              : item.word.chapter ?? '未分单元'
      const list = groupMap.get(key) ?? []
      list.push(item.word.id)
      groupMap.set(key, list)
    }
  }
  return {
    total: filtered.length,
    words: filtered.slice(offset, offset + limit),
    groups: [...groupMap.entries()].map(([key, wordIds]) => ({ key, count: wordIds.length, wordIds })),
    limit,
    offset,
  }
}

// ============ 保存索引集（meta filter.savedSets） ============

export const SAVED_FILTER_SETS_KEY = 'filter.savedSets'
export const SAVED_FILTER_SETS_MAX = 50

export interface SavedFilterSet {
  id: string
  name: string
  filter: AdvancedFilter
  /** 0.4.4：载入时同时恢复排序/分组（旧索引集无此字段） */
  sort?: 'order' | 'alpha' | 'familiarity' | 'due' | 'chapter'
  direction?: 'asc' | 'desc'
  groupBy?: 'chapter' | 'learned' | 'rare' | 'etymology'
  deckId?: string
  wordIds?: string[]
  /** 0.5.2：划分批次大小（1–1000）；无则未划分 */
  batchSize?: number
  /** 0.5.2：按 wordIds 顺序切出的连续批次 */
  batches?: string[][]
  createdAt: number
  updatedAt: number
}

/** 选择前 N 个（按当前顺序） */
export function takeFirstWordIds(wordIds: readonly string[], n: number): string[] {
  const count = Math.max(0, Math.min(1000, Math.floor(n)))
  return wordIds.slice(0, count)
}

/** 按 N 个连续切批；batchSize 1–1000 */
export function chunkWordIds(wordIds: readonly string[], batchSize: number): string[][] {
  const size = Math.max(1, Math.min(1000, Math.floor(batchSize)))
  const batches: string[][] = []
  for (let i = 0; i < wordIds.length; i += size) batches.push(wordIds.slice(i, i + size))
  return batches
}

async function readSets(): Promise<SavedFilterSet[]> {
  const row = await getDb().meta.get(SAVED_FILTER_SETS_KEY)
  const value = row?.value
  return Array.isArray(value) ? (value as SavedFilterSet[]) : []
}

async function writeSets(sets: SavedFilterSet[]): Promise<void> {
  await getDb().meta.put({ key: SAVED_FILTER_SETS_KEY, value: sets, updatedAt: Date.now() })
}

export async function listSavedFilterSets(): Promise<SavedFilterSet[]> {
  return readSets()
}

export async function saveFilterSet(input: {
  id?: string
  name: string
  filter: AdvancedFilter
  sort?: SavedFilterSet['sort']
  direction?: SavedFilterSet['direction']
  groupBy?: SavedFilterSet['groupBy']
  deckId?: string
  /** 命中快照；不传则保存时自动执行 filter 取全部命中 wordIds */
  wordIds?: string[]
  /** 0.4.4：false 时不自动生成快照（仅测试/特殊用） */
  snapshot?: boolean
  /** 0.5.2：保存时按 N 切批次（1–1000） */
  batchSize?: number
}): Promise<SavedFilterSet> {
  const name = input.name.trim()
  if (!name) throw new Error('索引集名称不能为空')
  const sets = await readSets()
  const now = Date.now()
  // 0.4.4：索引集 = 筛选条件 + 当时命中 wordIds 快照（全部命中，不只是已选）
  let wordIds = input.wordIds ? [...new Set(input.wordIds)] : undefined
  if (!wordIds && input.snapshot !== false) {
    const result = await queryAdvancedFilter({
      ...(input.deckId ? { deckId: input.deckId } : {}),
      filter: input.filter,
      limit: 1000,
      offset: 0,
    })
    wordIds = result.words.map((item) => item.word.id)
  }
  const batchSize =
    input.batchSize != null ? Math.max(1, Math.min(1000, Math.floor(input.batchSize))) : undefined
  const batches = batchSize && wordIds ? chunkWordIds(wordIds, batchSize) : undefined
  const existing = input.id ? sets.find((set) => set.id === input.id) : sets.find((set) => set.name === name)
  if (existing) {
    const next: SavedFilterSet = {
      ...existing,
      name,
      filter: input.filter,
      ...(input.sort ? { sort: input.sort } : {}),
      ...(input.direction ? { direction: input.direction } : {}),
      ...(input.groupBy ? { groupBy: input.groupBy } : {}),
      ...(input.deckId ? { deckId: input.deckId } : {}),
      ...(wordIds ? { wordIds } : {}),
      ...(batchSize ? { batchSize } : {}),
      ...(batches ? { batches } : {}),
      updatedAt: now,
    }
    await writeSets(sets.map((set) => (set.id === existing.id ? next : set)))
    return next
  }
  if (sets.length >= SAVED_FILTER_SETS_MAX) throw new Error(`最多保存 ${SAVED_FILTER_SETS_MAX} 个索引集`)
  const set: SavedFilterSet = {
    id: input.id ?? `filter_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    filter: input.filter,
    ...(input.sort ? { sort: input.sort } : {}),
    ...(input.direction ? { direction: input.direction } : {}),
    ...(input.groupBy ? { groupBy: input.groupBy } : {}),
    ...(input.deckId ? { deckId: input.deckId } : {}),
    ...(wordIds ? { wordIds } : {}),
    ...(batchSize ? { batchSize } : {}),
    ...(batches ? { batches } : {}),
    createdAt: now,
    updatedAt: now,
  }
  await writeSets([...sets, set])
  return set
}

export async function renameFilterSet(id: string, name: string): Promise<void> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('索引集名称不能为空')
  const sets = await readSets()
  const target = sets.find((set) => set.id === id)
  if (!target) throw new Error(`索引集不存在：${id}`)
  if (sets.some((set) => set.id !== id && set.name === trimmed)) throw new Error('索引集名称已存在')
  await writeSets(sets.map((set) => (set.id === id ? { ...set, name: trimmed, updatedAt: Date.now() } : set)))
}

export async function deleteFilterSet(id: string): Promise<boolean> {
  const sets = await readSets()
  const next = sets.filter((set) => set.id !== id)
  if (next.length === sets.length) return false
  await writeSets(next)
  return true
}
