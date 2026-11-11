import { useEffect } from 'react'
import type { ReactNode } from 'react'

export interface SheetProps {
  open: boolean
  title?: string
  onClose: () => void
  children: ReactNode
  /** 标题右侧关闭按钮 */
  showClose?: boolean
}

/** 底部弹层（280ms 上滑；Esc/点遮罩关闭） */
export function Sheet({ open, title, onClose, children, showClose = true }: SheetProps) {
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, onClose])

  if (!open) return null

  return (
    <div className="mm-sheet-mask" role="presentation" onClick={onClose}>
      <div
        className="mm-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title ?? '弹层'}
        onClick={(event) => event.stopPropagation()}
      >
        {title ? (
          <div className="mm-sheet-title">
            <span>{title}</span>
            {showClose ? (
              <button type="button" className="mm-icon-btn" aria-label="关闭" onClick={onClose}>
                ✕
              </button>
            ) : null}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  )
}

export interface ActionSheetItem {
  label: string
  danger?: boolean
  onSelect: () => void
}

export interface ActionSheetProps {
  open: boolean
  title?: string
  items: ActionSheetItem[]
  onClose: () => void
}

/** ⋮ 操作菜单（底部弹层） */
export function ActionSheet({ open, title, items, onClose }: ActionSheetProps) {
  return (
    <Sheet open={open} title={title} onClose={onClose}>
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          className={`mm-sheet-item${item.danger ? ' mm-sheet-item--danger' : ''}`}
          onClick={() => {
            onClose()
            item.onSelect()
          }}
        >
          {item.label}
        </button>
      ))}
    </Sheet>
  )
}
