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
  coreItems = [],
  coreSelected = [],
  busy = false,
  error = null,
  onToggle,
  onToggleCore,
  onApply,
  onClose,
}: {
  open: boolean
  word: string
  items: RareMeaningPreviewItem[]
  selected: string[]
  coreItems?: Array<{ coreSenseIndex: number; label: string; cn?: string }>
  coreSelected?: number[]
  busy?: boolean
  error?: string | null
  onToggle: (meaningId: string) => void
  onToggleCore?: (coreSenseIndex: number) => void
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
            disabled={busy || selected.length + coreSelected.length === 0}
          >
            应用已选（含义 {selected.length} · 本义 {coreSelected.length}）
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
      {coreItems.length > 0 ? (
        <>
          <div className="mm-caption">本义建议（同一开关下 AI 判定的不常考本义，可取消勾选）</div>
          <div className="mm-list">
            {coreItems.map((item) => (
              <label className="mm-row" key={`core-${item.coreSenseIndex}`}>
                <span className="mm-row-main">
                  <span className="mm-row-title">本义{item.coreSenseIndex}「{item.label}」</span>
                  {item.cn ? <span className="mm-row-sub">{item.cn}</span> : null}
                </span>
                <input
                  type="checkbox"
                  aria-label={`应用本义${item.coreSenseIndex}「${item.label}」的不常考标记`}
                  checked={coreSelected.includes(item.coreSenseIndex)}
                  onChange={() => onToggleCore?.(item.coreSenseIndex)}
                />
              </label>
            ))}
          </div>
        </>
      ) : null}
      {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
    </Dialog>
  )
}
