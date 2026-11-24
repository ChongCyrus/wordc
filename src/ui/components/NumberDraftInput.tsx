import { useEffect, useState } from 'react'
import type { InputHTMLAttributes } from 'react'

export interface NumberDraftInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange' | 'onBlur'> {
  value: number
  min?: number
  max?: number
  onCommit: (value: number) => void
}

export function commitNumberDraft(
  draft: string,
  lastValid: number,
  min?: number,
  max?: number,
): { value: number; draft: string } {
  const raw = draft.trim()
  const parsed = raw === '' ? NaN : Number(raw)
  if (!Number.isFinite(parsed)) return { value: lastValid, draft: String(lastValid) }
  const lower = min ?? -Infinity
  const upper = max ?? Infinity
  const value = Math.max(lower, Math.min(upper, parsed))
  return { value, draft: String(value) }
}

/** 0.11.1：数字输入用草稿字符串，允许删空重输；blur/Enter 再 parse+clamp */
export function NumberDraftInput({ value, min, max, onCommit, ...rest }: NumberDraftInputProps) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => {
    setDraft(String(value))
  }, [value])

  const commit = () => {
    const next = commitNumberDraft(draft, value, min, max)
    setDraft(next.draft)
    onCommit(next.value)
  }

  return (
    <input
      {...rest}
      className={rest.className ?? 'mm-input'}
      type="number"
      min={min}
      max={max}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }}
    />
  )
}
