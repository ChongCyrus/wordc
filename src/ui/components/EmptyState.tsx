import type { ReactNode } from 'react'
import { OwlIcon } from './icons'

export interface EmptyStateProps {
  title: string
  description?: string
  action?: ReactNode
  icon?: ReactNode
}

/** 空状态（猫头鹰单色 SVG + 文案 + 可选按钮） */
export function EmptyState({ title, description, action, icon }: EmptyStateProps) {
  return (
    <div className="mm-empty">
      {icon ?? <OwlIcon size={80} className="mm-owl" />}
      <h2 className="mm-empty-title">{title}</h2>
      {description ? <p className="mm-empty-desc">{description}</p> : null}
      {action}
    </div>
  )
}
