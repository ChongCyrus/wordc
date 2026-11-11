import { useEffect } from 'react'
import type { ReactNode } from 'react'

export interface DialogProps {
  open: boolean
  title: string
  onClose: () => void
  children?: ReactNode
  actions?: ReactNode
  /** 点遮罩/Esc 是否可关闭（表单提交中可关掉） */
  dismissable?: boolean
}

/** 对话框（180ms scale 淡入；Esc/点遮罩关闭） */
export function Dialog({ open, title, onClose, children, actions, dismissable = true }: DialogProps) {
  useEffect(() => {
    if (!open || !dismissable) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dismissable, onClose, open])

  if (!open) return null

  return (
    <div
      className="mm-mask"
      role="presentation"
      onClick={() => {
        if (dismissable) onClose()
      }}
    >
      <div
        className="mm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="mm-dialog-title">{title}</h2>
        {children ? <div className="mm-dialog-body">{children}</div> : null}
        {actions ? <div className="mm-dialog-actions">{actions}</div> : null}
      </div>
    </div>
  )
}

export interface ConfirmDialogProps {
  open: boolean
  title: string
  body?: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** 确认按钮红色（删除/清空等危险操作） */
  danger?: boolean
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}

/** 二次确认框（删除词库/清空数据/退出） */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = '确定',
  cancelLabel = '取消',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onCancel}
      dismissable={!busy}
      actions={
        <>
          <button type="button" className="mm-btn" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`mm-btn ${danger ? 'mm-btn--danger' : 'mm-btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? '处理中…' : confirmLabel}
          </button>
        </>
      }
    >
      {body}
    </Dialog>
  )
}
