/**
 * 三键「下次出现」文案（展示层）。
 *
 * 两套数据来源：
 * - 官方预测（task-26：core.predictAll → Predict{first,days,progress}）：
 *   progress>=1 → `{days} 天后`；first → `今日 / {days} 天后`；否则 → `今日进度{round(progress*100)}%`。
 *   设置「预计复习间隔」隐藏时：first → `今日`；否则 → `今日进度{round(progress*100)}%`。
 * - 兼容旧预览（core.previewNext → 仅 longTermDays）：认识 N 天后 / 模糊 今日 · N 天后 / 不认识 今日 · 明天。
 */
import type { Rating } from '../components/types'

export type NextHints = Record<Rating, string>

export interface NextPreviewDays {
  /** 认识：评分后的长期间隔（天） */
  familiarDays: number
  /** 模糊：评分后的长期间隔（天） */
  vagueDays: number
  /** 模糊今天是否还会再出现（core.previewNext().todayRequeue，正常为 true） */
  vagueRequeue?: boolean
}

/** 官方 Predict 结构（core.predictAll 返回的单按钮预测） */
export interface OfficialPredict {
  /** 是否首次显示（新词第一次出现） */
  first: boolean
  /** 预计多少天后再次出现 */
  days: number
  /** 今日进度 0–1（>=1 表示今日已满足） */
  progress: number
}

export function formatDaysLater(days: number): string {
  const safe = Number.isFinite(days) ? Math.max(1, Math.round(days)) : 1
  return `${safe} 天后`
}

function formatPercent(progress: number): string {
  const safe = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  return `今日进度${Math.round(safe * 100)}%`
}

/**
 * 单个按钮副标题（官方逐字规则）。
 * @param showInterval 设置「预计复习间隔」是否显示（false 时只显示「今日」/进度）
 */
export function formatOfficialHint(predict: OfficialPredict, showInterval = true): string {
  const progress = Number.isFinite(predict.progress)
    ? Math.min(1, Math.max(0, predict.progress))
    : 0
  const days = formatDaysLater(predict.days)

  if (showInterval) {
    if (progress >= 1) return days
    if (predict.first) return `今日 / ${days}`
    return formatPercent(progress)
  }
  // 隐藏预计复习间隔：不暴露天数，只显示今日状态
  if (predict.first) return '今日'
  return formatPercent(progress)
}

/** 三个按钮各自独立格式化（认识/模糊/不认识） */
export function buildOfficialHints(
  predicts: Record<Rating, OfficialPredict>,
  showInterval = true,
): NextHints {
  return {
    familiar: formatOfficialHint(predicts.familiar, showInterval),
    vague: formatOfficialHint(predicts.vague, showInterval),
    forgot: formatOfficialHint(predicts.forgot, showInterval),
  }
}

/** 兼容旧 previewNext 的文案（认识 N 天后 / 模糊 今日 · N 天后 / 不认识 今日 · 明天） */
export function buildNextHints(preview: NextPreviewDays): NextHints {
  const vagueLater = formatDaysLater(preview.vagueDays)
  return {
    familiar: formatDaysLater(preview.familiarDays),
    vague: preview.vagueRequeue === false ? vagueLater : `今日 · ${vagueLater}`,
    forgot: '今日 · 明天',
  }
}
