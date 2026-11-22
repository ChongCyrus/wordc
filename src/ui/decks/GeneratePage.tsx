import { useEffect, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { getGenerationJob, getGenerationJobPendingTargets } from '../../data'
import type { GenerationJob } from '../../data'
import { AiGeneratePanel } from '../ai/AiGeneratePanel'
import { useToast } from '../../app/toast'

interface FilterGenerateSeed {
  deckId?: string
  wordIds?: string[]
  sourceLabel?: string
}

/** 0.5.0：高级筛选 → AI 生成页；支持 jobId 断点续跑入口 */
export default function GeneratePage() {
  const { deckId = '' } = useParams()
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const toast = useToast()
  const jobId = params.get('jobId')
  const [seed, setSeed] = useState<FilterGenerateSeed | null>(null)
  const [job, setJob] = useState<GenerationJob | null>(null)
  const [ready, setReady] = useState(false)

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

  if (!ready) return <div className="mm-page mm-caption">读取任务中…</div>

  const sourceLabel = job
    ? `续跑任务「${job.name}」· 进度 ${job.cursor}/${job.targetTotal ?? '?'} · ${job.kind}`
    : seed?.sourceLabel

  return (
    <>
      {!seed && !job ? (
        <div className="mm-page mm-caption">未找到生成来源，请从高级筛选选择词后进入。</div>
      ) : null}
      <AiGeneratePanel
        open={Boolean(seed || job)}
        initialScope="custom"
        initialSelectedWordIds={seed?.wordIds ?? []}
        {...(sourceLabel ? { sourceLabel } : {})}
        {...(jobId ? { resumeJobId: jobId } : {})}
        onClose={() => navigate(`/decks/${encodeURIComponent(deckId)}/filter?restore=1`)}
      />
    </>
  )
}
