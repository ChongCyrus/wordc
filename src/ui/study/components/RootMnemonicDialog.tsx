import { useEffect, useState } from 'react'
import { Dialog } from '../../components/Dialog'

/** task-197：w→生成元 映射助记编辑/AI 候选（共享 Word.rootMnemonic） */
export function RootMnemonicDialog({
  open,
  word,
  rootLabel,
  initialText,
  candidates,
  busy = false,
  error = null,
  saveStatus = null,
  onGenerate,
  onSave,
  onClose,
}: {
  open: boolean
  word: string
  rootLabel?: string
  initialText: string
  candidates: string[]
  busy?: boolean
  error?: string | null
  saveStatus?: string | null
  onGenerate?: () => void
  onSave: (text: string) => void
  onClose: () => void
}) {
  const [text, setText] = useState(initialText)
  useEffect(() => {
    if (open) setText(initialText)
  }, [open, initialText, word])
  return (
    <Dialog
      open={open}
      title={`生成元映射助记 · ${word}${rootLabel ? ` → ${rootLabel}` : ''}`}
      overlayClassName="mm-mask--above-generative"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="mm-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            disabled={busy || text.trim().length === 0}
            onClick={() => onSave(text.trim())}
          >
            保存
          </button>
        </>
      }
    >
      <div className="root-mnemonic-dialog">
        <label className="mm-field">
          <span className="mm-field-label">助记内容（帮助记住「单词 → 生成元」）</span>
          <textarea
            className="mm-input"
            aria-label="生成元映射助记"
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        {onGenerate ? (
          <button type="button" className="mm-btn" onClick={onGenerate} disabled={busy}>
            {busy ? 'AI 生成中…' : 'AI 生成助记'}
          </button>
        ) : null}
        {candidates.length > 0 ? (
          <div className="root-mnemonic-candidates">
            <span className="mm-caption">AI 候选（点选填入）：</span>
            {candidates.map((candidate, index) => (
              <button
                type="button"
                className="mm-btn mm-btn--sm"
                key={`${index}-${candidate.slice(0, 6)}`}
                onClick={() => setText(candidate)}
              >
                {candidate}
              </button>
            ))}
          </div>
        ) : null}
        {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
        {saveStatus ? <div className="mm-caption">{saveStatus}</div> : null}
      </div>
    </Dialog>
  )
}
