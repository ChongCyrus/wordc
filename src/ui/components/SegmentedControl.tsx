export interface SegmentedOption<T extends string> {
  value: T
  label: string
}

export interface SegmentedControlProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>
  value: T
  onChange: (value: T) => void
  /** 撑满整行 */
  block?: boolean
  ariaLabel?: string
}

/** 分段控件（概览/已学/未学；默认/随机；浅色/深色） */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  block = false,
  ariaLabel,
}: SegmentedControlProps<T>) {
  return (
    <div className={`mm-seg${block ? ' mm-seg--block' : ''}`} role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`mm-seg-btn${option.value === value ? ' is-active' : ''}`}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
