/**
 * 不熟悉度展示映射（纯函数，可单测）。
 * 数据口径见 SPEC §4.6：f = clamp01(clicks / encounters)，encounters=0 → null。
 * 色阶 5 档见 docs/research/03-ui.md §5.2.2。
 */

/** 0–4 档；value=null（从未遇到）返回 null */
export function familiarityBand(value: number | null): 0 | 1 | 2 | 3 | 4 | null {
  if (value == null || !Number.isFinite(value)) return null
  const f = Math.min(1, Math.max(0, value))
  if (f < 0.2) return 0
  if (f < 0.4) return 1
  if (f < 0.6) return 2
  if (f < 0.8) return 3
  return 4
}

/** 条填充宽度百分比：0 不显示填充；否则至少 2%（保证可见） */
export function familiarityWidthPercent(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 0
  const f = Math.min(1, Math.max(0, value))
  if (f <= 0) return 0
  return Math.max(2, f * 100)
}

/** 百分比文案：null → "—"；其余四舍五入为整数百分比 */
export function familiarityPercentLabel(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—'
  const f = Math.min(1, Math.max(0, value))
  return `${Math.round(f * 100)}%`
}
