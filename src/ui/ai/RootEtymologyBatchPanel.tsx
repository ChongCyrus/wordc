import { useEffect, useState } from 'react'
import {
  applyRootEtymologyResults,
  generateRootEtymologyBatch,
  getEffectiveContent,
  getRootEtymologyCandidates,
  loadAiConfig,
  toRootEtymologyPromptSource,
} from '../../data'
type RootEtymologyPromptSource = ReturnType<typeof toRootEtymologyPromptSource>
import { useToast } from '../../app/toast'
import { Dialog } from '../components/Dialog'
import { Stepper } from '../components/Stepper'

interface PreviewItem {
  wordId: string
  headword: string
  parts: Array<{ type: string; text: string; meaning: string }>
  etymology?: string
  composition?: string
  error?: string
  empty?: boolean
}

const TYPE_LABEL: Record<string, string> = {
  prefix: '前缀',
  root: '词根',
  suffix: '后缀',
  other: '其他',
}

/** task-283：批量生成词根词缀词源（选中/词库/筛选，预览后应用） */
export function RootEtymologyBatchPanel({
  open,
  onClose,
  selectedWordIds,
  currentDeckId,
}: {
  open: boolean
  onClose: () => void
  selectedWordIds?: string[]
  currentDeckId?: string
}) {
  const toast = useToast()
  const [source, setSource] = useState<'selected' | 'deck' | 'filtered'>(
    selectedWordIds && selectedWordIds.length > 0 ? 'selected' : 'deck',
  )
  const [status, setStatus] = useState<'unchecked' | 'checked' | 'all'>('unchecked')
  const [batchSize, setBatchSize] = useState(100)
  const [concurrency, setConcurrency] = useState(2)
  const [sources, setSources] = useState<RootEtymologyPromptSource[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [items, setItems] = useState<PreviewItem[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setItems([])
    setProgress({ done: 0, total: 0 })
    void (async () => {
      try {
        const result = await getRootEtymologyCandidates({
          source,
          ...(source === 'selected' ? { wordIds: selectedWordIds ?? [] } : {}),
          ...(currentDeckId ? { deckId: currentDeckId } : {}),
          status,
          limit: batchSize,
        })
        const list: RootEtymologyPromptSource[] = []
        for (const candidate of result.words) {
          const effective = await getEffectiveContent(candidate.word.id).catch(() => null)
          list.push(
            toRootEtymologyPromptSource(
              { ...candidate.word, meanings: candidate.word.meanings },
              effective?.coreSenses ?? [],
            ),
          )
        }
        if (!alive) return
        setSources(list)
        setTotal(result.total)
      } catch (error) {
        if (alive) toast.error(error instanceof Error ? error.message : '读取候选失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, source, selectedWordIds, currentDeckId, status, batchSize, toast])

  const run = async () => {
    setRunning(true)
    try {
      const config = await loadAiConfig()
      if (!config.apiKey) throw new Error('未配置 AI Key')
      const result = await generateRootEtymologyBatch(sources, config, {
        concurrency,
        onProgress: (value) => setProgress({ done: value.done, total: value.total }),
      })
      const next: PreviewItem[] = result.results.map((entry) => {
        const word = sources.find((item) => item.wordId === entry.source.wordId)
        return {
          wordId: entry.source.wordId,
          headword: entry.source.headword,
          parts: (entry.draft?.parts ?? []).map((part) => ({
            type: part.type,
            text: part.text,
            meaning: part.meaning,
          })),
          ...(entry.draft?.etymology ? { etymology: entry.draft.etymology } : {}),
          ...(entry.draft?.composition ? { composition: entry.draft.composition } : {}),
          ...(entry.error ? { error: entry.error } : {}),
          ...(entry.empty ? { empty: true } : {}),
          ...(word ? {} : {}),
        }
      })
      setItems(next)
      setSelected(next.filter((item) => !item.error).map((item) => item.wordId))
      toast.success(
        `生成完成：${next.filter((item) => !item.error).length} 词${result.failed > 0 ? ` / 失败 ${result.failed}` : ''}`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '批量生成失败')
    } finally {
      setRunning(false)
    }
  }

  const apply = async () => {
    setApplying(true)
    try {
      const result = await applyRootEtymologyResults(
        items
          .filter((item) => selected.includes(item.wordId) && !item.error)
          .map((item) => ({
            wordId: item.wordId,
            parts: item.parts.map((part) => ({ ...part, type: part.type as never })),
            ...(item.etymology ? { etymology: item.etymology } : {}),
            ...(item.composition ? { composition: item.composition } : {}),
          })),
      )
      toast.success(
        `已应用：检查 ${result.checked} / 保存 ${result.saved} / 跳过手动 ${result.skippedManual}${
          result.failed.length > 0 ? ` / 失败 ${result.failed.length}` : ''
        }`,
      )
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '应用失败')
    } finally {
      setApplying(false)
    }
  }

  if (!open) return null

  return (
    <div className="batch-derivation" role="dialog" aria-label="批量生成词根词缀词源">
      <div className="generative-head">
        <span className="mm-row-title">批量生成词根词缀词源</span>
        <button type="button" className="mm-btn mm-btn--sm" onClick={onClose} disabled={running}>
          关闭
        </button>
      </div>
      <div className="generative-scroll">
        <div className="mm-btn-row">
          {(
            [
              ['selected', `已选 ${selectedWordIds?.length ?? 0} 词`],
              ['deck', '当前词库'],
              ['filtered', '当前筛选'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`mm-btn mm-btn--sm${source === value ? ' mm-btn--primary' : ''}`}
              disabled={running}
              onClick={() => setSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mm-btn-row">
          <select className="mm-input" aria-label="检查状态" value={status} onChange={(event) => setStatus(event.target.value as 'unchecked' | 'checked' | 'all')}>
            <option value="unchecked">仅未检查</option>
            <option value="checked">已检查</option>
            <option value="all">全部</option>
          </select>
          <select className="mm-input" aria-label="批次大小" value={batchSize} onChange={(event) => setBatchSize(Number(event.target.value))}>
            <option value={50}>50 / 批</option>
            <option value={100}>100 / 批</option>
            <option value={200}>200 / 批</option>
            <option value={500}>500 / 批</option>
          </select>
          <span className="mm-caption">筛选 {total} 词 · 本批 {sources.length}</span>
        </div>
        <div className="mm-row">
          <span className="mm-row-title">并发数</span>
          <Stepper ariaLabel="词根词源并发数" value={concurrency} min={1} max={4} onChange={setConcurrency} />
        </div>
        <button
          type="button"
          className="mm-btn mm-btn--primary"
          disabled={running || loading || sources.length === 0}
          onClick={() => setConfirmOpen(true)}
        >
          {running ? `生成中 ${progress.done}/${progress.total}` : '开始批量生成'}
        </button>
        {items.map((item) => (
          <div className="mm-row" key={item.wordId}>
            <span className="mm-row-main">
              <span className="mm-row-title">{item.headword}</span>
              {item.error ? (
                <span className="mm-row-sub mm-danger-text">失败：{item.error}</span>
              ) : item.parts.length === 0 ? (
                <span className="mm-row-sub">{item.etymology ?? '无法可靠确认（空结果）'}</span>
              ) : (
                <span className="mm-row-sub">
                  {item.parts.map((part, index) => (
                    <span key={`${part.type}-${index}`}>
                      {index > 0 ? ' + ' : ''}
                      {TYPE_LABEL[part.type] ?? part.type} {part.text}·{part.meaning}
                    </span>
                  ))}
                </span>
              )}
              {item.composition ? <span className="mm-row-sub">组合：{item.composition}</span> : null}
            </span>
            {!item.error ? (
              <input
                type="checkbox"
                aria-label={`应用 ${item.headword} 的词源`}
                checked={selected.includes(item.wordId)}
                onChange={(event) =>
                  setSelected((prev) =>
                    event.target.checked ? [...prev, item.wordId] : prev.filter((id) => id !== item.wordId),
                  )
                }
              />
            ) : null}
          </div>
        ))}
        {items.length > 0 ? (
          <button type="button" className="mm-btn mm-btn--primary" disabled={applying || selected.length === 0} onClick={() => void apply()}>
            {applying ? '应用中…' : `应用所选（${selected.length}）`}
          </button>
        ) : null}
      </div>
      <Dialog
        open={confirmOpen}
        title="确认批量生成词根词源"
        onClose={() => setConfirmOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setConfirmOpen(false)}>取消</button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => {
                setConfirmOpen(false)
                void run()
              }}
            >
              确认开始
            </button>
          </>
        }
      >
        <div className="mm-caption">
          本批 {sources.length} 词 · 并发 {concurrency} · 来源 {source}。AI 调用会产生费用，结果先预览，勾选后应用。
        </div>
      </Dialog>
    </div>
  )
}
