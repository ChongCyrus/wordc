import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  buildGenerationTargets,
  getGenerationJob,
  getGenerationJobPendingTargets,
  queryAdvancedFilter,
  createGenerationJob,
  runGenerationJob,
  loadAiSettings,
} from '../../data'
import type { AdvancedFilter, GenerationJob, GenerationTargetKind } from '../../data'
import { PageShell } from '../components/PageShell'
import { NumberDraftInput } from '../components/NumberDraftInput'
import { FilterTreeEditor } from './AdvancedFilterPage'
import { useToast } from '../../app/toast'

interface FilterGenerateSeed {
  deckId?: string
  wordIds?: string[]
  sourceLabel?: string
}

const GENERATE_TYPES: Array<{ kind: GenerationTargetKind; label: string }> = [
  { kind: 'examples', label: '例句' },
  { kind: 'phrases', label: '词组' },
  { kind: 'mnemonics', label: '助记' },
  { kind: 'semantics', label: '本义/引申链' },
  { kind: 'core-sense', label: '本义助记' },
  { kind: 'overview', label: '串联本义' },
  { kind: 'meaning-mnemonic', label: '含义助记' },
  { kind: 'root-etymology', label: '词根缀源' },
  { kind: 'derivation', label: '引申图' },
  { kind: 'rare-meanings', label: '不常考' },
]

/** 0.6.0：统一 AI 生成页（来源 seed/任务续跑 + 全类型选择 + 目标数） */
export default function GeneratePage() {
  const { deckId = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const jobId = params.get('jobId')
  const [seed, setSeed] = useState<FilterGenerateSeed | null>(null)
  const [job, setJob] = useState<GenerationJob | null>(null)
  const [ready, setReady] = useState(false)
  const [selectedKinds, setSelectedKinds] = useState<GenerationTargetKind[]>(['examples'])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [propertyFilter, setPropertyFilter] = useState<AdvancedFilter>({ match: 'and', groups: [] })
  const [filteredWordIds, setFilteredWordIds] = useState<string[] | null>(null)
  const [filtering, setFiltering] = useState(false)
  const [batchSize, setBatchSize] = useState(10)
  const [concurrency, setConcurrency] = useState(2)
  const [budgetYuan, setBudgetYuan] = useState(3)
  const [starting, setStarting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const pausedRef = useRef(false)
  const autoStartedRef = useRef(false)

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem('momo:filterGenerateSeed')
      if (raw) setSeed(JSON.parse(raw) as FilterGenerateSeed)
    } catch {
      setSeed(null)
    }
    if (!jobId) {
      setReady(true)
      return
    }
    void getGenerationJob(jobId)
      .then(async (next) => {
        if (!next) {
          toast.error('任务不存在或已删除')
          setReady(true)
          return
        }
        setJob(next)
        const pending = await getGenerationJobPendingTargets(jobId).catch(() => [])
        setSeed({
          deckId,
          wordIds: pending.map((target) => target.wordId),
          sourceLabel: `续跑任务「${next.name}」· ${next.cursor}/${next.targetTotal ?? '?'} · ${next.kind} · 剩余 ${pending.length} 词`,
        })
        setReady(true)
      })
      .catch((error) => {
        toast.error(error instanceof Error ? error.message : '读取任务失败')
        setReady(true)
      })
  }, [deckId, jobId, toast])

  const wordIds = useMemo(() => seed?.wordIds ?? [], [seed?.wordIds])
  const effectiveWordIds = filteredWordIds ?? wordIds
  const hasFilter = propertyFilter.groups.some((group) => group.conditions.length > 0)
  const finalTargetCount = GENERATE_TYPES.filter((item) => selectedKinds.includes(item.kind)).reduce((sum, item) => sum + (counts[item.label] ?? 0), 0)

  useEffect(() => {
    if (!ready || wordIds.length === 0) return
    let alive = true
    if (!hasFilter) {
      setFilteredWordIds(null)
      return
    }
    setFiltering(true)
    void queryAdvancedFilter({ wordIds, filter: propertyFilter, limit: 1000 })
      .then((result) => {
        if (alive) setFilteredWordIds(result.words.map((item) => item.word.id))
      })
      .catch(() => {
        if (alive) setFilteredWordIds([])
      })
      .finally(() => {
        if (alive) setFiltering(false)
      })
    return () => {
      alive = false
    }
  }, [ready, wordIds, propertyFilter, hasFilter])

  useEffect(() => {
    if (!ready) return
    if (effectiveWordIds.length === 0) {
      setCounts(Object.fromEntries(GENERATE_TYPES.map((item) => [item.label, 0])))
      return
    }
    let alive = true
    void Promise.all(
      GENERATE_TYPES.map(async (item) => {
        try {
          const result = await buildGenerationTargets({ kind: item.kind, wordIds: effectiveWordIds })
          return [item.label, result.totalTargets] as const
        } catch {
          return [item.label, 0] as const
        }
      }),
    ).then((entries) => {
      if (alive) setCounts(Object.fromEntries(entries))
    })
    return () => {
      alive = false
    }
  }, [ready, effectiveWordIds])


  useEffect(() => {
    if (!starting) return
    const timer = window.setInterval(() => {
      const id = job?.id ?? jobId
      if (!id) return
      void getGenerationJob(id).then((next) => {
        if (!next) return
        if (next.status === 'paused' || next.status === 'canceled') {
          pausedRef.current = true
          abortRef.current?.abort()
        }
      }).catch(() => undefined)
    }, 500)
    return () => window.clearInterval(timer)
  }, [starting, job?.id, jobId])

  useEffect(() => () => abortRef.current?.abort(), [])

  const startUnified = async () => {
    const selectedWordLevel = selectedKinds
    if (selectedWordLevel.length === 0) {
      toast.error('请先选择至少一个生成类型')
      return
    }
    setStarting(true)
    try {
      const settings = await loadAiSettings()
      if (!settings.config.apiKey) {
        toast.error('未配置 AI Key')
        return
      }
      const allTargets: Array<{ wordId: string; headword?: string; kind: string; targetKey: string; context: Record<string, unknown> }> = []
      for (const kind of selectedWordLevel) {
        const built = await buildGenerationTargets({ kind, wordIds: effectiveWordIds })
        for (const target of built.targets) {
          const suffix =
            target.meaningIndex != null
              ? `#m${target.meaningIndex}`
              : target.coreSenseIndex != null
                ? `#c${target.coreSenseIndex}`
                : ''
          allTargets.push({
            wordId: target.wordId,
            ...(target.headword ? { headword: target.headword } : {}),
            kind,
            targetKey: `${kind}:${target.wordId}${suffix}`,
            context: {
              ...(target.meaningId ? { meaningId: target.meaningId } : {}),
              ...(target.meaningIndex != null ? { meaningIndex: target.meaningIndex } : {}),
              ...(target.coreSenseIndex != null ? { coreSenseIndex: target.coreSenseIndex } : {}),
              ...(target.coreSenseLabel ? { coreSenseLabel: target.coreSenseLabel } : {}),
            },
          })
        }
      }
      if (allTargets.length === 0) {
        toast.error('没有可生成目标')
        return
      }
      const activeJob = job ?? await createGenerationJob({
        kind: selectedWordLevel[0] as never,
        source: sourceLabel ?? 'advanced-filter',
        targetTotal: allTargets.length,
        targets: allTargets as never,
        kinds: selectedWordLevel as never,
        batchSize,
        concurrency,
        budget: { maxCostPerRun: budgetYuan },
        config: { kinds: selectedWordLevel, batchSize, concurrency, maxCostPerRun: budgetYuan },
      })
      if (activeJob.status === 'completed' || activeJob.status === 'canceled') {
        toast.error('任务已结束，请重建任务')
        return
      }
      pausedRef.current = false
      const controller = new AbortController()
      abortRef.current = controller
      const result = await runGenerationJob({
        jobId: activeJob.id,
        config: settings.config,
        batchSize,
        concurrency,
        deps: { signal: controller.signal },
      })
      const latest = await getGenerationJob(activeJob.id)
      if (latest?.status === 'paused' || latest?.status === 'canceled' || pausedRef.current) {
        toast.success(`已${latest?.status === 'canceled' ? '取消' : '暂停'}，当前完成 ${result.processed}/${result.total}，可到任务中心继续`)
        return
      }
      toast.success(`统一生成完成：${result.processed}/${result.total} 条，任务已写入任务中心`)
    } catch (error) {
      if (pausedRef.current) {
        toast.success('任务已暂停，可到任务中心继续')
      } else {
        toast.error(error instanceof Error ? error.message : '统一生成失败')
      }
    } finally {
      setStarting(false)
    }
  }

  // 0.6.1：从任务中心继续进入 GeneratePage(jobId) 时自动从剩余 targets 续跑
  useEffect(() => {
    if (!ready || !jobId || !job || autoStartedRef.current) return
    if (job.status === 'completed' || job.status === 'canceled') return
    autoStartedRef.current = true
    if (job.kinds && job.kinds.length > 0) {
      setSelectedKinds(job.kinds as GenerationTargetKind[])
    }
    if (job.batchSize) setBatchSize(job.batchSize)
    if (job.concurrency) setConcurrency(job.concurrency)
    void startUnified()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, jobId, job])

  if (!ready) return <div className="mm-page mm-caption">读取任务中…</div>

  const sourceLabel = job
    ? `续跑任务「${job.name}」· 进度 ${job.cursor}/${job.targetTotal ?? '?'} · ${job.kind}`
    : seed?.sourceLabel

  return (
    <PageShell title="AI 生成数据" backTo={`/decks/${encodeURIComponent(deckId)}/filter?restore=1`}>
      <div className="mm-caption" style={{ marginBottom: 8 }}>来源：{sourceLabel ?? '未找到来源，请从高级筛选进入'}</div>
      <details className="mm-card" style={{ marginBottom: 8 }}>
        <summary className="mm-row-title">每类型属性组筛选（可选）</summary>
        <FilterTreeEditor
          filter={propertyFilter}
          onChange={setPropertyFilter}
          unitOptions={[]}
          hitCounts={{}}
        />
        <div className="mm-caption" style={{ marginTop: 6 }}>
          {filtering ? '筛选中…' : hasFilter ? `属性筛选后 ${effectiveWordIds.length} 词` : `未筛选，seed ${wordIds.length} 词`}
        </div>
      </details>
      <div className="mm-list">
        {GENERATE_TYPES.map((item, index) => {
          const checked = selectedKinds.includes(item.kind)
          return (
            <label className="mm-row" key={`${item.kind}-${index}`}>
              <span className="mm-row-main">
                <span className="mm-row-title">{item.label}</span>
                <span className="mm-row-sub">目标 {counts[item.label] ?? '…'} 个</span>
              </span>
              <input
                type="checkbox"
                checked={checked}
                onChange={(event) => {
                  const kind = item.kind
                  setSelectedKinds((prev) =>
                    event.target.checked ? [...new Set([...prev, kind])] : prev.filter((value) => value !== kind),
                  )
                }}
              />
            </label>
          )
        })}
      </div>
      <div className="filter-batch-controls" style={{ marginTop: 8 }}>
        <label className="filter-batch-field">
          <span>每批词数</span>
          <NumberDraftInput className="mm-input" min={1} max={50} value={batchSize} onCommit={setBatchSize} />
        </label>
        <label className="filter-batch-field">
          <span>并发</span>
          <NumberDraftInput className="mm-input" min={1} max={8} value={concurrency} onCommit={setConcurrency} />
        </label>
        <label className="filter-batch-field">
          <span>预算 ¥</span>
          <NumberDraftInput className="mm-input" min={0} value={budgetYuan} onCommit={setBudgetYuan} />
        </label>
      </div>
      <div className="mm-caption" style={{ marginTop: 8 }}>
        已选类型 {selectedKinds.length} · 最终目标 {finalTargetCount} 个
      </div>
      <div className="mm-btn-row" style={{ marginTop: 12 }}>
        <button
          type="button"
          className="mm-btn mm-btn--primary"
          disabled={!seed || selectedKinds.length === 0 || starting || finalTargetCount === 0}
          onClick={() => void startUnified()}
        >
          {starting ? '统一生成中…' : finalTargetCount === 0 ? '无可生成目标' : '统一生成'}
        </button>
        <div className="mm-caption" style={{ flexBasis: '100%' }}>
          任务可在「我的 → AI 生成任务」暂停 / 继续；批次、并发、预算见上方配置。
        </div>
        <button type="button" className="mm-btn" onClick={() => navigate(`/decks/${encodeURIComponent(deckId)}/filter?restore=1`)}>
          返回筛选
        </button>
      </div>
    </PageShell>
  )
}
