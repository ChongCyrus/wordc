import { useEffect, useState } from 'react'

export interface StepperProps {
  value: number
  min: number
  max: number
  step?: number
  onChange: (value: number) => void
  /** 显示在数字后的单位（如「次」） */
  suffix?: string
  ariaLabel?: string
}

/** 数字步进器（记忆总次数 1–10、每日学习量等） */
export function Stepper({ value, min, max, step = 1, onChange, suffix, ariaLabel }: StepperProps) {
  const clamp = (next: number) => Math.min(max, Math.max(min, next))
  return (
    <div className="mm-stepper" role="group" aria-label={ariaLabel}>
      <button
        type="button"
        className="mm-stepper-btn"
        aria-label="减少"
        disabled={value <= min}
        onClick={() => onChange(clamp(value - step))}
      >
        −
      </button>
      <span className="mm-stepper-value">
        {value}
        {suffix ? <span className="mm-caption"> {suffix}</span> : null}
      </span>
      <button
        type="button"
        className="mm-stepper-btn"
        aria-label="增加"
        disabled={value >= max}
        onClick={() => onChange(clamp(value + step))}
      >
        ＋
      </button>
    </div>
  )
}

export interface SliderProps {
  value: number
  min: number
  max: number
  step: number
  /** 拖动结束（松手/键盘抬起）才回调，避免频繁写数据库 */
  onChange: (value: number) => void
  ariaLabel: string
}

/** 滑杆（字号/卡片大小）：拖动中显示草稿值，松手后提交（SPEC §5：change 时保存） */
export function Slider({ value, min, max, step, onChange, ariaLabel }: SliderProps) {
  const [draft, setDraft] = useState(value)
  useEffect(() => {
    setDraft(value)
  }, [value])

  const commit = () => {
    if (draft !== value) onChange(draft)
  }

  return (
    <input
      className="mm-slider"
      type="range"
      min={min}
      max={max}
      step={step}
      value={draft}
      aria-label={ariaLabel}
      onChange={(event) => setDraft(Number(event.target.value))}
      onPointerUp={commit}
      onTouchEnd={commit}
      onKeyUp={commit}
      onBlur={commit}
    />
  )
}
