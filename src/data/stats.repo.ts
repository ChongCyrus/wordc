/**
 * 统计查询（SPEC §3.10 / §9.3）：数据层负责查 rows，计算交给 core 的纯函数。
 *
 * 日志量：单机用户通常 < 2 万条（迁移包上限也是 2 万），一次性读入内存计算可接受。
 * 若以后日志量变大，可改成按时间范围分页聚合（接口不变）。
 */

import {
  computeDailyStats,
  computeFeedbackDistribution,
  computeForgettingCurve,
  computeReviewPressure,
  computeStatsOverview,
  computeStudyStreak,
  computeUnfamiliarTop,
  dayDiff,
  localDateKey,
} from '../core'
import type {
  DailyStatPoint,
  FeedbackDistribution,
  ForgettingCurveBucket,
  ReviewLog,
  ReviewPressurePoint,
  StatsOverview,
  UnfamiliarTopItem,
  Word,
  WordState,
} from '../core'
import { getDb } from './db'
import { getSettings } from './settings.repo'

/** 首页/统计页概览（在 core 的 StatsOverview 上补 UI 需要的两个字段） */
export interface AppStatsOverview extends StatsOverview {
  /** 每日学习量目标（study.dailyGoal） */
  dailyGoal: number
  /** 全部词库词条总数（能力展示用） */
  totalWords: number
}

async function loadLogs(): Promise<ReviewLog[]> {
  const db = getDb()
  const rows = await db.reviewLogs.orderBy('reviewedAt').toArray()
  // v2（SPEC-v2 §3.3 / §7.2）：被改判撤销的日志不计入统计/曲线
  return rows.filter((log) => {
    const flags = log as ReviewLog & { corrected?: boolean; reverted?: boolean }
    return flags.corrected !== true && flags.reverted !== true
  })
}

/** 概览：今日已学/新学/累计/连续打卡/今日反馈分布/到期压力 */
export async function getStatsOverview(now: number = Date.now()): Promise<AppStatsOverview> {
  const db = getDb()
  const [states, logs, settings, totalWords] = await Promise.all([
    db.states.toArray(),
    loadLogs(),
    getSettings(),
    db.words.count(),
  ])
  const overview = computeStatsOverview(states, logs, now)
  return {
    ...overview,
    dailyGoal: settings['study.dailyGoal'],
    totalWords,
  }
}

/** 连续打卡天数 */
export async function getStudyStreak(now: number = Date.now()): Promise<number> {
  const logs = await loadLogs()
  return computeStudyStreak(logs, now)
}

/** 最近 N 天每日学习量（升序，含今天；无记录天补 0） */
export async function getDailyStats(days = 14, now: number = Date.now()): Promise<DailyStatPoint[]> {
  const db = getDb()
  const [logs, states] = await Promise.all([loadLogs(), db.states.toArray()])
  return computeDailyStats(logs, now, days, states)
}

/** 指定日期区间的每日学习量（`from`/`to` 为 epoch ms，按本地日期取整） */
export async function getDailyStatsRange(
  from: number,
  to: number,
  now: number = Date.now(),
): Promise<DailyStatPoint[]> {
  const db = getDb()
  const [logs, states] = await Promise.all([loadLogs(), db.states.toArray()])
  const end = Number.isFinite(to) ? to : now
  const start = Number.isFinite(from) ? from : end
  const days = Math.max(1, dayDiff(end, start) + 1)
  return computeDailyStats(logs, end, days, states)
}

/** 今日反馈分布（all=true 时为累计分布） */
export async function getFeedbackDistribution(
  opts: { all?: boolean; now?: number } = {},
): Promise<FeedbackDistribution> {
  const logs = await loadLogs()
  return computeFeedbackDistribution(logs, opts.now ?? Date.now(), opts.all ?? false)
}

/** 遗忘曲线（按真实复习间隔分桶的回忆率） */
export async function getForgettingCurve(): Promise<ForgettingCurveBucket[]> {
  const logs = await loadLogs()
  return computeForgettingCurve(logs)
}

/** 未来 N 天复习压力（含今天；逾期并入今天） */
export async function getReviewPressure(
  days = 7,
  now: number = Date.now(),
): Promise<ReviewPressurePoint[]> {
  const db = getDb()
  const states = await db.states.toArray()
  return computeReviewPressure(states, now, days)
}

/** 不熟悉度 Top N（带词条/释义文本，UI 直接渲染） */
export interface UnfamiliarTopDetail extends UnfamiliarTopItem {
  deckId: string
  headword: string
  /** 含义中文（找不到时为空串） */
  cn: string
  pos?: string
}

export async function getUnfamiliarTop(limit = 10): Promise<UnfamiliarTopDetail[]> {
  const db = getDb()
  const states = await db.states.toArray()
  const top = computeUnfamiliarTop(states, limit)
  const deckOf = new Map<string, string>(states.map((state) => [state.wordId, state.deckId]))
  const words = await db.words.bulkGet([...new Set(top.map((item) => item.wordId))])
  const wordOf = new Map<string, Word>()
  for (const word of words) if (word) wordOf.set(word.id, word)
  return top.map((item) => {
    const word = wordOf.get(item.wordId)
    const meaning = word?.meanings.find((meaningItem) => meaningItem.id === item.meaningId)
    const detail: UnfamiliarTopDetail = {
      ...item,
      deckId: deckOf.get(item.wordId) ?? word?.deckId ?? '',
      headword: word?.headword ?? '',
      cn: meaning?.cn ?? '',
    }
    if (meaning?.pos) detail.pos = meaning.pos
    return detail
  })
}

/** 今日已学日期（首页「今日已学」判断用；等价 meta.lastStudyDate） */
export async function getLastStudyDate(): Promise<string | null> {
  const db = getDb()
  const row = await db.meta.get('lastStudyDate')
  return typeof row?.value === 'string' ? row.value : null
}

/** 今日是否已学（本地日期比较） */
export async function hasStudiedToday(now: number = Date.now()): Promise<boolean> {
  const last = await getLastStudyDate()
  return last === localDateKey(now)
}

/** 供 UI 导出类型用（避免 UI 再 import core 的统计类型） */
export type { DailyStatPoint, FeedbackDistribution, ForgettingCurveBucket, ReviewPressurePoint, StatsOverview, UnfamiliarTopItem, WordState }
