import { useEffect } from 'react'
import type { ReactNode } from 'react'

export interface ConfirmDialogProps {
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 确认按钮用红色（危险操作，如退出/放弃进度） */
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 学习页确认弹窗（遮罩 + 180ms scale 淡入；Esc 取消） */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onCancel])

  return (
    <div className="study-mask" onClick={onCancel} role="presentation">
      <div
        className="study-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="study-dialog-title">{title}</h2>
        {body ? <p className="study-dialog-body">{body}</p> : null}
        <div className="study-dialog-actions">
          <button type="button" className="study-btn" onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`study-btn ${danger ? 'study-btn--danger' : 'study-btn--primary'}`}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
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
  items: ActionSheetItem[]
  onClose: () => void
}

/** 学习页 ⋮ 菜单（底部弹层） */
export function ActionSheet({ items, onClose }: ActionSheetProps) {
  return (
    <div className="study-sheet-mask" onClick={onClose} role="presentation">
      <div
        className="study-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="更多操作"
        onClick={(event) => event.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`study-sheet-item${item.danger ? ' is-danger' : ''}`}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}
