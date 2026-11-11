export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
}

/** 青绿开关（开=--mm-primary，关=--mm-surface-3） */
export function Switch({ checked, onChange, label }: SwitchProps) {
  return (
    <button
      type="button"
      className={`mm-switch${checked ? ' is-on' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
    >
      <span className="mm-switch-knob" />
    </button>
  )
}
