/**
 * 今日学习计划 v2 —— data 层过渡类型（task-28/29）。
 *
 * v2 core 契约已落地（dev-algo）：`DailyPlan / PlanRating / PlanWordSource / HomeStudyState`
 * 与 `ReviewLog.stateBefore/corrected/correctedBy` 都在 `src/core/types.ts`，这里只做 re-export，
 * 保证 UI 从 `src/data` 也能拿到同一份类型（对外签名不变）。
 * data 层只保留自己独有的 `LastReviewSnapshot` / `HomeStudyData`。
 */

import type { Rating, ReviewLog, WordState } from '../core'

export type { DailyPlan, PlanRating, PlanWordSource, HomeStudyState } from '../core'

/**
 * v2 ReviewLog：core 已含 `stateBefore/corrected/correctedBy`；
 * `reverted` 是 task-29 早期命名，数据层撤销时同时写 true（兼容读）。
 */
export type ReviewLogV2 = ReviewLog & {
  /** 与 corrected 同义的旧命名兼容字段 */
  reverted?: boolean
}

/** 回退/改判用的最近一次评分快照 */
export interface LastReviewSnapshot {
  log: ReviewLogV2
  /** 评分前状态；null = 该词首评前不存在 state（撤销时删除） */
  stateBefore: WordState | null
  /** 该词在 plan.wordIds 中的位置（有 plan 时） */
  planIndex?: number
  planId?: string
}

/** 今日已学拆分：单词分类（复习/新学） */
export type TodayWordCategory = 'review' | 'new'

/** 今日已学拆分里的单词条目（task-49；派生数据，不持久化/不进迁移包） */
export interface TodayWordItem {
  wordId: string
  headword: string
  /** review = firstSeenAt 早于今日 0 点；new = 其余 */
  category: TodayWordCategory
  /** 已学 = plan.ratings 里有未撤销评分（或 index 已越过） */
  learned: boolean
  /** 最近一次未撤销评分（未学为 undefined） */
  rating?: Rating
  /** 是否用户手动加学（sources === 'extra'） */
  isExtra: boolean
  /** 是否当日回炉词（plan.wordIds 里重复出现或 sources === 'requeue'；计数仍只算一次） */
  requeued: boolean
}

export interface TodayBreakdownCounts {
  planned: number
  learned: number
  remaining: number
}

/** 今日已学拆分（首页/统计展示用；派生数据，不持久化） */
export interface TodayBreakdown {
  deckId: string
  /** 本地日期 key */
  date: string
  planId: string | null
  review: TodayBreakdownCounts
  new: TodayBreakdownCounts
  totalPlanned: number
  totalLearned: number
  /** 去重、按 category 分组（review 在前）、组内按 plan 首次出现顺序 */
  items: TodayWordItem[]
}

/** 首页 6 态所需的事实数据（判定/文案由 core `deriveHomeState` 或 UI 按 SPEC-v2 §6.2 做） */
export interface HomeStudyData {
  now: number
  deckId: string
  /** 是否已有词库 */
  hasDeck: boolean
  /** 是否有可学词条（词库词数 > 0） */
  hasLearnableWord: boolean
  /** 今日到期复习数（全部，不截断） */
  dueCount: number
  /**
   * 待新学预算：**max(0, dailyGoal − 今日入队复习数)**。
   * 有 plan 时取建队快照 `plan.goals.newBudget`（已含 reviewCap/随机后的真实预算）；
   * 无 plan 时按 `min(全部到期, dailyReviewCap)` 预估今日入队数（cap=0 即全部到期）。
   */
  newBudget: number
  dailyGoal: number
  /** 今日 plan（无则 null；不主动建队） */
  plan: import('../core').DailyPlan | null
  /** plan 剩余待处理次数（wordIds.length - index；无 plan 为 0） */
  remaining: number
  /** 今日已学（去重词数，只计未撤销的首次反馈） */
  todayReviewed: number
  /** plan 完成后仍剩余的到期复习数（未完成 plan 为 0） */
  overdueLeft: number
  /** task-49：今日已学拆分（复习/新学 planned/learned/remaining + 词列表；无 plan 时全 0） */
  breakdown: TodayBreakdown
  /**
   * task-51：今日入队复习数（受 dailyReviewCap 限制）。
   * 有 plan 时 = `getTodayBreakdown().review.planned`；无 plan 时按 `min(dueCount, cap)` 预估。
   */
  plannedReview: number
  /** task-51：因每日复习上限而顺延的到期数 = max(0, dueCount − plannedReview) */
  reviewBacklog: number
  /** task-51：当前生效的每日复习上限（0=不限；已有 plan 用建队快照） */
  dailyReviewCap: number
}
