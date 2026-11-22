/**
 * 「每日复习上限」（task-51/52）：`study.dailyReviewCap`
 *
 * - 0 = 不限（默认，保持官方语义）；1–9999 = 每日自动入队的到期复习上限；
 * - 超出上限的到期复习**不删除、不改 dueAt**，顺延到之后（不丢失）；
 * - 今日新学预算 = 学习量 − 今日实际入队的复习数；
 * - 数据层 key 未落地时设置页自动隐藏该行（hasDailyReviewCapSetting=false）。
 */
import type { SettingsMap } from '../../core'
import { updateSettings } from '../../data'

export const DAILY_REVIEW_CAP_KEY = 'study.dailyReviewCap'
export const DEFAULT_DAILY_REVIEW_CAP = 0
export const DAILY_REVIEW_CAP_MAX = 9999

export const DAILY_REVIEW_CAP_PRESETS: ReadonlyArray<number> = [0, 50, 100, 200]

export const DAILY_REVIEW_CAP_HINT =
  '0 = 不限（默认）；超出上限的到期复习顺延到之后（不丢失），今日新学预算 = 学习量 − 今日入队复习数'

/** 数据层是否已支持该 key */
export function hasDailyReviewCapSetting(
  settings: SettingsMap | null | undefined,
): boolean {
  return settings != null && Object.prototype.hasOwnProperty.call(settings, DAILY_REVIEW_CAP_KEY)
}

/** 读取上限（缺失/非法 → 0 不限） */
export function readDailyReviewCap(settings: SettingsMap | null | undefined): number {
  const raw = settings
    ? (settings as unknown as Record<string, unknown>)[DAILY_REVIEW_CAP_KEY]
    : undefined
  return normalizeDailyReviewCap(raw)
}

export function normalizeDailyReviewCap(raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isInteger(value) || value < 0 || value > DAILY_REVIEW_CAP_MAX) return 0
  return value
}

/** 展示文案：0 → 不限；其余 → N 个 */
export function dailyReviewCapLabel(cap: number): string {
  const value = normalizeDailyReviewCap(cap)
  return value === 0 ? '不限' : `${value} 个`
}

/**
 * 解析自定义输入（0–9999 整数；0=不限）。
 * 空串/非法返回错误提示且不写入。
 */
export function parseDailyReviewCapInput(raw: string): {
  ok: boolean
  value?: number
  message?: string
} {
  const text = raw.trim()
  if (!text) return { ok: false, message: '请输入每日复习上限（0 = 不限）' }
  if (!/^\d+$/.test(text)) return { ok: false, message: '只能输入 0–9999 的整数' }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) return { ok: false, message: '数值过大' }
  if (value > DAILY_REVIEW_CAP_MAX) return { ok: false, message: `最多 ${DAILY_REVIEW_CAP_MAX}` }
  return { ok: true, value }
}

export type UpdateSettingsFn = (patch: Partial<SettingsMap>) => Promise<unknown>

/** 保存复习上限：非法值抛错且不写；合法值透传 updateSettings（可注入 mock） */
export async function saveDailyReviewCap(
  value: number,
  update: UpdateSettingsFn = updateSettings,
): Promise<number> {
  const normalized = normalizeDailyReviewCap(value)
  if (typeof value !== 'number' || value !== normalized) {
    throw new Error(`每日复习上限值不合法：${String(value)}`)
  }
  await update({
    [DAILY_REVIEW_CAP_KEY]: normalized,
  } as unknown as Partial<SettingsMap>)
  return normalized
}
