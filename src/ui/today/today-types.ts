/**
 * 「今日单词」页数据模型（task-49 提供 data.getTodayBreakdown；此处先定义 UI 侧 ViewModel，
 * 数据接口落地后由 `useTodayBreakdown` 映射，字段与 task-49 契约一致）。
 */
import type { Rating } from '../../core'

export type TodayWordCategory = 'review' | 'new'

export interface TodayWordView {
  wordId: string
  headword: string
  category: TodayWordCategory
  /** 今天是否已评分（含回炉后的最新一次） */
  learned: boolean
  /** 已学时的最近一次评分（未撤销） */
  rating?: Rating
  /** 是否为手动加学词（isExtra） */
  isExtra: boolean
  /** 是否为当日回炉再次出现的词 */
  requeued: boolean
}

export interface TodayCategoryStats {
  planned: number
  learned: number
  remaining: number
}

export interface TodayBreakdownView {
  review: TodayCategoryStats
  new: TodayCategoryStats
  /** 去重后的词列表（复习组 + 新学组，组内按 plan 首次出现顺序） */
  items: TodayWordView[]
  totalPlanned: number
  totalLearned: number
}

export const EMPTY_TODAY_BREAKDOWN: TodayBreakdownView = {
  review: { planned: 0, learned: 0, remaining: 0 },
  new: { planned: 0, learned: 0, remaining: 0 },
  items: [],
  totalPlanned: 0,
  totalLearned: 0,
}

export const RATING_LABEL: Record<Rating, string> = {
  familiar: '认识',
  vague: '模糊',
  forgot: '忘记',
}

/** 词条右侧标签（已学显示评分；未学；加学/回炉为附加标记） */
export function wordTags(word: TodayWordView): Array<{
  label: string
  kind: 'rating' | 'unlearned' | 'extra' | 'requeue'
}> {
  const tags: Array<{ label: string; kind: 'rating' | 'unlearned' | 'extra' | 'requeue' }> = []
  if (word.learned && word.rating) tags.push({ label: RATING_LABEL[word.rating], kind: 'rating' })
  if (!word.learned) tags.push({ label: '未学', kind: 'unlearned' })
  if (word.isExtra) tags.push({ label: '加学', kind: 'extra' })
  if (word.requeued) tags.push({ label: '回炉', kind: 'requeue' })
  return tags
}

/** 按分区拆分（去空组；组内保持 items 顺序） */
export function groupsOf(breakdown: TodayBreakdownView): {
  review: TodayWordView[]
  new: TodayWordView[]
} {
  return {
    review: breakdown.items.filter((word) => word.category === 'review'),
    new: breakdown.items.filter((word) => word.category === 'new'),
  }
}
