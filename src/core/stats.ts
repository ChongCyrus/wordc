/**
 * 统计纯函数（SPEC §3.10）—— 给统计页 / 首页 / 遗忘曲线用。
 *
 * 输入必须是**纯数据数组**（`ReviewLog[]` / `WordState[]`），**不许查 DB**；
 * 数据层负责把 rows 查出来传进来（§9.2 末尾约定）。
 */

import { familiarity } from './familiarity'
import { isDue, retrievabilityNow } from './schedule'
import { addDays, localDateKey, startOfLocalDay } from './time'
import type { Rating, ReviewLog, WordState } from './types'

export interface DailyStatPoint {
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 当日已学（去重单词数，只计当天首次反馈） */
  reviewed: number
  /** 当日新学（该词 firstSeenAt 落在当天） */
  learned: number
}

export interface StatsOverview {
  /** 今日已学（只计 longTermUpdate 的首次反馈，去重） */
  todayReviewed: number
  /** 今日新学 */
  todayNewLearned: number
  /** 累计已学（phase !== 'new' 的单词数） */
  totalLearned: number
  /** 连续打卡天数 */
  streakDays: number
  /** 累计评分次数（全部日志，含同日回炉） */
  totalReviews: number
  /** 今日评分分布（只计 longTermUpdate） */
  ratingCounts: Record<Rating, number>
  /** 今日到期（含已过期） */
  dueToday: number
  /** 明天到期 */
  dueTomorrow: number
  /** 未来 7 天到期（含今天） */
  dueNext7Days: number
}

export interface FeedbackDistribution {
  familiar: number
  vague: number
  forgot: number
  total: number
}

export interface ForgettingCurveBucket {
  /** 展示标签，如 '0–1天' */
  label: string
  minDays: number
  /** null = 无上界（>120 天） */
  maxDays: number | null
  total: number
  /** 认识（回忆成功）次数 */
  recalled: number
  /** 回忆率 0–1；无样本为 null */
  retention: number | null
}

export interface UnfamiliarTopItem {
  wordId: string
  meaningId: string
  clicks: number
  encounters: number
  familiarity: number
}

export interface ReviewPressurePoint {
  /** 本地日期 YYYY-MM-DD */
  date: string
  dueCount: number
}

/** 日志所属本地日期 key */
function logDate(log: ReviewLog): string {
  return localDateKey(log.reviewedAt)
}

/** 今日日志（只计 longTermUpdate=true，即当天第一次反馈） */
function todayLongTermLogs(logs: readonly ReviewLog[], now: number): ReviewLog[] {
  const today = localDateKey(now)
  return logs.filter((l) => l.longTermUpdate && logDate(l) === today)
}

/**
 * 连续打卡天数：从今天（或昨天，允许今天还没学）往回数连续有日志的日期。
 * 2026-11-10：今天有 → 1；今天没但昨天有 → 从昨天数；都没 → 0。
 */
export function computeStudyStreak(logs: readonly ReviewLog[], now: number): number {
  if (logs.length === 0) return 0
  const dates = new Set(logs.map(logDate))
  const todayStart = startOfLocalDay(now)
  let cursor = todayStart
  if (!dates.has(localDateKey(todayStart))) {
    // 今天还没学：允许从昨天开始算（打卡不因“今天还没学”归零）
    cursor = addDays(todayStart, -1)
    if (!dates.has(localDateKey(cursor))) return 0
  }
  let streak = 0
  while (dates.has(localDateKey(cursor))) {
    streak += 1
    cursor = addDays(cursor, -1)
  }
  return streak
}

/**
 * 近 `days` 天每日学习量（升序，含今天；无记录的天补 0）。
 * - reviewed = 当日 longTermUpdate 日志去重 wordId 数
 * - learned  = 该词 firstSeenAt 落在当天的数量（需要传 states；不传时退化为「当天首次出现的词」）
 */
export function computeDailyStats(
  logs: readonly ReviewLog[],
  now: number,
  days: number,
  states?: readonly WordState[],
): DailyStatPoint[] {
  const n = Math.max(1, Math.floor(days))
  const todayStart = startOfLocalDay(now)
  const points: DailyStatPoint[] = []
  const byDate = new Map<string, Set<string>>()
  for (const log of logs) {
    if (!log.longTermUpdate) continue
    const key = logDate(log)
    let set = byDate.get(key)
    if (!set) {
      set = new Set()
      byDate.set(key, set)
    }
    set.add(log.wordId)
  }
  const learnedByDate = new Map<string, number>()
  if (states) {
    for (const s of states) {
      if (s.firstSeenAt == null) continue
      const key = localDateKey(s.firstSeenAt)
      learnedByDate.set(key, (learnedByDate.get(key) ?? 0) + 1)
    }
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    const dayStart = addDays(todayStart, -i)
    const key = localDateKey(dayStart)
    const reviewed = byDate.get(key)?.size ?? 0
    const learned = learnedByDate.get(key) ?? 0
    points.push({ date: key, reviewed, learned })
  }
  return points
}

/**
 * 反馈分布。默认只统计今天、只计 longTermUpdate（SPEC §3.10「今日反馈分布」）；
 * `all=true` 时统计全部日志（用于“累计 rating 分布”）。
 */
export function computeFeedbackDistribution(
  logs: readonly ReviewLog[],
  now: number,
  all = false,
): FeedbackDistribution {
  const rows = all ? logs.filter((l) => l.longTermUpdate) : todayLongTermLogs(logs, now)
  const dist: FeedbackDistribution = { familiar: 0, vague: 0, forgot: 0, total: 0 }
  for (const log of rows) {
    if (log.rating === 'familiar') dist.familiar += 1
    else if (log.rating === 'vague') dist.vague += 1
    else if (log.rating === 'forgot') dist.forgot += 1
    dist.total += 1
  }
  return dist
}

/** 遗忘曲线分桶（SPEC §3.10：`[0,1,2,3,4,5,6,7,8-14,15-30,31-60,61-120,>120]`） */
const CURVE_BUCKETS: Array<{ min: number; max: number | null; label: string }> = [
  { min: 0, max: 1, label: '0–1天' },
  { min: 1, max: 2, label: '1–2天' },
  { min: 2, max: 3, label: '2–3天' },
  { min: 3, max: 4, label: '3–4天' },
  { min: 4, max: 5, label: '4–5天' },
  { min: 5, max: 6, label: '5–6天' },
  { min: 6, max: 7, label: '6–7天' },
  { min: 7, max: 8, label: '7–8天' },
  { min: 8, max: 15, label: '8–14天' },
  { min: 15, max: 31, label: '15–30天' },
  { min: 31, max: 61, label: '31–60天' },
  { min: 61, max: 121, label: '61–120天' },
  { min: 121, max: null, label: '>120天' },
]

/**
 * 遗忘曲线：按真实间隔分桶统计回忆率。
 * 只计 longTermUpdate 日志；模糊/不认识都算回忆失败（官方训练 r=0 口径）。
 */
export function computeForgettingCurve(logs: readonly ReviewLog[]): ForgettingCurveBucket[] {
  const buckets: ForgettingCurveBucket[] = CURVE_BUCKETS.map((b) => ({
    label: b.label,
    minDays: b.min,
    maxDays: b.max,
    total: 0,
    recalled: 0,
    retention: null,
  }))
  for (const log of logs) {
    if (!log.longTermUpdate) continue
    const elapsed = Math.max(0, log.elapsedDays)
    const idx = CURVE_BUCKETS.findIndex(
      (b) => elapsed >= b.min && (b.max == null || elapsed < b.max),
    )
    if (idx < 0) continue
    const bucket = buckets[idx]!
    bucket.total += 1
    if (log.rating === 'familiar') bucket.recalled += 1
  }
  for (const b of buckets) {
    b.retention = b.total > 0 ? b.recalled / b.total : null
  }
  return buckets
}

/** 不熟悉度 Top N：f 降序；encounters=0 的含义不参与（展示 `—`） */
export function computeUnfamiliarTop(
  states: readonly WordState[],
  limit = 10,
): UnfamiliarTopItem[] {
  const items: UnfamiliarTopItem[] = []
  for (const state of states) {
    const stats = state.meaningStats ?? {}
    for (const meaningId of Object.keys(stats)) {
      const stat = stats[meaningId]!
      const f = familiarity(stat.clicks, stat.encounters)
      if (f == null) continue
      items.push({
        wordId: state.wordId,
        meaningId,
        clicks: Math.max(0, stat.clicks),
        encounters: Math.max(0, stat.encounters),
        familiarity: f,
      })
    }
  }
  items.sort((a, b) => {
    if (b.familiarity !== a.familiarity) return b.familiarity - a.familiarity
    if (b.clicks !== a.clicks) return b.clicks - a.clicks
    return a.meaningId < b.meaningId ? -1 : a.meaningId > b.meaningId ? 1 : 0
  })
  return items.slice(0, Math.max(0, Math.floor(limit)))
}

/**
 * 未来复习压力：按本地日期统计到期数量（含今天，逾期并入今天）。
 * @param days 统计天数（默认 7，含今天）
 */
export function computeReviewPressure(
  states: readonly WordState[],
  now: number,
  days = 7,
): ReviewPressurePoint[] {
  const n = Math.max(1, Math.floor(days))
  const todayStart = startOfLocalDay(now)
  const points: ReviewPressurePoint[] = []
  const index = new Map<string, number>()
  for (let i = 0; i < n; i += 1) {
    const key = localDateKey(addDays(todayStart, i))
    index.set(key, i)
    points.push({ date: key, dueCount: 0 })
  }
  for (const state of states) {
    if (state.phase === 'new' || state.phase === 'mastered' || state.phase === 'suspended') continue
    if (state.dueAt == null) continue
    const dueDay = localDateKey(state.dueAt)
    const idx = index.get(dueDay)
    if (idx != null) {
      points[idx]!.dueCount += 1
    } else if (state.dueAt <= now) {
      // 逾期（今天之前的到期日）并入今天
      points[0]!.dueCount += 1
    }
  }
  return points
}

/** 首页概览（组合上面几个纯函数；UI 也可自行拆用） */
export function computeStatsOverview(
  states: readonly WordState[],
  logs: readonly ReviewLog[],
  now: number,
): StatsOverview {
  const todayLogs = todayLongTermLogs(logs, now)
  const todayReviewed = new Set(todayLogs.map((l) => l.wordId)).size
  const todayNewLearned = states.filter(
    (s) => s.firstSeenAt != null && localDateKey(s.firstSeenAt) === localDateKey(now),
  ).length
  const ratingCounts: Record<Rating, number> = { familiar: 0, vague: 0, forgot: 0 }
  for (const log of todayLogs) ratingCounts[log.rating] += 1
  const pressure = computeReviewPressure(states, now, 7)
  const dueToday = states.filter((s) => isDue(s, now)).length
  const dueTomorrow = pressure[1]?.dueCount ?? 0
  const dueNext7Days = pressure.reduce((sum, p) => sum + p.dueCount, 0)
  return {
    todayReviewed,
    todayNewLearned,
    totalLearned: states.filter((s) => s.phase !== 'new').length,
    streakDays: computeStudyStreak(logs, now),
    totalReviews: logs.length,
    ratingCounts,
    dueToday,
    dueTomorrow,
    dueNext7Days,
  }
}

/** 当前检索概率（0–1）——统计页“熟知度分布”用，等价 retrievabilityNow */
export function currentRetrievability(state: WordState, now: number): number {
  return retrievabilityNow(state, now)
}
