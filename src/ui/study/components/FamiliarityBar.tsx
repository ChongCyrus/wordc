import {
  familiarityBand,
  familiarityPercentLabel,
  familiarityWidthPercent,
} from '../lib/familiarity-display'

export interface FamiliarityBarProps {
  /** 0–1 的不熟悉度；null = 从未遇到（条为空 + “—”） */
  value: number | null
}

/**
 * 4px 不熟悉度条 + NaN 安全。
 * 5 档颜色由 CSS 类 fam-bar--0..4 控制（token --mm-fam-*）。
 */
export function FamiliarityBar({ value }: FamiliarityBarProps) {
  const band = familiarityBand(value)
  const width = familiarityWidthPercent(value)
  const label = familiarityPercentLabel(value)

  return (
    <>
      <div
        className={`fam-bar${band == null ? '' : ` fam-bar--${band}`}`}
        role="img"
        aria-label={`不熟悉度 ${label}`}
      >
        <div className="fam-fill" style={{ width: `${width}%` }} />
      </div>
    </>
  )
}

/** 百分比文字（与条同档色，13px 右对齐） */
export function FamiliarityPercent({ value }: { value: number | null }) {
  const band = familiarityBand(value)
  const label = familiarityPercentLabel(value)
  return (
    <span className={`fam-pct${band == null ? '' : ` fam-pct--${band}`}`}>
      {label}
    </span>
  )
}
