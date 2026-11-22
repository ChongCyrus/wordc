import type { ReactNode } from 'react'

export interface SectionBandProps {
  title: string
  /** 右侧操作（如「↕ 排序」「管理」） */
  action?: ReactNode
}

/** 灰带分区标题（通栏 32px，#F5F6F6 底；参考 03-ui §2.3） */
export function SectionBand({ title, action }: SectionBandProps) {
  return (
    <div className="mm-section-band">
      <span>{title}</span>
      {action ? <span>{action}</span> : null}
    </div>
  )
}

export interface CardProps {
  children: ReactNode
  onClick?: () => void
  className?: string
  /** 去掉内边距（通栏内容） */
  padded?: boolean
}

export function Card({ children, onClick, className = '', padded = true }: CardProps) {
  const base = `mm-card${padded ? '' : ' mm-card--flush'}${onClick ? ' mm-card--clickable' : ''}`
  if (onClick) {
    return (
      <div className={`${base} ${className}`.trim()} onClick={onClick} role="button" tabIndex={0} onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onClick()
        }
      }}>
        {children}
      </div>
    )
  }
  return <div className={`${base} ${className}`.trim()}>{children}</div>
}
