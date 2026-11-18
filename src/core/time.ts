/**
 * 时间工具（纯函数，可单测）。
 *
 * 全部按**用户本地时区**计算：到期日、每日学习量、连续打卡都按「本地日期」，
 * 避免深夜学习 / 时区切换导致的跨日错误（SPEC §3.6）。
 */

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000

/** epoch ms → 本地 YYYY-MM-DD */
export function localDateKey(timestamp: number): string {
  const d = new Date(timestamp)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** epoch ms → 本地当天 00:00 的 epoch ms */
export function startOfLocalDay(timestamp: number): number {
  const d = new Date(timestamp)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 加 n 天（按本地日历天，自动处理夏令时等边界；n 可为负数/小数） */
export function addDays(timestamp: number, days: number): number {
  const d = new Date(timestamp)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

/**
 * 本地日期相差天数：`dayDiff(later, earlier)` = later 的本地日期 - earlier 的本地日期。
 * 用本地日期 00:00 的毫秒差 / DAY_MS 再四舍五入，规避夏令时导致的 23/25 小时。
 */
export function dayDiff(later: number, earlier: number): number {
  return Math.round((startOfLocalDay(later) - startOfLocalDay(earlier)) / DAY_MS)
}

/**
 * 两个时间点之间的天数差（允许小数，按毫秒直算）。
 * 调度里算 `elapsedDays` 用这个（SPEC §3.5 注意 5）。
 */
export function daysBetween(later: number, earlier: number): number {
  return (later - earlier) / DAY_MS
}

/** 本地日期 key 是否为「今天」（相对 now） */
export function isSameLocalDay(a: number, b: number): boolean {
  return localDateKey(a) === localDateKey(b)
}
