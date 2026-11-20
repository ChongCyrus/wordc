import { useEffect, useMemo, useRef, useState } from 'react'
import { Dialog } from '../components/Dialog'
import { Switch } from '../components/Switch'
import { Stepper } from '../components/Stepper'
import { useToast } from '../../app/toast'
import { loadAiConfig, saveDerivationMap } from '../../data'
import {
  generateDerivationMapsBatch,
  listDerivationBatchCandidates,
  type DerivationBatchCandidate,
} from '../../data/ai'
import { useDecks } from '../../app/hooks/useDecks'
import {
  isBatchStalled,
  summarizeStuckRun,
  type BatchFailureView,
} from './batch-run'

export interface BatchCandidateView {
  wordId: string
  deckId: string
  headword: string
  word: string
  meanings: unknown[]
  hasDerivationMap: boolean
}

/** 纯函数：关键词过滤（大小写不敏感、前缀优先） */
export function filterBatchCandidates<T extends { headword: string }>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  const prefix: T[] = []
  const rest: T[] = []
  for (const item of items) {
    const lower = item.headword.toLowerCase()
    if (lower.startsWith(q)) prefix.push(item)
    else if (lower.includes(q)) rest.push(item)
  }
  return [...prefix, ...rest]
}

/** 生成摘要文案 */
export function batchSummaryText(result: {
  total: number
  succeeded: number
  failed: number
  skipped: number
}): string {
  return `成功 ${result.succeeded} / 失败 ${result.failed} / 跳过 ${result.skipped}（共 ${result.total}）`
}

export function BatchDerivationPanel({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const toast = useToast()
  const { decks } = useDecks()
  const [scope, setScope] = useState<'deck' | 'today'>('today')
  const [deckId, setDeckId] = useState('')
  const [query, setQuery] = useState('')
  const [excludeGenerated, setExcludeGenerated] = useState(true)
  const [concurrency, setConcurrency] = useState(2)
  const [candidates, setCandidates] = useState<BatchCandidateView[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [autoRetry, setAutoRetry] = useState<{ current: number; total: number } | null>(null)
  const [inFlight, setInFlight] = useState(0)
  const [runHint, setRunHint] = useState<string | null>(null)
  const [progress, setProgress] = useState({
    done: 0,
    total: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  })
  const [summary, setSummary] = useState<{
    total: number
    succeeded: number
    failed: number
    skipped: number
    failures: BatchFailureView[]
    retried?: number
  } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const runTokenRef = useRef(0)
  const succeededIdsRef = useRef(new Set<string>())
  const lastProgressAtRef = useRef(0)
  const currentItemsRef = useRef<BatchCandidateView[]>([])

  const selectedSet = useMemo(() => new Set(selected), [selected])
  const filtered = useMemo(() => filterBatchCandidates(candidates, query), [candidates, query])
  const selectedCandidates = useMemo(
    () => candidates.filter((item) => selectedSet.has(item.wordId)),
    [candidates, selectedSet],
  )

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setSummary(null)
    void listDerivationBatchCandidates({
      ...(scope === 'today' ? { today: true } : deckId ? { deckId } : {}),
      includeGenerated: !excludeGenerated,
      limit: 200,
    })
      .then((page) => {
        if (!alive) return
        const items = page.items.map((item: DerivationBatchCandidate) => ({
          wordId: item.wordId,
          deckId: item.deckId,
          headword: item.word,
          word: item.word,
          meanings: item.meanings,
          hasDerivationMap: item.hasDerivationMap,
        }))
        setCandidates(items)
        setSelected(items.map((item) => item.wordId))
      })
      .catch((error) => {
        if (alive) toast.error(error instanceof Error ? error.message : '读取候选失败')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope, deckId, excludeGenerated])

  if (!open) return null

  const finishInterrupted = (
    items: BatchCandidateView[],
    message: string,
  ) => {
    const result = summarizeStuckRun({
      items: items.map((item) => ({ wordId: item.wordId, headword: item.headword })),
      succeededIds: succeededIdsRef.current,
      skipped: progress.skipped,
      message,
    })
    setSummary(result)
    setProgress((prev) => ({
      ...prev,
      done: prev.total,
      succeeded: result.succeeded,
      failed: result.failed,
      skipped: result.skipped,
    }))
    toast.error(message)
  }

  const executeBatch = async (
    items: BatchCandidateView[],
    controller: AbortController,
    display: { baseDone: number; baseSucceeded: number; total: number },
  ): Promise<
    | { kind: 'stalled' }
    | {
        kind: 'result'
        result: Awaited<ReturnType<typeof generateDerivationMapsBatch>>
      }
  > => {
    const token = runTokenRef.current
    lastProgressAtRef.current = Date.now()
    let resolveStalled: (() => void) | null = null
    const stalled = new Promise<'stalled'>((resolve) => {
      resolveStalled = () => resolve('stalled')
    })
    const timer = window.setInterval(() => {
      if (token !== runTokenRef.current) return
      if (isBatchStalled(lastProgressAtRef.current, Date.now())) {
        controller.abort()
        resolveStalled?.()
      }
    }, 5000)
    try {
      const config = await loadAiConfig()
      if (!config.apiKey) throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
      const byId = new Map(items.map((item) => [item.wordId, item]))
      const batchPromise = generateDerivationMapsBatch(
        items.map((item) => ({
          wordId: item.wordId,
          deckId: item.deckId,
          word: item.word,
          meanings: item.meanings as never,
        })),
        config,
        {
          concurrency,
          signal: controller.signal,
          onProgress: (p: {
            done: number
            total: number
            succeeded: number
            failed: number
            skipped: number
            phase?: 'main' | 'retry'
            retryDone?: number
            retryTotal?: number
            inFlight?: number
          }) => {
            if (token !== runTokenRef.current) return
            lastProgressAtRef.current = Date.now()
            setProgress({
              done: display.baseDone + p.done,
              total: display.total,
              succeeded: display.baseSucceeded + p.succeeded,
              failed: p.failed,
              skipped: p.skipped,
            })
            setInFlight(p.inFlight ?? 0)
            if (p.phase === 'retry') {
              setAutoRetry({ current: p.retryDone ?? 0, total: p.retryTotal ?? 0 })
            }
          },
          onSaved: async (wordId: string, item: unknown) => {
            const candidate = byId.get(wordId)
            if (!candidate) return
            const draft = item as {
              rootLabel?: string
              text?: string
              mermaid?: string
              lines?: Array<{ text: string; meaningIndexes: number[] }>
            }
            await saveDerivationMap(wordId, {
              ...(draft.rootLabel ? { rootLabel: draft.rootLabel } : {}),
              text: draft.text ?? '',
              mermaid: draft.mermaid ?? '',
              ...(draft.lines ? { lines: draft.lines } : {}),
              source: 'ai',
            })
            succeededIdsRef.current.add(wordId)
          },
        },
      )
      const raced = await Promise.race([batchPromise, stalled])
      if (raced === 'stalled') return { kind: 'stalled' }
      return { kind: 'result', result: raced }
    } finally {
      window.clearInterval(timer)
    }
  }

  const run = (items: BatchCandidateView[]) => {
    if (items.length === 0) {
      toast.error('请选择要生成的词')
      return
    }
    const token = runTokenRef.current + 1
    runTokenRef.current = token
    currentItemsRef.current = items
    setConfirmOpen(false)
    setRunning(true)
    setSummary(null)
    setAutoRetry(null)
    setRunHint(null)
    setProgress({ done: 0, total: items.length, succeeded: 0, failed: 0, skipped: 0 })
    succeededIdsRef.current = new Set()
    const controller = new AbortController()
    abortRef.current = controller
    void (async () => {
      try {
        const byId = new Map(items.map((item) => [item.wordId, item]))
        const first = await executeBatch(items, controller, {
          baseDone: 0,
          baseSucceeded: 0,
          total: items.length,
        })
        if (token !== runTokenRef.current) return
        if (first.kind === 'stalled') {
          finishInterrupted(items, '部分 AI 请求超时未返回，已停止；可重试失败项')
          return
        }
        let result = first.result
        let failures = result.failed.map((failure: { wordId: string; message: string }) => ({
          wordId: failure.wordId,
          headword: byId.get(failure.wordId)?.headword ?? failure.wordId,
          message: failure.message,
        }))
        const timeoutCount = result.failed.filter(
          (failure: { code?: string }) => failure.code === 'AI_TIMEOUT',
        ).length
        if (timeoutCount >= 2) {
          setRunHint('连续超时：建议把并发降到 2 后重试')
        }

        if (token !== runTokenRef.current) return
        setSummary({
          total: items.length,
          succeeded: result.succeeded.length,
          failed: failures.length,
          skipped: result.skipped.length,
          failures,
          ...(result.retried ? { retried: result.retried } : {}),
        })
        setProgress({
          done: items.length,
          total: items.length,
          succeeded: result.succeeded.length,
          failed: failures.length,
          skipped: result.skipped.length,
        })
        toast.success(
          batchSummaryText({
            total: items.length,
            succeeded: result.succeeded.length,
            failed: failures.length,
            skipped: result.skipped.length,
          }),
        )
      } catch (error) {
        if (token !== runTokenRef.current) return
        const message = error instanceof Error ? error.message : '批量生成失败'
        if (succeededIdsRef.current.size > 0) {
          finishInterrupted(items, `批量中断：${message}（已完成项保留，可重试失败）`)
        } else {
          toast.error(message)
          setSummary(null)
        }
      } finally {
        if (token === runTokenRef.current) {
          abortRef.current = null
          setRunning(false)
          setAutoRetry(null)
          setInFlight(0)
        }
      }
    })()
  }

  const stopRun = () => {
    if (!running) return
    runTokenRef.current += 1
    abortRef.current?.abort()
    abortRef.current = null
    finishInterrupted(currentItemsRef.current, '已停止；未完成项计入失败，可重试')
    setRunning(false)
    setAutoRetry(null)
  }


  return (
    <div className="batch-derivation" role="dialog" aria-label="批量生成引申图">
      <div className="generative-head">
        <span className="mm-row-title">批量生成引申图（文字 + Mermaid）</span>
        <button type="button" className="mm-btn mm-btn--sm" onClick={onClose} disabled={running}>
          关闭
        </button>
      </div>
      <div className="generative-scroll">
        <div className="mm-btn-row">
          <button
            type="button"
            className={`mm-btn${scope === 'today' ? ' mm-btn--primary' : ''}`}
            onClick={() => setScope('today')}
          >
            今日要学
          </button>
          <button
            type="button"
            className={`mm-btn${scope === 'deck' ? ' mm-btn--primary' : ''}`}
            onClick={() => setScope('deck')}
          >
            词库
          </button>
        </div>
        {scope === 'deck' ? (
          <>
            <label className="mm-field">
              <span className="mm-field-label">词库（可选，默认当前词库）</span>
              <select
                className="mm-input"
                aria-label="选择词库"
                value={deckId}
                onChange={(event) => setDeckId(event.target.value)}
              >
                <option value="">当前词库</option>
                {decks.map((deck) => (
                  <option key={deck.id} value={deck.id}>
                    {deck.name}
                  </option>
                ))}
              </select>
            </label>
            <input
              className="mm-input"
              aria-label="搜索单词"
              placeholder="搜索单词（关键词/首字母）"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </>
        ) : null}
        <label className="mm-row" style={{ gap: 8 }}>
          <span className="mm-row-main">
            <span className="mm-row-title">排除已生成过引申图的词</span>
          </span>
          <Switch
            label="排除已生成过引申图的词"
            checked={excludeGenerated}
            onChange={setExcludeGenerated}
          />
        </label>
        <div className="mm-caption">
          {loading
            ? '正在读取候选…'
            : `候选 ${candidates.length} 个 · 已选 ${selected.length} 个${
                selected.length > 200 ? '（单批上限 200，超出请分批）' : ''
              }`}
        </div>
        {scope === 'deck' && candidates.length > 0 ? (
          <div className="mm-btn-row">
            <button
              type="button"
              className="mm-btn mm-btn--sm"
              onClick={() => setSelected(filtered.map((item) => item.wordId))}
            >
              全选当前筛选（{filtered.length}）
            </button>
            <button type="button" className="mm-btn mm-btn--sm" onClick={() => setSelected([])}>
              清空
            </button>
          </div>
        ) : null}
        <div className="batch-candidate-list">
          {filtered.slice(0, 200).map((item) => (
            <label className="mm-row" key={item.wordId}>
              <span className="mm-row-main">
                <span className="mm-row-title">{item.headword}</span>
                <span className="mm-row-sub">
                  {item.hasDerivationMap ? '已有引申图' : '未生成'}
                </span>
              </span>
              <input
                type="checkbox"
                aria-label={`选择 ${item.headword}`}
                checked={selectedSet.has(item.wordId)}
                onChange={(event) =>
                  setSelected((prev) =>
                    event.target.checked
                      ? [...prev, item.wordId]
                      : prev.filter((id) => id !== item.wordId),
                  )
                }
              />
            </label>
          ))}
        </div>
        <div className="mm-caption">预计调用 {selected.length} 次（按所选 AI 模型计费）；并发 {concurrency}（1–4）。不自动调用，需确认。</div>
        <div className="mm-row">
          <span className="mm-row-title">并发数</span>
          <Stepper
            ariaLabel="批量生成并发数"
            value={concurrency}
            min={1}
            max={4}
            onChange={setConcurrency}
          />
        </div>
        {running ? (
          <div className="mm-caption">
            进行中 {progress.done} / {progress.total}（成功 {progress.succeeded} · 失败 {progress.failed} · 当前请求 {inFlight}
            {autoRetry ? ` · 自动重试 ${autoRetry.current}/${autoRetry.total}` : ''}）
            <button
              type="button"
              className="mm-btn mm-btn--sm"
              onClick={stopRun}
            >
              停止
            </button>
          </div>
        ) : null}
        <div className="mm-btn-row">
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            disabled={running || selected.length === 0}
            onClick={() => setConfirmOpen(true)}
          >
            开始生成（{selected.length} 词）
          </button>
          {summary && summary.failures.length > 0 ? (
            <button
              type="button"
              className="mm-btn"
              disabled={running}
              onClick={() =>
                run(
                  summary.failures
                    .map((failure) => candidates.find((item) => item.wordId === failure.wordId))
                    .filter((item): item is BatchCandidateView => Boolean(item)),
                )
              }
            >
              重试失败（{summary.failures.length}）
            </button>
          ) : null}
        </div>
        {runHint ? <div className="mm-caption mm-danger-text">{runHint}</div> : null}
        {summary ? (
          <div className="mm-caption">
            <div>
              {batchSummaryText({ total: summary.total, succeeded: summary.succeeded, failed: summary.failed, skipped: summary.skipped })}
              {summary.retried ? ` · 自动重试 ${summary.retried} 项` : ''}
            </div>
            {summary.failures.map((failure) => (
              <div key={failure.wordId} className="mm-danger-text">
                {failure.headword}：{failure.message}
              </div>
            ))}
          </div>
        ) : null}
      </div>
      <Dialog
        open={confirmOpen}
        title="确认批量生成"
        onClose={() => setConfirmOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setConfirmOpen(false)}>
              取消
            </button>
            <button type="button" className="mm-btn mm-btn--primary" onClick={() => run(selectedCandidates)}>
              确认生成
            </button>
          </>
        }
      >
        <div className="mm-caption">
          将对 {selectedCandidates.length} 个词调用 AI（并发 {concurrency}，上限 200），每个词生成 rootLabel/text/mermaid/lines 并保存。失败项会记录并可重试；不覆盖 nc/用户内容/学习进度。
        </div>
      </Dialog>
    </div>
  )
}
