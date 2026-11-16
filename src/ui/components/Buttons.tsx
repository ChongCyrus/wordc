import type { ButtonHTMLAttributes, ReactNode } from 'react'

export type ButtonVariant = 'primary' | 'soft' | 'ghost' | 'danger' | 'default'
export type ButtonSize = 'sm' | 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  block?: boolean
  icon?: ReactNode
  children: ReactNode
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'mm-btn--primary',
  soft: 'mm-btn--soft',
  ghost: 'mm-btn--ghost',
  danger: 'mm-btn--danger',
  default: '',
}

/** 主/次/幽灵/危险按钮（高度 44，lg=48；触控 ≥44px） */
export function Button({
  variant = 'default',
  size = 'md',
  block = false,
  icon,
  children,
  className = '',
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`mm-btn ${VARIANT_CLASS[variant]} ${size === 'lg' ? 'mm-btn--lg' : ''} ${
        size === 'sm' ? 'mm-btn--sm' : ''
      } ${block ? 'mm-btn--block' : ''} ${className}`.trim()}
      {...rest}
    >
      {icon}
      {children}
    </button>
  )
}

export type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  children: ReactNode
  primary?: boolean
}

/** 顶栏/行内图标按钮（44×44） */
export function IconButton({ label, children, primary = false, className = '', type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      aria-label={label}
      title={label}
      className={`mm-icon-btn${primary ? ' mm-icon-btn--primary' : ''} ${className}`.trim()}
      {...rest}
    >
      {children}
    </button>
  )
}
