import { useEffect, useRef, useState } from 'react'
import { Stepper } from '../components/Stepper'
import { Dialog } from '../components/Dialog'
import { useToast } from '../../app/toast'
import {
  generateRareMeaningsBatch,
  getEffectiveContent,
  loadAiConfig,
  getRareMarkCandidates,
  applyRareMarkResults,
  saveRareMarkBatchJob,
  getRareMarkBatchJob,
  clearRareMarkBatchJob,
  RARE_MARK_VERSION,
} from '../../data'

export interface RarePreviewItem {
  wordId: string
  headword: string
  rareMeaningIndexes: number[]
  rareCns: string[]
  rareCoreSenseIndexes?: number[]
  rareCoreCns?: string[]
  error?: string
}

/** task-213：批量结果里的本义序号保留原始值（不因 source.coreSenses 暂时缺失而被过滤），label 仅用于展示 */
export function rareCoreBatchFields(
  indexes: number[] | undefined,
  coreSenses?: Array<{ index: number; label: string }> | undefined,
): { rareCoreSenseIndexes: number[]; rareCoreCns: string[] } {
  const rareCoreSenseIndexes = [...new Set((indexes ?? []).filter((index) => Number.isInteger(index) && index > 0))]
  return {
    rareCoreSenseIndexes,
    rareCoreCns: rareCoreSenseIndexes.map(
      (index) => coreSenses?.find((sense) => sense.index === index)?.label ?? `本义${index}`,
    ),
  }
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

/** task-213：批量应用选中项（面板路径可单测）：含义与本义独立写入并分别计数 */
export async function applyRareBatchSelected(args: {
  items: RarePreviewItem[]
  selected: string[]
  markCoreSenses: boolean
  getWord: (wordId: string) => Promise<{ meanings: Array<{ id: string }> } | null | undefined>
  getRareMeaningIds: (wordId: string) => Promise<string[]>
  setRareMeaningIds: (wordId: string, ids: string[]) => Promise<unknown>
  getRareCoreSenseIndexes: (wordId: string) => Promise<number[]>
  setRareCoreSenseIndexes: (wordId: string, indexes: number[]) => Promise<unknown>
}): Promise<{ appliedMeanings: number; appliedCore: number }> {
  let appliedMeanings = 0
  let appliedCore = 0
  for (const item of args.items) {
    if (!item.wordId || !args.selected.includes(item.wordId)) continue
    const word = await args.getWord(item.wordId)
    if (!word) continue
    const ids = rareMeaningIdsFromIndexes(word.meanings, item.rareMeaningIndexes)
    if (ids.length > 0) {
      const existing = await args.getRareMeaningIds(item.wordId)
      await args.setRareMeaningIds(item.wordId, [...new Set([...existing, ...ids])])
      appliedMeanings += ids.length
    }
    if (args.markCoreSenses && (item.rareCoreSenseIndexes?.length ?? 0) > 0) {
      const existingCore = await args.getRareCoreSenseIndexes(item.wordId)
      await args.setRareCoreSenseIndexes(item.wordId, [
        ...new Set([...existingCore, ...(item.rareCoreSenseIndexes ?? [])]),
      ])
      appliedCore += item.rareCoreSenseIndexes?.length ?? 0
    }
  }
  return { appliedMeanings, appliedCore }
}

/** D：AI 批量标记不常考含义（按今日计划分块生成，进度/停止/重试，预览后应用） */
export function RareMeaningsBatchPanel({
  open,
  onClose,
  currentWordId,
  selectedWordIds,
  currentDeckId,
  markCoreSenses = false,
}: {
  open: boolean
  onClose: () => void
  currentWordId?: string
  /** task-281：来自 AiGeneratePanel 的已选词，不再忽略 */
  selectedWordIds?: string[]
  currentDeckId?: string
  markCoreSenses?: boolean
}) {
  const toast = useToast()
  const [scope, setScope] = useState<'selected' | 'word' | 'today' | 'deck' | 'filtered'>(
    selectedWordIds && selectedWordIds.length > 0 ? 'selected' : 'today',
  )
  const [query, setQuery] = useState('')
  const [learned, setLearned] = useState<'all' | 'learned' | 'new'>('all')
  const [rareStatus, setRareStatus] = useState<'unchecked' | 'unmarked' | 'marked' | 'all'>('unchecked')
  const [dimension, setDimension] = useState<'meaning' | 'coreSense'>('meaning')
  const [batchSize, setBatchSize] = useState(100)
  const [offset, setOffset] = useState(0)
  const [candidateTotal, setCandidateTotal] = useState(0)
  const [candidateCounts, setCandidateCounts] = useState({ unchecked: 0, unmarked: 0, marked: 0 })
  const [candidateDiag, setCandidateDiag] = useState('')
  const requestTokenRef = useRef(0)
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
  const [pickedMeanings, setPickedMeanings] = useState<Record<string, number[]>>({})
  const [pickedCore, setPickedCore] = useState<Record<string, number[]>>({})
  const selectedUnique = [...new Set((selectedWordIds ?? []).filter(Boolean))]
  const [applying, setApplying] = useState(false)
  const [stopped, setStopped] = useState(false)
  const [confirmRunOpen, setConfirmRunOpen] = useState(false)
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
    if (selectedWordIds && selectedWordIds.length > 0) {
      setScope('selected')
      setOffset(0)
    }
    void getRareMarkBatchJob()
      .then((job) => {
        if (!job || job.done) return
        if (job.source && ['selected','word','today','deck','filtered'].includes(job.source)) setScope(job.source as typeof scope)
        if (job.cursor > 0) setOffset(job.cursor)
        if (job.filter?.query) setQuery(job.filter.query)
        if (job.filter?.rareStatus) setRareStatus(job.filter.rareStatus)
        if (job.filter?.dimension) setDimension(job.filter.dimension)
      })
      .catch(() => undefined)
    let alive = true
    const requestToken = requestTokenRef.current + 1
    requestTokenRef.current = requestToken
    setLoading(true)
    setItems([])
    setFailed([])
    setSelected([])
    setProgress({ done: 0, total: 0, succeeded: 0, failed: 0, inFlight: 0 })
    void (async () => {
      try {
        const result = await getRareMarkCandidates({
          source: scope,
          ...(scope === 'selected' ? { wordIds: selectedWordIds ?? [] } : {}),
          ...(scope === 'word' ? { wordIds: currentWordId ? [currentWordId] : [] } : {}),
          ...(currentDeckId ? { deckId: currentDeckId } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(learned !== 'all' ? { learned: learned === 'learned' } : {}),
          dimension,
          rareStatus,
          limit: batchSize,
          offset,
        })
        if (!alive || requestToken !== requestTokenRef.current) return
        setCandidateTotal(result.total)
        setCandidateCounts({
          unchecked: result.counts.unchecked,
          unmarked: result.counts.unmarked,
          marked: result.counts.marked,
        })
        setCandidateDiag(
          `已选 ${selectedWordIds?.length ?? 0}（唯一 ${selectedUnique.length}）· API total ${result.total} · words ${result.words.length}`,
        )
        const sources: Array<{
          word: string
          wordId?: string
          meanings: Array<{ index: number; cn: string; pos?: string }>
          coreSenses?: Array<{ index: number; label: string; note?: string; origin?: string }>
        }> = []
        for (const candidate of result.words) {
          const word = candidate.word
          let coreSenses: Array<{ index: number; label: string; note?: string; origin?: string }> = []
          if (markCoreSenses) {
            const effective = await getEffectiveContent(word.id)
            coreSenses = (effective?.coreSenses ?? [])
              .filter((sense) => Boolean(sense.label))
              .map((sense) => ({
                index: sense.index,
                label: sense.label,
                ...(sense.note ? { note: sense.note } : {}),
                ...(sense.origin ? { origin: sense.origin } : {}),
              }))
          }
          sources.push({
            word: word.headword,
            wordId: word.id,
            meanings: word.meanings.map((meaning, index) => ({
              index: index + 1,
              cn: meaning.cn,
              ...(meaning.pos ? { pos: meaning.pos } : {}),
            })),
            ...(markCoreSenses ? { coreSenses } : {}),
          })
        }
        sourcesRef.current = sources
        setProgress({ done: 0, total: sources.length, succeeded: 0, failed: 0, inFlight: 0 })
      } catch (error) {
        if (alive && requestToken === requestTokenRef.current) {
          toast.error(error instanceof Error ? error.message : '读取候选词失败')
        }
      } finally {
        if (alive && requestToken === requestTokenRef.current) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, scope, selectedUnique.join(','), currentWordId, currentDeckId, query, learned, dimension, rareStatus, batchSize, offset, markCoreSenses, toast])
  useEffect(() => {
    const meanings: Record<string, number[]> = {}
    const cores: Record<string, number[]> = {}
    for (const item of items) {
      meanings[item.wordId] = [...item.rareMeaningIndexes]
      cores[item.wordId] = [...(item.rareCoreSenseIndexes ?? [])]
    }
    setPickedMeanings(meanings)
    setPickedCore(cores)
  }, [items])

  if (!open) return null

  const togglePicked = (
    wordId: string,
    kind: 'meaning' | 'core',
    index: number,
  ) => {
    const setter = kind === 'meaning' ? setPickedMeanings : setPickedCore
    setter((prev) => {
      const current = prev[wordId] ?? []
      const next = current.includes(index)
        ? current.filter((value) => value !== index)
        : [...current, index]
      return { ...prev, [wordId]: next }
    })
  }

  const selectAllPicked = (checked: boolean) => {
    const meanings: Record<string, number[]> = {}
    const cores: Record<string, number[]> = {}
    for (const item of items) {
      meanings[item.wordId] = checked ? [...item.rareMeaningIndexes] : []
      cores[item.wordId] = checked ? [...(item.rareCoreSenseIndexes ?? [])] : []
    }
    setPickedMeanings(meanings)
    setPickedCore(cores)
  }

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
        markCoreSenses,
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
        const sourceCoreSenses = (source as { coreSenses?: Array<{ index: number; label: string }> }).coreSenses
        const coreFields = rareCoreBatchFields(entry.rareCoreSenseIndexes, sourceCoreSenses)
        collected.push({
          wordId: source.wordId ?? '',
          headword: source.word,
          rareMeaningIndexes: entry.rareMeaningIndexes ?? [],
          rareCns: rareCns.filter(Boolean),
          ...coreFields,
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
      void saveRareMarkBatchJob({
        id: `rare-batch:${Date.now()}`,
        source: scope,
        filter: {
          ...(query.trim() ? { query: query.trim() } : {}),
          ...(learned !== 'all' ? { learned: learned === 'learned' } : {}),
          dimension,
          rareStatus,
        },
        cursor: offset + sources.length,
        failed: failures.map((failure) => ({ wordId: failure.wordId ?? failure.word, error: failure.error })),
        results: collected.map((item) => ({
          wordId: item.wordId,
          checkedAt: Date.now(),
          markedCount: item.rareMeaningIndexes.length + (item.rareCoreSenseIndexes?.length ?? 0),
        })),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        done: offset + sources.length >= candidateTotal,
      })
      setProgress({
        done: sources.length,
        total: sources.length,
        succeeded: collected.length,
        failed: failures.length,
        inFlight: 0,
      })
      const hasRare = collected.some(
        (item) => item.rareCns.length > 0 || (item.rareCoreCns?.length ?? 0) > 0,
      )
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

  const successfulItems = items.filter((item) => !item.error)
  const noRareCount = successfulItems.filter(
    (item) => item.rareCns.length === 0 && (item.rareCoreCns?.length ?? 0) === 0,
  ).length

  const apply = () => {
    void (async () => {
      setApplying(true)
      try {
        const targetIds = selected.length > 0 ? selected : successfulItems.map((item) => item.wordId)
        const result = await applyRareMarkResults(
          items
            .filter((item) => targetIds.includes(item.wordId))
            .map((item) => ({
              wordId: item.wordId,
              rareMeaningIndexes: pickedMeanings[item.wordId] ?? [],
              rareCoreSenseIndexes: pickedCore[item.wordId] ?? [],
            })),
          { version: RARE_MARK_VERSION },
        )
        await clearRareMarkBatchJob()
        toast.success(
          `已应用：检查 ${result.checked} 词 / 更新 ${result.updated} 项${
            result.failed.length > 0 ? ` / 失败 ${result.failed.length}` : ''
          }`,
        )
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
        <span className="mm-row-title">批量标记不常考含义/本义</span>
        <button type="button" className="mm-btn mm-btn--sm" onClick={onClose} disabled={running}>
          关闭
        </button>
      </div>
      <div className="generative-scroll">
        <div className="mm-btn-row">
          {(
            [
              ['selected', `已选 ${selectedWordIds?.length ?? 0} 词`],
              ['word', '当前词'],
              ['today', '今日计划'],
              ['deck', '当前词库'],
              ['filtered', '当前筛选'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`mm-btn mm-btn--sm${scope === value ? ' mm-btn--primary' : ''}`}
              disabled={running}
              onClick={() => {
                setScope(value)
                setOffset(0)
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="mut-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input
            className="mm-input"
            aria-label="筛选不常考关键词"
            placeholder="关键词（英文/中文）"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setOffset(0)
            }}
          />
          <select
            className="mm-input"
            aria-label="已学筛选"
            value={learned}
            onChange={(event) => {
              setLearned(event.target.value as 'all' | 'learned' | 'new')
              setOffset(0)
            }}
          >
            <option value="all">全部学习状态</option>
            <option value="learned">已学</option>
            <option value="new">未学</option>
          </select>
          <select
            className="mm-input"
            aria-label="检查状态"
            value={rareStatus}
            onChange={(event) => {
              setRareStatus(event.target.value as 'unchecked' | 'unmarked' | 'marked' | 'all')
              setOffset(0)
            }}
          >
            <option value="unchecked">仅未检查</option>
            <option value="unmarked">未标记</option>
            <option value="marked">已标记</option>
            <option value="all">全部</option>
          </select>
          <select
            className="mm-input"
            aria-label="不熟悉度维度"
            value={dimension}
            onChange={(event) => {
              setDimension(event.target.value as 'meaning' | 'coreSense')
              setOffset(0)
            }}
          >
            <option value="meaning">含义不熟悉度</option>
            <option value="coreSense">本义不熟悉度</option>
          </select>
          <select
            className="mm-input"
            aria-label="批次大小"
            value={batchSize}
            onChange={(event) => {
              setBatchSize(Number(event.target.value))
              setOffset(0)
            }}
          >
            <option value={50}>50 / 批</option>
            <option value={100}>100 / 批</option>
            <option value={200}>200 / 批</option>
            <option value={500}>500 / 批</option>
            <option value={1000}>全部（≤1000）</option>
          </select>
        </div>
        <div className="mm-caption">
          {loading
            ? '正在读取候选词…'
            : `筛选后 ${candidateTotal} 词 · 已检查 ${Math.max(0, candidateTotal - candidateCounts.unchecked)}（未标记 ${candidateCounts.unmarked} / 已标记 ${candidateCounts.marked}） · 本批 ${progress.total} · 剩余 ${Math.max(0, candidateTotal - offset)}；AI 结果先预览，勾选后应用。${candidateDiag ? ` · ${candidateDiag}` : ''}`}
        </div>
        {candidateTotal > offset + batchSize ? (
          <button
            type="button"
            className="mm-btn mm-btn--sm"
            disabled={running}
            onClick={() => setOffset((value) => value + batchSize)}
          >
            继续下一批
          </button>
        ) : null}
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
          {items.length === 0 ? (
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => setConfirmRunOpen(true)}
              disabled={running || loading || progress.total === 0}
            >
              {running ? '进行中…' : '开始批量标记'}
            </button>
          ) : null}
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
        {items.length > 0 ? (
          <div className="mm-btn-row">
            <button type="button" className="mm-btn mm-btn--sm" onClick={() => selectAllPicked(true)}>
              全选
            </button>
            <button type="button" className="mm-btn mm-btn--sm" onClick={() => selectAllPicked(false)}>
              清空
            </button>
          </div>
        ) : null}
        {items.map((item) => (
          <label className="mm-row" key={item.wordId}>
            <span className="mm-row-main">
              <span className="mm-row-title">{item.headword}</span>
              <span className="mm-row-sub">
                {item.rareCns.length > 0 ? `含义不常考：${item.rareCns.join('、')}` : 'AI 判定无不常考含义'}
                {(item.rareCoreCns?.length ?? 0) > 0
                  ? ` · 本义不常考：${item.rareCoreCns!.join('、')}`
                  : markCoreSenses
                    ? ' · 本义无明显不常考'
                    : ''}
              </span>
            </span>
            <span className="rare-preview-picks">
              {item.rareCns.map((cn, index) => (
                <label key={`m-${index}`} className="mm-caption">
                  <input
                    type="checkbox"
                    checked={(pickedMeanings[item.wordId] ?? []).includes(item.rareMeaningIndexes[index] ?? index + 1)}
                    onChange={() => togglePicked(item.wordId, 'meaning', item.rareMeaningIndexes[index] ?? index + 1)}
                  />
                  含义：{cn}
                </label>
              ))}
              {(item.rareCoreCns ?? []).map((cn, index) => (
                <label key={`c-${index}`} className="mm-caption">
                  <input
                    type="checkbox"
                    checked={(pickedCore[item.wordId] ?? []).includes(item.rareCoreSenseIndexes?.[index] ?? index + 1)}
                    onChange={() => togglePicked(item.wordId, 'core', item.rareCoreSenseIndexes?.[index] ?? index + 1)}
                  />
                  本义：{cn}
                </label>
              ))}
            </span>
            {!item.error ? (
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
        {successfulItems.length > 0 ? (
          <div className="mm-caption">
            本批已检查 {successfulItems.length} 词（无标记 {noRareCount}）· 已选 {selected.length}；
            应用会写入已检查时间（即使 0 条不常考），避免下次重复调用 AI。
          </div>
        ) : null}
        {items.length > 0 ? <div className="batch-derivation-apply-sep" /> : null}
        <button
          type="button"
          className="mm-btn mm-btn--primary"
          disabled={applying || (selected.length === 0 && successfulItems.length === 0)}
          onClick={apply}
        >
          {applying ? '应用中…' : `标记本批 ${selected.length || successfulItems.length} 词为已检查`}
        </button>
      </div>
      <Dialog
        open={confirmRunOpen}
        title="确认批量标记"
        onClose={() => setConfirmRunOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setConfirmRunOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              onClick={() => {
                setConfirmRunOpen(false)
                void run()
              }}
            >
              确认开始
            </button>
          </>
        }
      >
        <div className="mm-caption">
          本批 {progress.total} 个词 · 并发 {concurrency} · 已选 {selectedWordIds?.length ?? 0} 词来源。
          AI 调用会产生费用，结果先预览，勾选后才会应用。
        </div>
        {failed.length > 0 ? <div className="mm-caption">失败可重试；关闭后再开可从 job 继续。</div> : null}
      </Dialog>
    </div>
  )
}
