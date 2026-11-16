import { Dialog } from '../../components/Dialog'

export interface RareMeaningPreviewItem {
  meaningId: string
  pos?: string
  cn: string
}

/** A：当前词 AI 标记不常考——先预览勾选，确认后写 rareMeaningIds（已有标记保留） */
export function RareMeaningsPreviewDialog({
  open,
  word,
  items,
  selected,
  busy = false,
  error = null,
  onToggle,
  onApply,
  onClose,
}: {
  open: boolean
  word: string
  items: RareMeaningPreviewItem[]
  selected: string[]
  busy?: boolean
  error?: string | null
  onToggle: (meaningId: string) => void
  onApply: () => void
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      title={`AI 标记不常考 · ${word}`}
      overlayClassName="mm-mask--above-generative"
      dismissable={!busy}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="mm-btn" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            onClick={onApply}
            disabled={busy || selected.length === 0}
          >
            应用已选（{selected.length}）
          </button>
        </>
      }
    >
      <div className="mm-caption">AI 建议下列含义为「不常考」，可取消勾选；已有标记会保留。</div>
      <div className="mm-list">
        {items.map((item) => (
          <label className="mm-row" key={item.meaningId}>
            <span className="mm-row-main">
              <span className="mm-row-title">
                {item.pos ? `[${item.pos}] ` : ''}
                {item.cn}
              </span>
            </span>
            <input
              type="checkbox"
              aria-label={`应用「${item.cn}」的不常考标记`}
              checked={selected.includes(item.meaningId)}
              onChange={() => onToggle(item.meaningId)}
            />
          </label>
        ))}
      </div>
      {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
    </Dialog>
  )
}
