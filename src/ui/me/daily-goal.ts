/**
 * 每日学习量输入校验（task-27：官方允许任意正整数，实测可设 9999；不再卡 200）。
 * 纯函数，供设置页输入框与单测使用。
 */

export const DAILY_GOAL_MIN = 1
export const DAILY_GOAL_MAX = 9999

export interface DailyGoalParseResult {
  ok: boolean
  /** 合法时的整数值 */
  value?: number
  /** 非法时的中文提示 */
  message?: string
}

export function parseDailyGoalInput(raw: string): DailyGoalParseResult {
  const text = raw.trim()
  if (!text) return { ok: false, message: '请输入每日学习量' }
  if (!/^\d+$/.test(text)) return { ok: false, message: '只能输入 1–9999 的正整数' }
  const value = Number(text)
  if (!Number.isSafeInteger(value)) return { ok: false, message: '数值过大' }
  if (value < DAILY_GOAL_MIN) return { ok: false, message: `最少 ${DAILY_GOAL_MIN} 个` }
  if (value > DAILY_GOAL_MAX) return { ok: false, message: `最多 ${DAILY_GOAL_MAX} 个` }
  return { ok: true, value }
}
