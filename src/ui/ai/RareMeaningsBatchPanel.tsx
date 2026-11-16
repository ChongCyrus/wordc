import { useEffect, useRef, useState } from 'react'
import { Stepper } from '../components/Stepper'
import { useToast } from '../../app/toast'
import {
  generateRareMeaningsBatch,
  getRareMeaningIds,
  getSettings,
  getTodayPlan,
  getWord,
  getWordsPage,
  loadAiConfig,
  setRareMeaningIds,
} from '../../data'

export interface RarePreviewItem {
  wordId: string
  headword: string
  rareMeaningIndexes: number[]
  rareCns: string[]
  error?: string
}

/** 把 1 起含义序号映射为 meaningId 集合（供设置 rare） */
export function rareMeaningIdsFromIndexes(
  meanings: Array<{ id: string }>,
  indexes: number[],
): string[] {
  const out: string[] = []
  for (const index of indexes) {
    const meaning = meanings[index - 1]
    if (meaning && !out.includes(meaning.id)) out.push(meaning.id)
  }
  return out
}

/** D：AI 批量标记不常考含义（按今日计划分块生成，进度/停止/重试，预览后应用） */
export function RareMeaningsBatchPanel({
  open,
  onClose,
  currentWordId,
}: {
  open: boolean
  onClose: () => void
  currentWordId?: string
}) {
  const toast = useToast()
  const [scope, setScope] = useState<'word' | 'today' | 'deck'>('today')
  const [loading, setLoading] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState({
    done: 0,
    total: 0,
    succeeded: 0,
    failed: 0,
    inFlight: 0,
  })
  const [concurrency, setConcurrency] = useState(2)
  const [items, setItems] = useState<RarePreviewItem[]>([])
  const [failed, setFailed] = useState<Array<{ word: string; wordId?: string; error: string }>>([])
  const [selected, setSelected] = useState<string[]>([])
  const [applying, setApplying] = useState(false)
  const [stopped, setStopped] = useState(false)
  const runTokenRef = useRef(0)
  const stopRequestedRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const sourcesRef = useRef<
    Array<{
      word: string
      wordId?: string
      meanings: Array<{ index: number; cn: string; pos?: string }>
    }>
  >([])

  useEffect(() => {
    if (!open) return
    let alive = true
    setLoading(true)
    setItems([])
    setFailed([])
    setSelected([])
    setProgress({ done: 0, total: 0, succeeded: 0, failed: 0, inFlight: 0 })
    void (async () => {
      try {
        let wordIds: string[] = []
        if (scope === 'word') {
          if (!currentWordId) throw new Error('当前没有可标记的单词')
          wordIds = [currentWordId]
        } else if (scope === 'today') {
          const plan = await getTodayPlan()
          wordIds = plan.wordIds.slice(0, 200)
        } else {
          const settings = await getSettings()
          const deckId = settings['data.selectedDeckId']
          if (!deckId) throw new Error('未选择词库')
          const page = await getWordsPage(deckId, { limit: 200 })
          wordIds = page.words.map((word) => word.id)
        }
        const sources = []
        for (const wordId of wordIds) {
          const word = await getWord(wordId)
          if (!word) continue
          sources.push({
            word: word.headword,
            wordId: word.id,
            meanings: word.meanings.map((meaning, index) => ({
              index: index + 1,
              cn: meaning.cn,
              ...(meaning.pos ? { pos: meaning.pos } : {}),
            })),
          })
        }
        if (!alive) return
        sourcesRef.current = sources
        setProgress({ done: 0, total: sources.length, succeeded: 0, failed: 0, inFlight: 0 })
      } catch (error) {
        if (alive) toast.error(error instanceof Error ? error.message : '读取候选词失败')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, scope, currentWordId, toast])

  if (!open) return null

  const run = async (sources = sourcesRef.current, retry = false) => {
    if (sources.length === 0) {
      toast.error('没有可标记的词')
      return
    }
    const token = runTokenRef.current + 1
    runTokenRef.current = token
    setRunning(true)
    setStopped(false)
    stopRequestedRef.current = false
    if (!retry) {
      setItems([])
      setFailed([])
      setSelected([])
    }
    setProgress({ done: 0, total: sources.length, succeeded: 0, failed: 0, inFlight: 0 })
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const config = await loadAiConfig()
      if (!config.apiKey) throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
      const result = await generateRareMeaningsBatch(sources, config, {
        concurrency,
        timeoutMs: 30_000,
        retryTimeoutOnce: true,
        signal: controller.signal,
        onProgress: (p) => {
          if (token !== runTokenRef.current) return
          setProgress({
            done: p.done,
            total: p.total,
            succeeded: p.succeeded,
            failed: p.failed,
            inFlight: p.inFlight,
          })
        },
      })
      if (token !== runTokenRef.current) return
      const collected: RarePreviewItem[] = []
      const failures: Array<{ word: string; wordId?: string; error: string }> = []
      for (const entry of result.results) {
        const source = entry.source
        if (entry.error || entry.errorKind === 'canceled') {
          if (entry.errorKind === 'canceled') continue
          failures.push({
            word: source.word,
            ...(source.wordId ? { wordId: source.wordId } : {}),
            error: entry.error ?? 'AI 标记失败',
          })
          continue
        }
        const rareCns = (entry.rareMeaningIndexes ?? []).map(
          (index) => source.meanings[index - 1]?.cn ?? '',
        )
        collected.push({
          wordId: source.wordId ?? '',
          headword: source.word,
          rareMeaningIndexes: entry.rareMeaningIndexes ?? [],
          rareCns: rareCns.filter(Boolean),
        })
      }
      if (retry) {
        setItems((prev) => [
          ...prev.filter((item) => !collected.some((next) => next.wordId === item.wordId)),
          ...collected,
        ])
      } else {
        setItems(collected)
      }
      setFailed(failures)
      setSelected(collected.map((item) => item.wordId))
      setProgress({
        done: sources.length,
        total: sources.length,
        succeeded: collected.length,
        failed: failures.length,
        inFlight: 0,
      })
      const hasRare = collected.some((item) => item.rareCns.length > 0)
      if (result.canceled) {
        setStopped(true)
        if (!stopRequestedRef.current) {
          toast.error('已停止；已完成结果保留，可重试失败')
        }
      } else if (!hasRare && failures.length === 0) {
        toast.success('没有需要标记的含义')
      } else if (failures.length > 0) {
        toast.error(`完成：${collected.length} 成功 / ${failures.length} 失败`)
      } else {
        toast.success(`完成：${collected.length} 个词已生成预览${result.retried > 0 ? `（自动重试 ${result.retried} 次）` : ''}`)
      }
    } catch (error) {
      if (token === runTokenRef.current) {
        const message = error instanceof Error ? error.message : '批量标记失败'
        if ((error as { code?: string })?.code === 'AI_COST_LIMIT') toast.error(message)
        else toast.error(message)
      }
    } finally {
      if (token === runTokenRef.current) {
        setRunning(false)
        abortRef.current = null
      }
    }
  }

  const stop = () => {
    if (!running) return
    stopRequestedRef.current = true
    abortRef.current?.abort()
    // 立即恢复 UI（按钮/范围可用），服务 result 返回后补最终统计/失败列表
    setRunning(false)
    setStopped(true)
    setProgress((prev) => ({ ...prev, inFlight: 0 }))
    toast.error('已停止；已完成结果保留，可重试失败')
  }

  const apply = () => {
    void (async () => {
      setApplying(true)
      try {
        let applied = 0
        for (const item of items) {
          if (!item.wordId || !selected.includes(item.wordId)) continue
          const word = await getWord(item.wordId)
          if (!word) continue
          const ids = rareMeaningIdsFromIndexes(
            word.meanings.map((meaning) => ({ id: meaning.id })),
            item.rareMeaningIndexes,
          )
          if (ids.length === 0) continue
          const existing = await getRareMeaningIds(item.wordId)
          await setRareMeaningIds(item.wordId, [...new Set([...existing, ...ids])])
          applied += 1
        }
        toast.success(`已标记 ${applied} 个词的不常考含义`)
        onClose()
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '应用失败')
      } finally {
        setApplying(false)
      }
    })()
  }

  return (
    <div className="batch-derivation" role="dialog" aria-label="批量标记不常考含义">
      <div className="generative-head">
        <span className="mm-row-title">批量标记不常考含义（今日单词）</span>
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
        <div className="mm-caption">
          {loading
            ? '正在读取候选词…'
            : `共 ${progress.total} 个词${scope === 'deck' ? '（当前词库最多取 200 个）' : ''}；AI 结果先预览，勾选后应用。`}
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
              进行中 {progress.done} / {progress.total}（成功 {progress.succeeded} · 失败{' '}
              {progress.failed} · 当前 {progress.inFlight}）
              {running ? (
                <button type="button" className="mm-btn mm-btn--sm" onClick={stop}>
                  停止
                </button>
              ) : null}
              {stopped && !running ? ' · 已停止' : ''}
            </div>
          </>
        ) : null}
        <div className="mm-row">
          <span className="mm-row-title">并发数</span>
          <Stepper
            ariaLabel="批量标记不常考并发数"
            value={concurrency}
            min={1}
            max={4}
            onChange={setConcurrency}
          />
        </div>
        <div className="mm-btn-row">
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => void run()} disabled={running || loading}>
            {running ? '进行中…' : '开始批量标记'}
          </button>
          {failed.length > 0 ? (
            <button
              type="button"
              className="mm-btn"
              disabled={running}
              onClick={() => {
                void (async () => {
                  setFailed([])
                  const retrySources = failed
                    .map((failure) => sourcesRef.current.find((source) => source.word === failure.word))
                    .filter((source): source is NonNullable<typeof source> => Boolean(source))
                  await run(retrySources, true)
                })()
              }}
            >
              重试失败（{failed.length}）
            </button>
          ) : null}
        </div>
        {items.map((item) => (
          <label className="mm-row" key={item.wordId}>
            <span className="mm-row-main">
              <span className="mm-row-title">{item.headword}</span>
              <span className="mm-row-sub">
                {item.rareCns.length > 0 ? `不常考：${item.rareCns.join('、')}` : 'AI 判定无不常考含义'}
              </span>
            </span>
            {item.rareCns.length > 0 ? (
              <input
                type="checkbox"
                aria-label={`应用 ${item.headword} 的不常考标记`}
                checked={selected.includes(item.wordId)}
                onChange={(event) =>
                  setSelected((prev) =>
                    event.target.checked
                      ? [...prev, item.wordId]
                      : prev.filter((id) => id !== item.wordId),
                  )
                }
              />
            ) : null}
          </label>
        ))}
        {failed.map((failure) => (
          <div className="mm-caption mm-danger-text" key={`${failure.wordId ?? failure.word}-${failure.error}`}>
            {failure.word}：{failure.error}
          </div>
        ))}
        <button
          type="button"
          className="mm-btn mm-btn--primary"
          disabled={applying || selected.length === 0}
          onClick={apply}
        >
          应用已选（{selected.length}）
        </button>
      </div>
    </div>
  )
}
