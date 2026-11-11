import type { ReactNode } from 'react'
import { ChevronRightIcon } from './icons'

export interface SettingRowProps {
  label: string
  /** 副标题（说明/当前值） */
  hint?: string
  /** 右侧展示值（文本） */
  value?: ReactNode
  /** 右侧控件（Switch/Slider/Stepper/Segmented）；与 value 二选一 */
  control?: ReactNode
  onClick?: () => void
  /** 显示右侧 ›（导航类行） */
  chevron?: boolean
  /** 危险操作：文字红色 */
  danger?: boolean
  disabled?: boolean
}

/**
 * 设置/列表行：左标签（+说明），右侧值或控件。
 * 导航类（onClick + chevron）整行可点；控件类整行不可点（避免误触开关）。
 */
export function SettingRow({
  label,
  hint,
  value,
  control,
  onClick,
  chevron = false,
  danger = false,
  disabled = false,
}: SettingRowProps) {
  const content = (
    <>
      <span className="mm-row-main">
        <span className={`mm-row-title${danger ? ' mm-danger-text' : ''}`}>{label}</span>
        {hint ? <span className="mm-row-sub">{hint}</span> : null}
      </span>
      {value != null ? <span className="mm-setting-value">{value}</span> : null}
      {control ? <span className="mm-setting-value">{control}</span> : null}
      {chevron ? <ChevronRightIcon className="mm-chevron" size={18} /> : null}
    </>
  )

  if (onClick && !disabled) {
    return (
      <button type="button" className="mm-row" onClick={onClick}>
        {content}
      </button>
    )
  }
  return (
    <div className={`mm-row mm-row--static${disabled ? ' is-disabled' : ''}`} aria-disabled={disabled || undefined}>
      {content}
    </div>
  )
}
