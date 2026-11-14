import { useEffect, useMemo, useState } from 'react'
import type { DerivationMapContent } from './types'

export interface DerivationPanelProps {
  open: boolean
  /** 当前词/目标 */
  headword: string
  content: DerivationMapContent
  onClose: () => void
  onSave: (content: DerivationMapContent) => void
  /** AI 生成（结果先预览，保存才写入） */
  onAiGenerate?: () => void
  aiBusy?: boolean
  aiError?: string | null
  saving?: boolean
}

/** 文本内容：生成元 → 场景/对象/词性 → 含义，完整换行 */
export function DerivationTextView({ text }: { text: string }) {
  return <pre className="derivation-map-text">{text}</pre>
}

let mermaidSeq = 0

/** Mermaid 预览：按需动态加载（不进入首屏）；失败回退源码，不阻塞 */
export function MermaidPreview({ source }: { source: string }) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const id = useMemo(() => `mmd-${++mermaidSeq}`, [source])

  useEffect(() => {
    let alive = true
    setSvg('')
    setError(null)
    const code = source.trim()
    if (!code) return
    void (async () => {
      try {
        const mod = (await import(/* @vite-ignore */ 'mermaid')) as {
          default?: { initialize: (opts: Record<string, unknown>) => void; render: (id: string, code: string) => Promise<{ svg: string }> }
          initialize?: (opts: Record<string, unknown>) => void
          render?: (id: string, code: string) => Promise<{ svg: string }>
        }
        const mermaid = mod.default ?? (mod as never)
        const api = mermaid as unknown as {
          initialize: (opts: Record<string, unknown>) => void
          render: (id: string, code: string) => Promise<{ svg: string }>
        }
        if (typeof api.initialize !== 'function' || typeof api.render !== 'function') {
          throw new Error('Mermaid 渲染器不可用')
        }
        api.initialize({ startOnLoad: false, securityLevel: 'strict' })
        const rendered = await api.render(id, code)
        if (alive) setSvg(rendered.svg)
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : 'Mermaid 渲染失败')
      }
    })()
    return () => {
      alive = false
    }
  }, [source, id])

  if (svg) {
    return <div className="derivation-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
  }
  return (
    <div className="derivation-mermaid-fallback">
      <pre className="derivation-map-text">{source}</pre>
      {error ? <div className="mm-caption mm-danger-text">Mermaid 渲染失败：{error}（已显示源码）</div> : null}
    </div>
  )
}

/** F8 注释面右侧副页：文字/Mermaid 渲染 + 编辑 + AI 预览 */
export function DerivationPanel({
  open,
  headword,
  content,
  onClose,
  onSave,
  onAiGenerate,
  aiBusy = false,
  aiError = null,
  saving = false,
}: DerivationPanelProps) {
  const [mode, setMode] = useState(content.mode)
  const [text, setText] = useState(content.text)
  const [mermaid, setMermaid] = useState(content.mermaid)
  const [editing, setEditing] = useState(false)
  const [rootLabel, setRootLabel] = useState(content.rootLabel ?? '')

  useEffect(() => {
    setMode(content.mode)
    setText(content.text)
    setMermaid(content.mermaid)
    setRootLabel(content.rootLabel ?? '')
    setEditing(false)
  }, [content.mode, content.text, content.mermaid, content.rootLabel, headword])

  if (!open) return null
  const source = mode === 'mermaid' ? mermaid : text

  return (
    <aside className="derivation-panel" aria-label={`${headword} 生成元引申`}>
      <div className="derivation-panel-head">
        <span className="mm-row-title">生成元 → 含义</span>
        <button type="button" className="mm-btn mm-btn--ghost mm-btn--sm" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="mm-btn-row">
        <button
          type="button"
          className={`mm-btn${mode === 'text' ? ' mm-btn--primary' : ''}`}
          aria-pressed={mode === 'text'}
          onClick={() => setMode('text')}
        >
          文字
        </button>
        <button
          type="button"
          className={`mm-btn${mode === 'mermaid' ? ' mm-btn--primary' : ''}`}
          aria-pressed={mode === 'mermaid'}
          onClick={() => setMode('mermaid')}
        >
          Mermaid
        </button>
        <button type="button" className="mm-btn" onClick={() => setEditing((value) => !value)}>
          {editing ? '预览' : '编辑'}
        </button>
      </div>

      {editing ? (
        <input
          className="mm-input"
          aria-label="生成元（本义）"
          placeholder="生成元/本义（可选，2–10 字）"
          value={rootLabel}
          onChange={(event) => setRootLabel(event.target.value)}
        />
      ) : content.rootLabel ? (
        <div className="mm-caption">生成元：{content.rootLabel}</div>
      ) : null}

      {editing ? (
        <textarea
          className="mm-input derivation-panel-editor"
          aria-label={mode === 'mermaid' ? 'Mermaid 源码' : '引申文字'}
          value={source}
          onChange={(event) =>
            mode === 'mermaid' ? setMermaid(event.target.value) : setText(event.target.value)
          }
          rows={10}
        />
      ) : mode === 'mermaid' ? (
        <MermaidPreview source={mermaid} />
      ) : (
        <DerivationTextView text={text} />
      )}

      {aiBusy ? <div className="mm-caption">正在生成引申图…</div> : null}
      {aiError ? <div className="mm-caption mm-danger-text">{aiError}</div> : null}

      <div className="mm-btn-row derivation-panel-actions">
        {onAiGenerate ? (
          <button type="button" className="mm-btn" onClick={onAiGenerate} disabled={aiBusy || saving}>
            AI 生成
          </button>
        ) : null}
        <button
          type="button"
          className="mm-btn mm-btn--primary"
          disabled={saving}
          onClick={() =>
            onSave({
              mode,
              text,
              mermaid,
              ...(rootLabel.trim() ? { rootLabel: rootLabel.trim() } : {}),
              ...(content.source ? { source: content.source } : {}),
            })
          }
        >
          保存
        </button>
      </div>
      <div className="mm-caption">AI 结果先预览，点保存才写入；失败不会自动保存。</div>
    </aside>
  )
}
