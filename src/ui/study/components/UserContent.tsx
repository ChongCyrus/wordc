import { useEffect, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import type { UserMnemonicType, UserMnemonicView, UserNoteView } from './types'

/** 「AI」徽标（AI/内置内容；已隐藏的不展示） */
export function AiBadge() {
  return <span className="ai-badge">AI</span>
}

/** 「我的」徽标（与 AI/内置区分） */
export function MineBadge() {
  return <span className="mine-badge">我的</span>
}

export function UserNoteLine({ note }: { note: UserNoteView }) {
  return (
    <div className="user-content-line">
      <MineBadge />
      <span className="user-content-text">{note.text}</span>
    </div>
  )
}

export function UserMnemonicLine({ mnemonic }: { mnemonic: UserMnemonicView }) {
  return (
    <div className="user-content-line">
      <MineBadge />
      <span className="user-content-type">[{mnemonic.type}]</span>
      <span className="user-content-text">{mnemonic.text}</span>
    </div>
  )
}

export interface UserContentEditorProps {
  open: boolean
  /** 显示目标：单词 or cX 中文 */
  targetLabel: string
  mode: 'note' | 'mnemonic'
  initialText?: string
  initialType?: UserMnemonicType
  onSave: (input: { text: string; type?: UserMnemonicType }) => void
  onDelete?: () => void
  onClose: () => void
  saving?: boolean
}

/** 用户笔记/助记编辑弹层（F6；保存/删除由调用方注入 data API） */
export function UserContentEditor({
  open,
  targetLabel,
  mode,
  initialText = '',
  initialType = '联想',
  onSave,
  onDelete,
  onClose,
  saving = false,
}: UserContentEditorProps) {
  const [text, setText] = useState(initialText)
  const [type, setType] = useState<UserMnemonicType>(initialType)
  // 打开/切换目标时重置（避免串目标/串类型）
  useEffect(() => {
    if (!open) return
    setText(initialText)
    setType(initialType)
  }, [open, initialText, initialType, targetLabel, mode])
  if (!open) return null
  return (
    <Dialog
      open={open}
      title={mode === 'note' ? `我的笔记 · ${targetLabel}` : `我的助记 · ${targetLabel}`}
      onClose={onClose}
      dismissable={false}
      actions={
        <>
          {onDelete ? (
            <button type="button" className="mm-btn mm-btn--danger" onClick={onDelete} disabled={saving}>
              删除
            </button>
          ) : null}
          <button type="button" className="mm-btn" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            disabled={saving || text.trim().length === 0}
            onClick={() => onSave({ text: text.trim(), ...(mode === 'mnemonic' ? { type } : {}) })}
          >
            保存
          </button>
        </>
      }
    >
      {mode === 'mnemonic' ? (
        <label className="mm-field">
          <span className="mm-field-label">助记类型</span>
          <select
            className="mm-input"
            aria-label="助记类型"
            value={type}
            onChange={(event) => setType(event.target.value as UserMnemonicType)}
          >
            {(['联想', '谐音', '词根', '词源', '串记', '口诀', '其他'] as const).map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <label className="mm-field">
        <span className="mm-field-label">内容（多行，自动换行）</span>
        <textarea
          className="mm-input"
          aria-label="内容"
          rows={4}
          value={text}
          placeholder={mode === 'note' ? '写下你的记忆笔记…' : '写下帮助记住 w→c 的助记…'}
          onChange={(event) => setText(event.target.value)}
        />
      </label>
      <div className="mm-caption">只保存在本机；保存后立即显示，不影响学习进度，AI 内容不会覆盖你的笔记。</div>
    </Dialog>
  )
}
