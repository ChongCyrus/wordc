export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label: string
  disabled?: boolean
}

/** 青绿开关（开=--mm-primary，关=--mm-surface-3） */
export function Switch({ checked, onChange, label, disabled = false }: SwitchProps) {
  return (
    <button
      type="button"
      className={`mm-switch${checked ? ' is-on' : ''}${disabled ? ' is-disabled' : ''}`}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span className="mm-switch-knob" />
    </button>
  )
}
