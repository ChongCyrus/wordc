/**
 * 三键主标签（官方行为）：
 * - 首次显示（新词第一次出现）：认识 / 不确定 / 不认识
 * - 之后：认识 / 模糊 / 忘记
 * - 设置开关 labelSwitch=false：恢复旧固定文案 认识 / 模糊 / 不认识
 */
import type { Rating } from '../components/types'

export type RatingLabels = Record<Rating, string>

export interface LabelSwitchOptions {
  /** 是否为新词首次显示（firstSeenAt == null 或 phase === 'new'） */
  isFirstShow: boolean
  /** 设置 study.labelSwitch：true=官方按首次切换；false=恢复旧固定文案 */
  labelSwitch: boolean
}

export const OFFICIAL_FIRST_LABELS: RatingLabels = {
  familiar: '认识',
  vague: '不确定',
  forgot: '不认识',
}

export const OFFICIAL_LATER_LABELS: RatingLabels = {
  familiar: '认识',
  vague: '模糊',
  forgot: '忘记',
}

export const LEGACY_LABELS: RatingLabels = {
  familiar: '认识',
  vague: '模糊',
  forgot: '不认识',
}

export function ratingLabels({ isFirstShow, labelSwitch }: LabelSwitchOptions): RatingLabels {
  if (!labelSwitch) return LEGACY_LABELS
  return isFirstShow ? OFFICIAL_FIRST_LABELS : OFFICIAL_LATER_LABELS
}

/** 从 WordState 判断是否首次显示（新词第一次出现） */
export function isFirstShowOf(state: { phase: string; firstSeenAt: number | null } | null | undefined): boolean {
  if (!state) return true
  return state.firstSeenAt == null || state.phase === 'new'
}
