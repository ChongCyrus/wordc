import { useEffect, useRef, useState } from 'react'
import { Stepper } from '../../components/Stepper'
import { useToast } from '../../../app/toast'
import { aiErrorMessage } from '../../../app/hooks/aiUi'
import {
  applySenseMnemonicSuggestions,
  collectSenseMnemonicSources,
  generateSenseMnemonicBatch,
  loadAiConfig,
  type SenseMnemonicApplyResult,
  type SenseMnemonicSource,
  type SenseMnemonicSuggestion,
} from '../../../data'

interface PreviewEntry {
  key: string
  wordId: string
  word: string
  coreSenseIndex: number
  label: string
  text: string
}

/** task-200：批量生成「w→本义」助记（当前词/今日/词库≤200，进度/停止/重试/预览勾选应用） */
export function SenseMnemonicBatchPanel({
  open,
  onClose,
  currentWordId,
  onApplied,
}: {
  open: boolean
  onClose: () => void
  currentWordId?: string
  onApplied?: () => void
}) {
  const toast = useToast()
  const [scope, setScope] = useState<'word' | 'today' | 'deck'>('today')
  const [sources, setSources] = useState<SenseMnemonicSource[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [overwriteAi, setOverwriteAi] = useState(false)
  const [concurrency, setConcurrency] = useState(2)
  const [progress, setProgress] = useState({ done: 0, total: 0, succeeded: 0, failed: 0, inFlight: 0 })
  const [preview, setPreview] = useState<PreviewEntry[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [failed, setFailed] = useState<Array<{ wordId: string; word: string; coreSenseIndex: number; label: string; error: string }>>([])
  const [applySummary, setApplySummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const tokenRef = useRef(0)
  const stopRequestedRef = useRef(false)
  const failedSourcesRef = useRef<SenseMnemonicSource[]>([])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setPreview([])
    setSelected([])
    setFailed([])
    setApplySummary(null)
    setError(null)
    setProgress({ done: 0, total: 0, succeeded: 0, failed: 0, inFlight: 0 })
    void collectSenseMnemonicSources(
      scope === 'word'
        ? { scope: 'word', wordId: currentWordId ?? '' }
        : scope === 'today'
          ? { scope: 'today' }
          : { scope: 'deck' },
      { limit: 200, includeExisting: overwriteAi },
    )
      .then((list) => {
        if (!alive) return
        setSources(list)
        setProgress({ done: 0, total: list.length, succeeded: 0, failed: 0, inFlight: 0 })
      })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : '读取候选失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [open, scope, currentWordId, overwriteAi])

  if (!open) return null

  const run = async (list = sources, retry = false) => {
    if (list.length === 0) {
      setError('没有可生成的本义助记候选')
      return
    }
    const token = tokenRef.current + 1
    tokenRef.current = token
    stopRequestedRef.current = false
    setRunning(true)
    setError(null)
    setApplySummary(null)
    if (!retry) {
      setPreview([])
      setSelected([])
      setFailed([])
    }
    setProgress({ done: 0, total: list.length, succeeded: 0, failed: 0, inFlight: 0 })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const config = await loadAiConfig()
      if (!config.apiKey) throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
      const result = await generateSenseMnemonicBatch(list, config, {
        concurrency,
        timeoutMs: 30_000,
        retryTimeoutOnce: true,
        signal: controller.signal,
        onProgress: (p) => {
          if (token !== tokenRef.current) return
          setProgress({
            done: p.done,
            total: p.total,
            succeeded: p.succeeded,
            failed: p.failed,
            inFlight: p.inFlight,
          })
        },
      })
      if (token !== tokenRef.current) return
      const nextPreview: PreviewEntry[] = []
      const nextFailed: typeof failed = []
      for (const entry of result.results) {
        const source = entry.source
        const wordId = source.wordId ?? ''
        const coreSenseIndex = source.coreSenseIndex ?? 0
        if (entry.error || entry.errorKind === 'canceled') {
          if (entry.errorKind !== 'canceled') {
            nextFailed.push({
              wordId,
              word: source.word,
              coreSenseIndex,
              label: source.label,
              error: entry.error ?? '生成失败',
            })
          }
          continue
        }
        if (!entry.mnemonic || !wordId || !coreSenseIndex) continue
        nextPreview.push({
          key: `${wordId}#${coreSenseIndex}#${source.label}`,
          wordId,
          word: source.word,
          coreSenseIndex,
          label: source.label,
          text: entry.mnemonic,
        })
      }
      setPreview((prev) => {
        const merged = retry
          ? [...prev.filter((item) => !nextPreview.some((next) => next.key === item.key)), ...nextPreview]
          : nextPreview
        return merged
      })
      setFailed(nextFailed)
      setSelected(nextPreview.map((item) => item.key))
      failedSourcesRef.current = list.filter((source) =>
        nextFailed.some(
          (failure) =>
            failure.wordId === (source.wordId ?? '') &&
            failure.coreSenseIndex === (source.coreSenseIndex ?? 0),
        ),
      )
      setProgress({ done: list.length, total: list.length, succeeded: nextPreview.length, failed: nextFailed.length, inFlight: 0 })
      if (result.canceled) {
        toast.error('已停止；已完成结果保留，可重试失败')
      } else if (nextFailed.length > 0) {
        toast.error(`完成：${nextPreview.length} 成功 / ${nextFailed.length} 失败`)
      } else if (nextPreview.length === 0) {
        setError('没有生成可应用的结果')
      } else {
        toast.success(`完成：${nextPreview.length} 条本义助记预览${result.retried > 0 ? `（自动重试 ${result.retried} 次）` : ''}`)
      }
    } catch (err) {
      if (token === tokenRef.current) setError(aiErrorMessage((err as { code?: string })?.code, '批量生成本义助记失败'))
    } finally {
      if (token === tokenRef.current) {
        setRunning(false)
        abortRef.current = null
      }
    }
  }

  const stop = () => {
    if (!running) return
    stopRequestedRef.current = true
    abortRef.current?.abort()
    setRunning(false)
    setProgress((prev) => ({ ...prev, inFlight: 0 }))
    toast.error('已停止；已完成结果保留，可重试失败')
  }

  const apply = () => {
    void (async () => {
      const groups = new Map<string, SenseMnemonicSuggestion[]>()
      for (const entry of preview) {
        if (!selected.includes(entry.key)) continue
        const list = groups.get(entry.wordId) ?? []
        list.push({ coreSenseIndex: entry.coreSenseIndex, label: entry.label, text: entry.text })
        groups.set(entry.wordId, list)
      }
      if (groups.size === 0) return
      setRunning(true)
      try {
        const total: SenseMnemonicApplyResult = { applied: 0, skippedManual: 0, skippedExisting: 0, stale: 0 }
        for (const [wordId, suggestions] of groups) {
          const result = await applySenseMnemonicSuggestions(wordId, suggestions, { overwriteAi })
          total.applied += result.applied
          total.skippedManual += result.skippedManual
          total.skippedExisting += result.skippedExisting
          total.stale += result.stale
        }
        setApplySummary(
          `已应用 ${total.applied} · 跳过手改 ${total.skippedManual} · 跳过已有 AI ${total.skippedExisting} · 本义已变化 ${total.stale}`,
        )
        onApplied?.()
      } catch (err) {
        setError(err instanceof Error ? err.message : '应用失败')
      } finally {
        setRunning(false)
      }
    })()
  }

  return (
    <div className="batch-derivation" role="dialog" aria-label="批量生成本义助记">
      <div className="generative-head">
        <span className="mm-row-title">批量生成本义助记</span>
        <button type="button" className="mm-btn mm-btn--sm" onClick={onClose} disabled={running}>
          关闭
        </button>
      </div>
      <div className="generative-scroll">
        <div className="mm-btn-row">
          {(
            [
              ['word', '当前词'],
              ['today', '今日计划'],
              ['deck', '当前词库'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`mm-btn${scope === value ? ' mm-btn--primary' : ''}`}
              disabled={running}
              onClick={() => setScope(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="mm-caption" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="checkbox"
            checked={overwriteAi}
            onChange={(event) => setOverwriteAi(event.target.checked)}
            disabled={running}
          />
          覆盖已有 AI 助记（手改永不覆盖；默认只补缺失）
        </label>
        <div className="mm-caption">
          {loading ? '正在读取候选…' : `共 ${sources.length} 条本义候选${scope === 'deck' ? '（最多 200 词）' : ''}`}
        </div>
        <div className="mm-row">
          <span className="mm-row-title">并发数</span>
          <Stepper ariaLabel="批量本义助记并发数" value={concurrency} min={1} max={4} onChange={setConcurrency} />
        </div>
        {running || progress.done > 0 ? (
          <>
            <div className="mm-progress">
              <div
                className="mm-progress-fill"
                style={{ width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
              />
            </div>
            <div className="mm-caption">
              进行中 {progress.done} / {progress.total}（成功 {progress.succeeded} · 失败 {progress.failed} · 当前 {progress.inFlight}）
              {running ? (
                <button type="button" className="mm-btn mm-btn--sm" onClick={stop}>
                  停止
                </button>
              ) : null}
            </div>
          </>
        ) : null}
        <div className="mm-btn-row">
          <button type="button" className="mm-btn mm-btn--primary" disabled={running || sources.length === 0} onClick={() => void run()}>
            {running ? '生成中…' : `开始生成（${sources.length} 条）`}
          </button>
          {failed.length > 0 ? (
            <button type="button" className="mm-btn" disabled={running} onClick={() => void run(failedSourcesRef.current, true)}>
              重试失败（{failed.length}）
            </button>
          ) : null}
        </div>
        {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
        {preview.map((entry) => (
          <label className="mm-row" key={entry.key}>
            <span className="mm-row-main">
              <span className="mm-row-title">
                {entry.word} · 本义{entry.coreSenseIndex}「{entry.label}」
              </span>
              <span className="mm-row-sub">{entry.text}</span>
            </span>
            <input
              type="checkbox"
              aria-label={`应用 ${entry.word} 本义${entry.coreSenseIndex} 的助记`}
              checked={selected.includes(entry.key)}
              onChange={(event) =>
                setSelected((prev) =>
                  event.target.checked ? [...prev, entry.key] : prev.filter((key) => key !== entry.key),
                )
              }
            />
          </label>
        ))}
        {failed.map((failure) => (
          <div className="mm-caption mm-danger-text" key={`${failure.wordId}-${failure.coreSenseIndex}`}>
            {failure.word} 本义{failure.coreSenseIndex}「{failure.label}」：{failure.error}
          </div>
        ))}
        <button type="button" className="mm-btn mm-btn--primary" disabled={running || selected.length === 0} onClick={apply}>
          应用已选（{selected.length}）
        </button>
        {applySummary ? <div className="mm-caption">{applySummary}</div> : null}
      </div>
    </div>
  )
}
