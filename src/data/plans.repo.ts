/**
 * 今日学习计划持久化（SPEC-v2 §6 / ARCH-v2 §3.2 / task-28）。
 *
 * 设计要点：
 * - 主键 `id = `${本地日期}:${deckId}``，一天一词库一份；跨天自然失效；
 * - `plans` 是**当日队列快照**，长期记忆仍以 `states` 为准；
 * - 评分写入与 plan 推进在**同一事务**（见 `study.repo.submitRating`），本文件提供独立推进/回炉 API；
 * - 回炉 = 同一 wordId 再次插入较后位置（允许重复），`sources` 记 requeue；
 * - 撤销/改判依赖 `reviewLogs.stateBefore` 快照（整对象恢复，不做公式逆运算）；
 * - `cleanupOldPlans({keepDays:7})` 幂等清理旧 plan。
 */

import { addDays, getCurrentWordId as coreGetCurrentWordId, localDateKey, startOfLocalDay } from '../core'
import type { Rating, Word, WordState } from '../core'
import { getDb } from './db'
import {
  applyRatingToPlan,
  insertRequeueIntoPlan,
  ratedWordCount,
  planIdOf,
  undoInPlan,
} from './plan-core'
import type { ReviewLogV2 } from './plan.types'
import type {
  DailyPlan,
  HomeStudyData,
  LastReviewSnapshot,
  PlanWordSource,
  TodayBreakdown,
  TodayBreakdownCounts,
  TodayWordItem,
} from './plan.types'
import { startOfLocalDay as startOfDay } from '../core'
import { getSettings, updateSettings } from './settings.repo'
import type { AppSettings } from './settings.repo'
import {
  newWordOrderKey,
  normalizeNewWordOrder,
  seededRandomFromPlan,
} from './plan-random'
import type { NewWordOrder } from './plan-random'
import { buildInitialState } from './word-factory'
import { submitRating } from './study.repo'

const PLAN_ACTIVE_ID = 'plan.activeId'
const PLAN_UPDATED_AT = 'plan.updatedAt'
const PLAN_NEW_WORD_ORDER = 'plan.newWordOrder'
const PLAN_REVIEW_CAP = 'plan.reviewCap'

// ============ meta 小工具 ============

async function setMeta(key: string, value: unknown, now: number): Promise<void> {
  const db = getDb()
  await db.meta.put({ key, value, updatedAt: now })
}

async function getMeta<T>(key: string): Promise<T | undefined> {
  const db = getDb()
  const row = await db.meta.get(key)
  return row?.value as T | undefined
}

async function deleteMeta(key: string): Promise<void> {
  const db = getDb()
  await db.meta.delete(key)
}

/** 把某 plan 标记为「当前 active」（首页继续学习入口） */
async function touchActivePlan(plan: DailyPlan, now: number): Promise<void> {
  const db = getDb()
  await db.transaction('rw', db.meta, async () => {
    await setMeta(PLAN_ACTIVE_ID, plan.id, now)
    await setMeta(PLAN_UPDATED_AT, now, now)
  })
}

/** 读取当前新词顺序设置（原始 slot 读，避免依赖 SettingsMap 类型；仅允许 order/random） */
async function readNewWordOrderSetting(): Promise<NewWordOrder> {
  const db = getDb()
  const row = await db.settings.get('study.newWordOrder')
  return normalizeNewWordOrder(row?.value)
}

/** 每日复习上限规范化（0=不限；只接受 0–9999 整数，其余按 0） */
export function normalizeDailyReviewCap(value: unknown): number {
  const num = Number(value)
  if (!Number.isInteger(num) || num < 0 || num > 9999) return 0
  return num
}

/** 读取设置里的每日复习上限（原始 slot 读，避免依赖 SettingsMap 类型加载顺序） */
async function readDailyReviewCapSetting(): Promise<number> {
  const db = getDb()
  const row = await db.settings.get('study.dailyReviewCap')
  return normalizeDailyReviewCap(row?.value)
}

/** 读取某 plan 建队时的复习上限快照（无快照则读当前设置） */
async function readPlanReviewCap(plan: DailyPlan): Promise<number> {
  const record = await getMeta<{ planId?: string; cap?: number }>(PLAN_REVIEW_CAP)
  if (record?.planId === plan.id) return normalizeDailyReviewCap(record.cap)
  return readDailyReviewCapSetting()
}

/** 读取某 plan 建队时使用的顺序模式（跨设置变更保持稳定） */
async function readPlanOrderMode(plan: DailyPlan): Promise<NewWordOrder> {
  const record = await getMeta<{ planId?: string; mode?: NewWordOrder }>(PLAN_NEW_WORD_ORDER)
  if (record?.planId === plan.id) return normalizeNewWordOrder(record.mode)
  return readNewWordOrderSetting()
}

/**
 * 按 plan 稳定种子挑选新词（random 模式）：
 * 候选 = 该 deck 中「未学（phase==='new' 或没有 state）且不在 excludeIds」的词，按词库 order 排列；
 * 再按 `newWordOrderKey(planId, wordId)` 升序排序取前 count 个（key 相同按 order 稳定）。
 * 因为排序键只与 planId+wordId 有关，候选集合增删不会改变其余词的相对顺序 → 天然支持前缀稳定。
 */
async function pickSeededNewWordIds(
  planId: string,
  deckId: string,
  count: number,
  excludeIds: ReadonlySet<string>,
): Promise<string[]> {
  const db = getDb()
  if (count <= 0) return []
  const learned = new Set(
    (await db.states.where('deckId').equals(deckId).toArray())
      .filter((state) => state.phase !== 'new')
      .map((state) => state.wordId),
  )
  const orderedIds = (await db.words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .primaryKeys()) as string[]
  const candidates: Array<{ wordId: string; order: number; key: number }> = []
  orderedIds.forEach((wordId, index) => {
    if (learned.has(wordId) || excludeIds.has(wordId)) return
    candidates.push({ wordId, order: index, key: newWordOrderKey(planId, wordId) })
  })
  candidates.sort((a, b) => (a.key !== b.key ? a.key - b.key : a.order - b.order))
  return candidates.slice(0, count).map((candidate) => candidate.wordId)
}

// ============ 建队 / 续学 ============

export interface TodayPlanOptions {
  deckId?: string | null
  now?: number
  /** 覆盖设置里的每日学习量（一般不用；测试用） */
  dailyGoal?: number
  extraNewWordIds?: string[]
  /** 强制按当前队列重建（危险：丢当日顺序） */
  forceRebuild?: boolean
}

/**
 * 读取/创建今日计划：
 * - 当天同 deck 的 plan 存在且未完成 → 直接返回（**续学，不重排**）；
 * - 否则按 `getTodayQueue()`（复习全量 + 新学预算）建队并落库。
 */
export async function getTodayPlan(opts: TodayPlanOptions = {}): Promise<DailyPlan> {
  const db = getDb()
  const now = opts.now ?? Date.now()
  const date = localDateKey(now)
  const settings = await getSettings()
  const deckId = opts.deckId === undefined ? settings['data.selectedDeckId'] : opts.deckId
  if (!deckId) throw new Error('未选择词库，无法创建今日计划')

  await cleanupOldPlans({ now }).catch(() => 0)
  const id = planIdOf(date, deckId)
  const existing = await db.plans.get(id)
  if (existing && !opts.forceRebuild) {
    await touchActivePlan(existing, now)
    return existing
  }

  const dailyGoal = Math.max(1, Math.floor(opts.dailyGoal ?? settings['study.dailyGoal']))
  const orderMode = await readNewWordOrderSetting()
  const reviewCap = await readDailyReviewCapSetting()
  // 延迟 import 避免循环（study.repo 不 import 本文件，仅 plan-core）
  const { getTodayQueue } = await import('./study.repo')
  // 基础队列用 order 模式拿到：复习全量 / dueCount / newBudget（新词顺序由本函数决定）
  const queue = await getTodayQueue({
    deckId,
    now,
    dailyGoal,
    extraNewWordIds: opts.extraNewWordIds,
    newOrder: 'order',
    reviewCap,
  })
  const extraIds = new Set(opts.extraNewWordIds ?? [])
  const wordIds: string[] = []
  const sources: Record<string, PlanWordSource> = {}
  for (const state of queue.reviewQueue) {
    if (sources[state.wordId]) continue
    wordIds.push(state.wordId)
    sources[state.wordId] = 'goal'
  }
  if (orderMode === 'random') {
    // task-47：稳定种子随机新词（前缀稳定，退出重进/改学习量后顺序不变）
    // task-49 修复：手动加学词不参与预算随机池（否则可能被洗进 newBudget 名额，导致总数少 1）
    const exclude = new Set(wordIds)
    for (const extraId of extraIds) exclude.add(extraId)
    const seeded = await pickSeededNewWordIds(id, deckId, queue.newBudget, exclude)
    for (const wordId of seeded) {
      wordIds.push(wordId)
      sources[wordId] = 'goal'
    }
  } else {
    for (const state of queue.newQueue) {
      if (sources[state.wordId]) continue
      wordIds.push(state.wordId)
      sources[state.wordId] = extraIds.has(state.wordId) ? 'extra' : 'goal'
    }
  }
  // 手动加学词：始终追加到末尾，不计入 newBudget（order/random 一致）
  const extrasToAppend = (opts.extraNewWordIds ?? []).filter((wordId) => !sources[wordId])
  for (const wordId of extrasToAppend) {
    wordIds.push(wordId)
    sources[wordId] = 'extra'
  }
  void extraIds
  const plan: DailyPlan = {
    id,
    date,
    deckId,
    wordIds,
    index: 0,
    sources,
    goals: {
      dailyGoal,
      dueCount: queue.dueCount,
      newBudget: queue.newBudget,
      extraCount: queue.extraCount,
    },
    ratings: [],
    createdAt: now,
    updatedAt: now,
    completedAt: wordIds.length === 0 ? now : null,
  }
  await db.transaction('rw', db.plans, db.meta, async () => {
    await db.plans.put(plan)
    await setMeta(PLAN_UPDATED_AT, now, now)
    await setMeta(PLAN_NEW_WORD_ORDER, { planId: plan.id, mode: orderMode }, now)
    await setMeta(PLAN_REVIEW_CAP, { planId: plan.id, cap: reviewCap }, now)
    if (plan.completedAt == null) await setMeta(PLAN_ACTIVE_ID, plan.id, now)
  })
  return plan
}

/** 保存整份 plan（退出学习页 / UI 修改后调用）；同步 meta */
export async function saveTodayPlan(plan: DailyPlan): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const next: DailyPlan = { ...plan, updatedAt: now }
  await db.transaction('rw', db.plans, db.meta, async () => {
    await db.plans.put(next)
    await setMeta(PLAN_UPDATED_AT, now, now)
    if (next.completedAt == null) await setMeta(PLAN_ACTIVE_ID, next.id, now)
    else if ((await getMeta<string>(PLAN_ACTIVE_ID)) === next.id) await deleteMeta(PLAN_ACTIVE_ID)
  })
}

/** 是否有可续学的今日 plan（index>0 且未完成）——首页「继续学习」判定用 */
export async function hasResumablePlan(opts: { deckId?: string | null; now?: number } = {}): Promise<boolean> {
  const db = getDb()
  const now = opts.now ?? Date.now()
  const settings = await getSettings()
  const deckId = opts.deckId === undefined ? settings['data.selectedDeckId'] : opts.deckId
  if (!deckId) return false
  const plan = await db.plans.get(planIdOf(localDateKey(now), deckId))
  if (!plan) return false
  return plan.completedAt == null && plan.index > 0 && plan.index < plan.wordIds.length
}

/** 当前应学的词 id（index 越界 → null）——v2 起委托 core（单一实现） */
export function getCurrentWordId(plan: DailyPlan): string | null {
  return coreGetCurrentWordId(plan)
}

// ============ 推进 / 回炉 / 完成 ============

/** 只移动 index（回退浏览/外部推进用；不产生评分记录） */
export async function setPlanIndex(planId: string, index: number): Promise<DailyPlan> {
  const db = getDb()
  const now = Date.now()
  return db.transaction('rw', db.plans, db.meta, async () => {
    const plan = await db.plans.get(planId)
    if (!plan) throw new Error(`plan 不存在：${planId}`)
    const next: DailyPlan = {
      ...plan,
      index: Math.max(0, Math.min(Math.floor(index), plan.wordIds.length)),
      updatedAt: now,
    }
    await db.plans.put(next)
    await setMeta(PLAN_UPDATED_AT, now, now)
    return next
  })
}

export interface AdvancePlanInput {
  planId: string
  wordId: string
  rating: Rating
  reviewedAt: number
  longTermUpdate: boolean
}

/** 评分后推进（只推进 index + 记录评分；回炉用 appendRequeue 单独插入） */
export async function advancePlanAfterRating(input: AdvancePlanInput): Promise<DailyPlan> {
  const db = getDb()
  return db.transaction('rw', db.plans, db.meta, async () => {
    const plan = await db.plans.get(input.planId)
    if (!plan) throw new Error(`plan 不存在：${input.planId}`)
    const next = applyRatingToPlan(plan, {
      wordId: input.wordId,
      rating: input.rating,
      reviewedAt: input.reviewedAt,
      longTermUpdate: input.longTermUpdate,
      insertRequeue: false,
    })
    await db.plans.put(next)
    await setMeta(PLAN_UPDATED_AT, input.reviewedAt, input.reviewedAt)
    if (next.completedAt != null) await deleteMeta(PLAN_ACTIVE_ID)
    return next
  })
}

/** 当日回炉：把 wordId 插入到 `index + gap` 位置（gap 由 core 的 requeueGapOf 给出） */
export async function appendRequeue(input: {
  planId: string
  wordId: string
  gap: number
  reviewedAt: number
}): Promise<DailyPlan> {
  const db = getDb()
  return db.transaction('rw', db.plans, db.meta, async () => {
    const plan = await db.plans.get(input.planId)
    if (!plan) throw new Error(`plan 不存在：${input.planId}`)
    const next = insertRequeueIntoPlan(plan, {
      wordId: input.wordId,
      gap: input.gap,
      reviewedAt: input.reviewedAt,
    })
    await db.plans.put(next)
    await setMeta(PLAN_UPDATED_AT, input.reviewedAt, input.reviewedAt)
    return next
  })
}

/** 标记 plan 完成（队列走完） */
export async function completePlan(planId: string, now: number = Date.now()): Promise<DailyPlan> {
  const db = getDb()
  return db.transaction('rw', db.plans, db.meta, async () => {
    const plan = await db.plans.get(planId)
    if (!plan) throw new Error(`plan 不存在：${planId}`)
    const next: DailyPlan = {
      ...plan,
      index: plan.wordIds.length,
      completedAt: plan.completedAt ?? now,
      updatedAt: now,
    }
    await db.plans.put(next)
    await setMeta(PLAN_UPDATED_AT, now, now)
    await deleteMeta(PLAN_ACTIVE_ID)
    return next
  })
}

/** 删除一份 plan（「清空数据」/重建时） */
export async function clearPlan(planId: string): Promise<void> {
  const db = getDb()
  await db.transaction('rw', db.plans, db.meta, async () => {
    await db.plans.delete(planId)
    if ((await getMeta<string>(PLAN_ACTIVE_ID)) === planId) await deleteMeta(PLAN_ACTIVE_ID)
  })
}

/** 清理 `date < beforeDateKey` 的旧 plan，返回删除条数（幂等） */
export async function clearOldPlans(beforeDateKey: string): Promise<number> {
  const db = getDb()
  return db.plans.where('date').below(beforeDateKey).delete()
}

/** 清理 keepDays 天前的 plan（默认 7 天，SPEC-v2 §6.4） */
export async function cleanupOldPlans(opts: { keepDays?: number; now?: number } = {}): Promise<number> {
  const keepDays = Math.max(0, Math.floor(opts.keepDays ?? 7))
  const now = opts.now ?? Date.now()
  const cutoff = localDateKey(addDays(startOfLocalDay(now), -keepDays))
  return clearOldPlans(cutoff)
}

// ============ 今日已学拆分（task-49，派生数据） ============

function emptyBreakdown(deckId: string, date: string): TodayBreakdown {
  const counts: TodayBreakdownCounts = { planned: 0, learned: 0, remaining: 0 }
  return {
    deckId,
    date,
    planId: null,
    review: { ...counts },
    new: { ...counts },
    totalPlanned: 0,
    totalLearned: 0,
    items: [],
  }
}

/**
 * 计算今日 plan 的「复习/新学」拆分（派生数据，不写库）。
 *
 * 分类推断（不改 `PlanWordSource`）：
 * - review：`state.firstSeenAt != null && firstSeenAt < 今日 00:00`（今天之前就学过）；
 * - new：其余（无 state / firstSeenAt 为 null / firstSeenAt 在今天）；
 * - learned：`plan.ratings` 里有该词未撤销评分，或该词在 `index` 之前已越过；
 * - 回炉词在 `wordIds` 里重复 → **只算一次**，`requeued=true`；
 * - `sources[wordId]==='extra'` → `isExtra=true`（仍按 firstSeenAt 归 review/new）。
 */
async function computeTodayBreakdown(
  now: number,
  plan: DailyPlan | null,
  deckId: string,
): Promise<TodayBreakdown> {
  const db = getDb()
  const date = localDateKey(now)
  if (!plan) return emptyBreakdown(deckId, date)
  const dayStart = startOfDay(now)

  // 去重 + 首次出现顺序 + 回炉标记
  const firstOccurrence = new Map<string, number>()
  const occurrences = new Map<string, number>()
  plan.wordIds.forEach((wordId, index) => {
    if (!firstOccurrence.has(wordId)) firstOccurrence.set(wordId, index)
    occurrences.set(wordId, (occurrences.get(wordId) ?? 0) + 1)
  })
  const wordIds = [...firstOccurrence.keys()]
  const [stateRows, wordRows] = await Promise.all([
    db.states.bulkGet(wordIds),
    db.words.bulkGet(wordIds),
  ])
  const stateOf = new Map<string, WordState | null>()
  stateRows.forEach((state, index) => stateOf.set(wordIds[index]!, state ?? null))
  const wordOf = new Map(wordRows.filter((word): word is Word => Boolean(word)).map((word) => [word.id, word]))

  // 最新未撤销评分（按 reviewedAt）
  const ratingOf = new Map<string, { rating: Rating }>()
  for (const record of [...plan.ratings].sort((a, b) => a.reviewedAt - b.reviewedAt)) {
    if (record.corrected === true) continue
    ratingOf.set(record.wordId, { rating: record.rating })
  }

  const items: TodayWordItem[] = []
  const counts = {
    review: { planned: 0, learned: 0, remaining: 0 },
    new: { planned: 0, learned: 0, remaining: 0 },
  }
  for (const wordId of wordIds) {
    const state = stateOf.get(wordId) ?? null
    const firstSeenAt = state?.firstSeenAt ?? null
    const category: TodayWordItem['category'] = firstSeenAt != null && firstSeenAt < dayStart ? 'review' : 'new'
    // 已学以「plan.ratings 中未撤销评分」为准；`index` 只表示队列位置，
    // 不作为已学依据（否则用户从中间跳看某词时，会把它前面的未评词误算已学，task-49 测试锁定）。
    const learned = ratingOf.has(wordId)
    const requeued = (occurrences.get(wordId) ?? 1) > 1 || plan.sources[wordId] === 'requeue'
    const item: TodayWordItem = {
      wordId,
      headword: wordOf.get(wordId)?.headword ?? '',
      category,
      learned,
      isExtra: plan.sources[wordId] === 'extra',
      requeued,
    }
    const ratingRecord = ratingOf.get(wordId)
    if (ratingRecord) item.rating = ratingRecord.rating
    items.push(item)
    counts[category].planned += 1
    if (learned) counts[category].learned += 1
  }
  for (const key of ['review', 'new'] as const) {
    counts[key].remaining = counts[key].planned - counts[key].learned
  }
  // 展示顺序：review 组在前，组内按 plan 首次出现顺序
  items.sort((a, b) => {
    if (a.category !== b.category) return a.category === 'review' ? -1 : 1
    return (firstOccurrence.get(a.wordId) ?? 0) - (firstOccurrence.get(b.wordId) ?? 0)
  })
  return {
    deckId,
    date,
    planId: plan.id,
    review: counts.review,
    new: counts.new,
    totalPlanned: counts.review.planned + counts.new.planned,
    totalLearned: counts.review.learned + counts.new.learned,
    items,
  }
}

/**
 * 今日已学拆分：复习/新学各 `{planned, learned, remaining}` + 词列表（去重、回炉只算一次）。
 * - 无今日 plan / 跨天 → 全 0 + 空 items；
 * - 派生数据，不写库、不进迁移包。
 */
export async function getTodayBreakdown(now: number = Date.now()): Promise<TodayBreakdown> {
  const db = getDb()
  const settings = await getSettings()
  const deckId = settings['data.selectedDeckId'] ?? ''
  const plan = deckId ? ((await db.plans.get(planIdOf(localDateKey(now), deckId))) ?? null) : null
  return computeTodayBreakdown(now, plan, deckId)
}

// ============ 首页事实数据 ============

/**
 * 首页 6 态所需事实（判定/文案由 core 或 UI 按 SPEC-v2 §6.2 做，数据层只给事实）。
 */
export async function getHomeStudyData(now: number = Date.now()): Promise<HomeStudyData> {
  const db = getDb()
  const settings = await getSettings()
  const deckId = settings['data.selectedDeckId'] ?? ''
  const dailyGoal = settings['study.dailyGoal']
  const [deck, plan, dueCount] = await Promise.all([
    deckId ? db.decks.get(deckId) : Promise.resolve(undefined),
    deckId ? db.plans.get(planIdOf(localDateKey(now), deckId)) : Promise.resolve(undefined),
    deckId ? countDueForDeck(deckId, now) : Promise.resolve(0),
  ])
  const dayStart = startOfLocalDay(now)
  const logs = deckId
    ? await db.reviewLogs
        .where('[deckId+reviewedAt]')
        .between([deckId, dayStart], [deckId, now], true, true)
        .toArray()
    : []
  const todayReviewed = new Set(
    logs
      .filter((log) => log.longTermUpdate && (log as ReviewLogV2).corrected !== true)
      .map((log) => log.wordId),
  ).size
  const remaining = plan ? Math.max(0, plan.wordIds.length - plan.index) : 0
  const breakdown = await computeTodayBreakdown(now, plan ?? null, deckId)
  const dailyReviewCap = plan ? await readPlanReviewCap(plan) : await readDailyReviewCapSetting()
  // task-54：无 plan 时按「今日预算入队数」预计算（min(due,cap)），避免首页积压显示 dueCount；
  // 有 plan 时沿用 breakdown.review.planned（今日实际入队数）。
  const plannedReview = plan
    ? breakdown.review.planned
    : dailyReviewCap > 0
      ? Math.min(dueCount, dailyReviewCap)
      : dueCount
  const reviewBacklog = Math.max(0, dueCount - plannedReview)
  // task-54：新学预算按「今日入队复习数」计算；有 plan 用建队快照（已含 cap/随机后的真实预算）
  const newBudget = plan ? Math.max(0, plan.goals.newBudget) : Math.max(0, dailyGoal - plannedReview)
  return {
    now,
    deckId,
    hasDeck: Boolean(deck),
    hasLearnableWord: Boolean(deck && deck.wordCount > 0),
    dueCount,
    newBudget,
    dailyGoal,
    plan: plan ?? null,
    remaining,
    todayReviewed,
    overdueLeft: plan?.completedAt != null ? dueCount : 0,
    breakdown,
    plannedReview,
    reviewBacklog,
    dailyReviewCap,
  }
}

async function countDueForDeck(deckId: string, now: number): Promise<number> {
  const db = getDb()
  const states = await db.states.where('deckId').equals(deckId).toArray()
  return states.filter((state) => isDueState(state, now)).length
}

function isDueState(state: WordState, now: number): boolean {
  return (
    state.phase !== 'new' &&
    state.phase !== 'mastered' &&
    state.phase !== 'suspended' &&
    state.dueAt != null &&
    state.dueAt <= now
  )
}

// ============ 每日学习量变更 → 今日计划实时重算（task-34） ============

export interface RecomputeGoalInput {
  /** 要重算的 plan（缺省用当前 active plan） */
  planId?: string
  /** 新的每日学习量（1–9999 整数；非法抛错） */
  newGoal: number
  /** 可选：调用方已查好的 states（省一次查询；缺省按 plan.deckId 查） */
  states?: WordState[]
  now?: number
}

export interface RecomputeGoalResult {
  plan: DailyPlan
  /** 追加的新学词数 */
  added: number
  /** 移除的尾部未学新词数 */
  removed: number
  /** 重算后的队列总数（wordIds.length，含回炉重复） */
  total: number
  /** 重算后的新学预算 = max(0, newGoal − 复习词数) */
  newBudget: number
  /** 本 plan 的复习词数（不增删） */
  reviewCount: number
  /** 重算后的新学词数（去重） */
  newCount: number
}

/**
 * 修改每日学习量后**立即重算今天的 plan**（task-34）。
 *
 * 语义（用户要求 / SPEC-v2 §6）：
 * - 复习词集合 = plan 创建时的 review 集合（建队顺序 = review 全量 + new 预算；`sources !== 'requeue'`
 *   的前 `goals.dueCount` 个去重词），**永远不增删**；
 * - 新预算 = `max(0, newGoal - reviewCount)`；
 * - 增大 → 按词库 order 追加未学新词到队尾（跳过已在 plan 的）；
 * - 减小 → 从队尾移除**未评分、非回炉**的新学词；已评分/回炉/当前词/复习词不动；
 * - 幂等：目标与新预算都未变化时不写库（`added=removed=0`）。
 *
 * 单事务写 `plans + meta`。
 */
export async function recomputePlanForGoal(input: RecomputeGoalInput): Promise<RecomputeGoalResult> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const goal = Number(input.newGoal)
  if (!Number.isInteger(goal) || goal < 1 || goal > 9999) {
    throw new Error(`每日学习量必须是 1–9999 的整数，收到：${String(input.newGoal)}`)
  }
  const today = localDateKey(now)
  const planId =
    input.planId ?? (await getMeta<string>(PLAN_ACTIVE_ID)) ?? ''
  return db.transaction('rw', db.plans, db.words, db.states, db.meta, async () => {
    const plan = planId ? await db.plans.get(planId) : undefined
    if (!plan) throw new Error('今日计划不存在（无法重算）')
    if (plan.date !== today) throw new Error('只能重算今天的计划（跨天会用新值重新建队）')

    const states =
      input.states ??
      (await db.states.where('deckId').equals(plan.deckId).toArray())
    const learnedIds = new Set(
      states.filter((state) => state.phase !== 'new').map((state) => state.wordId),
    )

    // —— 1) 复习词集合（建队顺序 = review 全量 + new，故去重后的前 dueCount 个即 review；不增删）——
    // 注意不能按 sources 过滤：回炉会把该词的 sources 覆盖成 'requeue'，但其首次出现仍是原 review/new 词。
    const orderedUnique = [...new Set(plan.wordIds)]
    const reviewWordIds = orderedUnique.slice(0, Math.min(plan.goals.dueCount, orderedUnique.length))
    const reviewSet = new Set(reviewWordIds)

    // —— 2) 现有新学词（去重、建队顺序）——
    const newWordIds = orderedUnique.slice(reviewWordIds.length)
    const seenNew = new Set(newWordIds)
    const targetNewBudget = Math.max(0, goal - reviewSet.size)
    const ratedIds = new Set(
      plan.ratings.filter((rating) => rating.corrected !== true).map((rating) => rating.wordId),
    )
    const inPlan = new Set(plan.wordIds)

    const wordIds = [...plan.wordIds]
    const sources: DailyPlan['sources'] = { ...plan.sources }
    let added = 0
    let removed = 0

    if (targetNewBudget > newWordIds.length) {
      // —— 3) 增大：追加未学新词（跳过已在 plan 的）——
      const need = targetNewBudget - newWordIds.length
      const orderMode = await readPlanOrderMode(plan)
      if (orderMode === 'random') {
        // task-47：同一 plan 种子的随机序列延续（前缀稳定）
        const picked = await pickSeededNewWordIds(plan.id, plan.deckId, need, inPlan)
        for (const wordId of picked) {
          wordIds.push(wordId)
          sources[wordId] = 'goal'
          inPlan.add(wordId)
          added += 1
        }
      } else {
        const candidates = await db.words
          .where('[deckId+order]')
          .between([plan.deckId, -Infinity], [plan.deckId, Infinity])
          .filter((word) => !inPlan.has(word.id) && !learnedIds.has(word.id))
          .limit(need)
          .toArray()
        for (const word of candidates) {
          wordIds.push(word.id)
          sources[word.id] = 'goal'
          inPlan.add(word.id)
          added += 1
        }
      }
    } else if (targetNewBudget < newWordIds.length) {
      // —— 4) 减小：从队尾移除未评分、非回炉的新学词（当前词/已评分/回炉/复习词不动）——
      const removeCount = newWordIds.length - targetNewBudget
      const removeWords = new Set<string>()
      for (let position = wordIds.length - 1; position >= 0 && removeWords.size < removeCount; position -= 1) {
        const wordId = wordIds[position]!
        if (position === plan.index) continue // 当前词不可删
        if (position < plan.index) break // 只从当前词之后（未处理区）删
        if (sources[wordId] === 'requeue') continue // 回炉插入不动
        if (reviewSet.has(wordId)) continue // 复习词不动
        if (ratedIds.has(wordId)) continue // 已评分不动
        if (!seenNew.has(wordId) || removeWords.has(wordId)) continue
        removeWords.add(wordId)
      }
      if (removeWords.size > 0) {
        const kept = wordIds.filter((wordId) => !removeWords.has(wordId))
        wordIds.length = 0
        wordIds.push(...kept)
        for (const wordId of removeWords) delete sources[wordId]
        removed = removeWords.size
      }
    }

    const targetTotal = wordIds.length
    const newCount = targetNewBudget
    const effectiveGoal = goal
    // 幂等：目标/预算/内容都没变 → 不写库
    const unchanged =
      added === 0 &&
      removed === 0 &&
      plan.goals.dailyGoal === effectiveGoal &&
      plan.goals.newBudget === targetNewBudget
    if (unchanged) {
      return {
        plan,
        added: 0,
        removed: 0,
        total: plan.wordIds.length,
        newBudget: plan.goals.newBudget,
        reviewCount: reviewSet.size,
        newCount,
      }
    }

    let completedAt: number | null
    if (added > 0) completedAt = null
    else if (plan.index >= wordIds.length) completedAt = plan.completedAt ?? now
    else if (removed > 0) completedAt = null
    else completedAt = plan.completedAt

    const next: DailyPlan = {
      ...plan,
      wordIds,
      sources,
      index: Math.min(plan.index, wordIds.length),
      goals: {
        ...plan.goals,
        dailyGoal: effectiveGoal,
        dueCount: reviewSet.size,
        newBudget: targetNewBudget,
      },
      completedAt,
      updatedAt: now,
    }
    await db.plans.put(next)
    await setMeta(PLAN_UPDATED_AT, now, now)
    if (next.completedAt == null) await setMeta(PLAN_ACTIVE_ID, next.id, now)
    else if ((await getMeta<string>(PLAN_ACTIVE_ID)) === next.id) await deleteMeta(PLAN_ACTIVE_ID)

    return {
      plan: next,
      added,
      removed,
      total: targetTotal,
      newBudget: targetNewBudget,
      reviewCount: reviewSet.size,
      newCount,
    }
  })
}

export interface DailyGoalResyncResult {
  settings: AppSettings
  plan: DailyPlan | null
  added: number
  removed: number
  total: number
  newBudget: number
  reviewCount: number
  newCount: number
}

/**
 * 设置页改「每日学习量」时调用：先写设置，再**立即重算今天的 plan**（若有）。
 * - 今天还没有 plan（或跨天/刚清空）：只写设置，返回 `plan: null`，次日/下次建队用新值；
 * - 有今天的 plan：单事务重算，返回 `{added, removed, total}` 供 UI toast/刷新。
 *
 * UI 推荐直接调用本函数并 `await` 后刷新（或配合 useLiveQuery 自动响应 plans 表变化）。
 */
export async function updateDailyGoalAndResync(
  newGoal: number,
  opts: { now?: number; deckId?: string | null } = {},
): Promise<DailyGoalResyncResult> {
  const db = getDb()
  const now = opts.now ?? Date.now()
  const settings = await updateSettings({ 'study.dailyGoal': newGoal })
  const deckId = opts.deckId === undefined ? settings['data.selectedDeckId'] : opts.deckId
  const empty: DailyGoalResyncResult = {
    settings,
    plan: null,
    added: 0,
    removed: 0,
    total: 0,
    newBudget: 0,
    reviewCount: 0,
    newCount: 0,
  }
  if (!deckId) return empty
  const plan = await db.plans.get(planIdOf(localDateKey(now), deckId))
  if (!plan) return empty
  const result = await recomputePlanForGoal({ planId: plan.id, newGoal, now })
  return {
    settings,
    plan: result.plan,
    added: result.added,
    removed: result.removed,
    total: result.total,
    newBudget: result.newBudget,
    reviewCount: result.reviewCount,
    newCount: result.newCount,
  }
}

// ============ 回退 / 改判（task-29） ============

async function findLastUndoableLog(
  wordId: string,
  deckId: string,
  now: number,
): Promise<ReviewLogV2 | null> {
  const db = getDb()
  const today = localDateKey(now)
  const logs = await db.reviewLogs.where('wordId').equals(wordId).toArray()
  const candidates = logs
    .map((log) => log as ReviewLogV2)
    .filter(
      (log) =>
        log.deckId === deckId &&
        log.corrected !== true &&
        log.stateBefore !== undefined &&
        localDateKey(log.reviewedAt) === today,
    )
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id ?? 0) - (b.id ?? 0))
  return candidates[candidates.length - 1]!
}

/** 最近一次可撤销的评分（含评分前状态快照）；无则 null（UI 禁用回退/改判） */
export async function getLastReviewSnapshot(
  wordId: string,
  now: number = Date.now(),
): Promise<LastReviewSnapshot | null> {
  const db = getDb()
  const today = localDateKey(now)
  const logs = await db.reviewLogs.where('wordId').equals(wordId).toArray()
  const candidates = logs
    .map((log) => log as ReviewLogV2)
    .filter(
      (log) =>
        log.corrected !== true &&
        log.stateBefore !== undefined &&
        localDateKey(log.reviewedAt) === today,
    )
  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id ?? 0) - (b.id ?? 0))
  const log = candidates[candidates.length - 1]!
  const plan = await db.plans.get(planIdOf(today, log.deckId))
  const snapshot: LastReviewSnapshot = {
    log,
    stateBefore: log.stateBefore ?? null,
  }
  if (plan) {
    snapshot.planId = plan.id
    const position = plan.wordIds.lastIndexOf(wordId)
    if (position >= 0) snapshot.planIndex = position
  }
  return snapshot
}

/** 最近一次评分记录（task-29 别名；与 getLastReviewSnapshot 同义） */
export const getLastRatingRecord = getLastReviewSnapshot

export interface UndoLastRatingResult {
  state: WordState
  plan: DailyPlan
  /** 被撤销的 reviewLog id（改判时用于 correctedBy） */
  logId?: number
}

/**
 * 撤销该词**今天、最近一次、未撤销且有 stateBefore** 的评分（事务）：
 * 1) 恢复 `states` 为评分前整对象（首评为 null → 删除 state 行）；
 * 2) 原 reviewLog 标 `corrected: true`（不删除，保留审计）；
 * 3) plan.ratings 对应项标 corrected、index 回退到该词位置、删除该次回炉插入、completedAt=null。
 * 只允许当前 plan（无 plan / 跨天 / 无可撤销记录 → null）。
 */
export async function undoLastRating(input: {
  wordId: string
  planId?: string
  now?: number
}): Promise<UndoLastRatingResult | null> {
  const db = getDb()
  const now = input.now ?? Date.now()
  const today = localDateKey(now)
  const plan = input.planId
    ? await db.plans.get(input.planId)
    : await (async () => {
        const activeId = await getMeta<string>(PLAN_ACTIVE_ID)
        return activeId ? db.plans.get(activeId) : undefined
      })()
  if (!plan || plan.date !== today) return null
  const log = await findLastUndoableLog(input.wordId, plan.deckId, now)
  if (!log) return null
  const hasRating = plan.ratings.some(
    (rating) => rating.wordId === input.wordId && rating.corrected !== true,
  )
  if (!hasRating) return null

  return db.transaction('rw', db.states, db.reviewLogs, db.plans, db.meta, db.words, async () => {
    const restoredLog: ReviewLogV2 = { ...log, corrected: true, reverted: true }
    await db.reviewLogs.put(restoredLog)
    let restoredState: WordState
    if (log.stateBefore == null) {
      await db.states.delete(input.wordId)
      const word = await db.words.get(input.wordId)
      if (!word) throw new Error(`词条不存在：${input.wordId}`)
      restoredState = buildInitialState(word, now)
    } else {
      restoredState = { ...log.stateBefore }
      await db.states.put(restoredState)
    }
    const undone = undoInPlan(plan, { wordId: input.wordId, reviewedAt: log.reviewedAt })
    const nextPlan = undone.removed ? undone.plan : { ...plan, completedAt: null, updatedAt: now }
    await db.plans.put(nextPlan)
    await setMeta(PLAN_ACTIVE_ID, nextPlan.id, now)
    await setMeta(PLAN_UPDATED_AT, now, now)
    const result: UndoLastRatingResult = { state: restoredState, plan: nextPlan }
    if (log.id != null) result.logId = log.id
    return result
  })
}

/**
 * 改判：先撤销该词最近一次评分，再按新评分重新走 `submitRating`。
 * 新 reviewLog 带 `correctedBy = 旧日志 id`；plan 在同一事务链内保持一致。
 */
export async function reRateInPlan(input: {
  wordId: string
  rating: Rating
  now?: number
  planId?: string
}): Promise<{ state: WordState; plan: DailyPlan } | null> {
  const now = input.now ?? Date.now()
  const undone = await undoLastRating({ wordId: input.wordId, planId: input.planId, now })
  if (!undone) return null
  const result = await submitRating(input.wordId, input.rating, now, {
    planId: undone.plan.id,
    correctedFromLogId: undone.logId,
  })
  const plan = (await getDb().plans.get(undone.plan.id)) ?? undone.plan
  return { state: result.state, plan }
}

/**
 * 在当前 active plan 里评分（事务内三写：states + reviewLogs + plans）。
 * 适合 UI 不知道 planId 时直接用；等价 `submitRating(wordId, rating, now, { planId })`。
 */
export async function rateInPlan(input: {
  wordId: string
  rating: Rating
  now?: number
  planId?: string
}): Promise<{ state: WordState; plan: DailyPlan | null; intervalDays: number }> {
  const db = getDb()
  const now = input.now ?? Date.now()
  let planId = input.planId
  if (!planId) {
    planId = await getMeta<string>(PLAN_ACTIVE_ID)
  }
  const result = await submitRating(input.wordId, input.rating, now, { planId })
  const plan = planId ? ((await db.plans.get(planId)) ?? null) : null
  return { state: result.state, plan, intervalDays: result.intervalDays }
}

/** 供调试/统计：plan 内已评分去重词数（不含撤销） */
export { ratedWordCount }

/** 供 study.repo 旧队列路径：按日期+词库派生稳定 PRNG（同一天多次调用顺序一致） */
export function dailyOrderRandom(deckId: string | null, now: number): () => number {
  return seededRandomFromPlan(`${localDateKey(now)}:${deckId ?? 'all'}`)
}
