import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Dialog } from '../../components/Dialog'
import { registerNativeBack } from '../lib/native-back'
import { MarkdownText } from './DerivationMarkdown'
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
  /** F9：右页全屏态（隐藏左栏） */
  fullscreen?: boolean
  onToggleFullscreen?: () => void
  /** task-157：受控模式（AI 生成后不自动切换） */
  mode?: 'text' | 'mermaid'
  onModeChange?: (mode: 'text' | 'mermaid') => void
  /** F10：文字模式 Markdown 渲染（设置 derivation.markdown，默认开） */
  markdown?: boolean
  /** A5：用法弹层开合（用于隐藏拖拽手柄） */
  onUsageOpenChange?: (open: boolean) => void
  /** task-183：Mermaid 全屏查看器开合（用于隐藏拖拽手柄） */
  onViewerOpenChange?: (open: boolean) => void
  /** A10：当前 w 的 nc 中文列表（右页文字底部） */
  ncLabels?: string[]
  /** A11：当前词引申图 JSON 导出/导入 */
  onExportJson?: () => void
  onImportJson?: (text: string) => void
}

/** 文本内容：生成元 → 场景/对象/词性 → 含义，完整换行；
 *  markdown=true 时按安全子集渲染，false 回退纯文本 pre-wrap（F10）。 */
export function DerivationTextView({ text, markdown = false }: { text: string; markdown?: boolean }) {
  if (markdown) return <MarkdownText text={text} />
  return <pre className="derivation-map-text">{text}</pre>
}

let mermaidSeq = 0

/** Mermaid 预览：按需动态加载（不进入首屏）；失败回退源码，不阻塞 */
export function MermaidPreview({
  source,
  onViewerOpenChange,
}: {
  source: string
  onViewerOpenChange?: (open: boolean) => void
}) {
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)
  const setViewer = (next: boolean) => {
    setExpanded(next)
    onViewerOpenChange?.(next)
  }
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

  if (!source.trim()) {
    return (
      <div className="mm-caption derivation-mermaid-empty">
        尚无 Mermaid 内容：点「编辑」或「AI 生成」
      </div>
    )
  }
  if (svg) {
    return (
      <>
        <div className="derivation-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
        <button type="button" className="mm-btn mm-btn--sm" onClick={() => setViewer(true)}>
          全屏查看
        </button>
        {expanded ? (
          <MermaidZoomViewer
            svg={svg}
            onClose={() => setViewer(false)}
          />
        ) : null}
      </>
    )
  }
  return (
    <div className="derivation-mermaid-fallback">
      <pre className="derivation-map-text">{source}</pre>
      {error ? <div className="mm-caption mm-danger-text">Mermaid 渲染失败：{error}（已显示源码）</div> : null}
    </div>
  )
}

export const DERIVATION_USAGE_PARAGRAPHS = [
  '平时可多去直接把那个统一的生成元直接作为含义代入各个实际含义的例句中，体会仅依靠这个生成元作为该单词的含义来理解和翻译整句话的意思，看看是否能体会出这句话的真实意思、这个生成元的真实指代，体会这个生成元是如何实例化到该场景下的具体指代事物的。',
  '平时，如果生成元忘记了，我们也可以通过先根据相关记忆、它的已知道的一些含义来回忆起其生成元，进而再通过生成元来引申、回忆其它各实际含义。',
  '推荐记忆工作流：记忆单词到生成元的映射 → 理解生成元如何引申各个实际含义 → 代入生成元到各个含义的例句，看看是否可以理解各个含义的例句中该生成元的真实指代，找出那些不容易理解出真实指代的含义（记为 nc） → 记忆「通过生成元来得到各个实际含义（可只考虑那些 nc）」的关系网络（或者说使得可以仅通过生成元回忆起那些含义/nc）。',
] as const

export const DERIVATION_USAGE_TEXT = DERIVATION_USAGE_PARAGRAPHS[0]

/** 「用法」弹层：可滚动、可关闭、完整换行 */
export function DerivationUsageDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return (
    <Dialog
      open={open}
      title="用法：把生成元代入例句"
      onClose={onClose}
      actions={
        <button type="button" className="mm-btn mm-btn--primary" onClick={onClose}>
          知道了
        </button>
      }
    >
      <div className="derivation-usage-body">
        {DERIVATION_USAGE_PARAGRAPHS.map((paragraph, index) => (
          <p className="derivation-usage-text" key={index}>
            {paragraph}
          </p>
        ))}
      </div>
    </Dialog>
  )
}

/** F9：缩放范围 0.5–4× */
export const MERMAID_MIN_SCALE = 0.5
export const MERMAID_MAX_SCALE = 4

export function clampMermaidScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.min(MERMAID_MAX_SCALE, Math.max(MERMAID_MIN_SCALE, value))
}

/** 双击缩放：1× ↔ 2×（其他比例先回 1× 再进入 2×） */
export function nextDoubleTapScale(current: number): number {
  return Math.abs(current - 1) < 0.05 ? 2 : 1
}

/** Mermaid 全屏查看器：双指缩放/单指平移/双击 1×↔2×/重置/关闭 */
export function MermaidZoomViewer({ svg, onClose }: { svg: string; onClose: () => void }) {
  // A4：打开时压入一条历史记录，手机返回键只关闭查看器，不回到首页
  useEffect(() => {
    const marker = { ...(history.state ?? {}), mmMermaidViewer: true }
    history.pushState(marker, '')
    const onPop = () => onClose()
    window.addEventListener('popstate', onPop)
    // task-172：APK 硬件返回键桥（同步消费，避免 popstate 在 WebView 不生效）
    const unregisterNative = registerNativeBack(() => {
      onClose()
      return true
    })
    return () => {
      unregisterNative()
      window.removeEventListener('popstate', onPop)
      if (history.state && (history.state as { mmMermaidViewer?: boolean }).mmMermaidViewer) {
        history.back()
      }
    }
  }, [onClose])

  const [scale, setScale] = useState(1)
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<
    | null
    | { mode: 'pan'; posX: number; posY: number; startX: number; startY: number }
    | { mode: 'pinch'; scale: number; dist: number }
  >(null)
  const live = useRef({ scale: 1, x: 0, y: 0 })
  live.current = { scale, x: pos.x, y: pos.y }

  const reset = () => {
    setScale(1)
    setPos({ x: 0, y: 0 })
  }

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 1) {
      gesture.current = {
        mode: 'pan',
        posX: live.current.x,
        posY: live.current.y,
        startX: event.clientX,
        startY: event.clientY,
      }
    } else {
      const [a, b] = [...pointers.current.values()]
      gesture.current = {
        mode: 'pinch',
        scale: live.current.scale,
        dist: Math.hypot(a!.x - b!.x, a!.y - b!.y) || 1,
      }
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    const g = gesture.current
    if (!g) return
    if (pointers.current.size >= 2 && g.mode === 'pinch') {
      const [a, b] = [...pointers.current.values()]
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y)
      if (dist > 0) setScale(clampMermaidScale(g.scale * (dist / g.dist)))
    } else if (pointers.current.size === 1 && g.mode === 'pan') {
      setPos({
        x: g.posX + (event.clientX - g.startX),
        y: g.posY + (event.clientY - g.startY),
      })
    }
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId)
    const first = [...pointers.current.values()][0]
    if (!first) {
      gesture.current = null
    } else {
      gesture.current = {
        mode: 'pan',
        posX: live.current.x,
        posY: live.current.y,
        startX: first.x,
        startY: first.y,
      }
    }
  }

  return (
    <div className="mermaid-viewer" role="dialog" aria-label="思维导图全屏">
      <div className="mermaid-viewer-head">
        <span className="mm-row-title">思维导图</span>
        <span className="mm-caption">{Math.round(scale * 100)}%</span>
        <button type="button" className="mm-btn mm-btn--sm" onClick={reset}>
          重置
        </button>
        <button type="button" className="mm-btn mm-btn--sm" onClick={onClose}>
          关闭
        </button>
      </div>
      <div
        className="mermaid-viewer-canvas"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={() => {
          const next = nextDoubleTapScale(scale)
          setScale(next)
          setPos({ x: 0, y: 0 })
        }}
      >
        <div
          className="mermaid-viewer-content"
          style={{ transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})` }}
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
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
  fullscreen = false,
  onToggleFullscreen,
  mode: controlledMode,
  onModeChange,
  markdown = false,
  onUsageOpenChange,
  onViewerOpenChange,
  ncLabels = [],
  onExportJson,
  onImportJson,
}: DerivationPanelProps) {
  const [innerMode, setInnerMode] = useState(content.mode)
  const mode = controlledMode ?? innerMode
  const setMode = (next: 'text' | 'mermaid') => {
    setInnerMode(next)
    onModeChange?.(next)
  }
  const [text, setText] = useState(content.text)
  const [mermaid, setMermaid] = useState(content.mermaid)
  const [editing, setEditing] = useState(false)
  const [rootLabel, setRootLabel] = useState(content.rootLabel ?? '')
  const [usageOpen, setUsageOpen] = useState(false)
  const setUsage = (next: boolean) => {
    setUsageOpen(next)
    onUsageOpenChange?.(next)
  }

  useEffect(() => {
    if (!controlledMode) setInnerMode(content.mode)
    setText(content.text)
    setMermaid(content.mermaid)
    setRootLabel(content.rootLabel ?? '')
    setEditing(false)
  }, [content.mode, content.text, content.mermaid, content.rootLabel, headword, controlledMode])

  if (!open) return null
  const source = mode === 'mermaid' ? mermaid : text

  return (
    <aside className="derivation-panel" aria-label={`${headword} 生成元引申`}>
      <div className="derivation-panel-head">
        <span className="mm-row-title">生成元 → 含义</span>
        {onToggleFullscreen ? (
          <button type="button" className="mm-btn mm-btn--sm" onClick={onToggleFullscreen}>
            {fullscreen ? '退出全屏' : '全屏'}
          </button>
        ) : null}
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
        <MermaidPreview source={mermaid} onViewerOpenChange={onViewerOpenChange} />
      ) : text.trim() ? (
        <DerivationTextView text={text} markdown={markdown} />
      ) : (
        <div className="mm-caption derivation-mermaid-empty">
          尚无文字内容：点「编辑」或「AI 生成」
        </div>
      )}

      {ncLabels.length > 0 ? (
        <div className="derivation-nc-list">
          <span className="mm-caption">nc（不易理解真实指代的含义）：</span>
          {ncLabels.map((label) => (
            <span className="mm-badge nc-badge" key={label}>
              {label}
            </span>
          ))}
        </div>
      ) : null}

      {onExportJson || onImportJson ? (
        <div className="mm-btn-row">
          {onExportJson ? (
            <button type="button" className="mm-btn mm-btn--sm" onClick={onExportJson}>
              导出 JSON
            </button>
          ) : null}
          {onImportJson ? (
            <label className="mm-btn mm-btn--sm derivation-json-import">
              导入 JSON
              <input
                type="file"
                accept="application/json,.json"
                aria-label="导入当前词引申图 JSON"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (!file) return
                  void file.text().then((text) => onImportJson(text))
                }}
              />
            </label>
          ) : null}
        </div>
      ) : null}

      {aiBusy ? <div className="mm-caption">正在生成引申图…</div> : null}
      {aiError ? <div className="mm-caption mm-danger-text">{aiError}</div> : null}

      <div className="mm-btn-row derivation-panel-actions">
        <button type="button" className="mm-btn" onClick={() => setUsage(true)}>
          用法
        </button>
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
              ...(content.lines?.length ? { lines: content.lines } : {}),
              ...(content.source ? { source: content.source } : {}),
            })
          }
        >
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
      <div className="mm-caption">AI 结果先预览，点保存才写入；失败不会自动保存。</div>
      <DerivationUsageDialog open={usageOpen} onClose={() => setUsage(false)} />
    </aside>
  )
}
