import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  clearFinishedGenerationJobs,
  deleteGenerationJob,
  listGenerationJobs,
  renameGenerationJob,
  resumeGenerationJob,
  pauseGenerationJob,
  getGenerationJobProgress,
  cancelGenerationJob,
} from '../../data'
import type { GenerationJob } from '../../data'
import { useToast } from '../../app/toast'
import { PageShell } from '../components/PageShell'
import { EmptyState } from '../components/EmptyState'

const STATUS_LABEL: Record<GenerationJob['status'], string> = {
  queued: '排队中',
  running: '进行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
}

const KIND_LABEL: Record<string, string> = {
  examples: '例句',
  phrases: '词组',
  mnemonics: '助记',
  semantics: '语义',
  'root-etymology': '词根词缀词源',
  'rare-meanings': '不常考',
}

/** 0.4.0/task-283 B2：AI 生成任务中心（列表/续跑/命名/删除/清理） */
export default function GenerationJobsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [jobs, setJobs] = useState<GenerationJob[]>([])
  const [loading, setLoading] = useState(true)
  const [progressMap, setProgressMap] = useState<Record<string, { processed: number; total: number; success: number; failed: number; percent: number }>>({})

  const refresh = async () => {
    try {
      const nextJobs = await listGenerationJobs()
      setJobs(nextJobs)
      const entries = await Promise.all(
        nextJobs.map(async (job) => {
          try {
            const progress = await getGenerationJobProgress(job.id)
            return [job.id, progress] as const
          } catch {
            return null
          }
        }),
      )
      const nextProgress: Record<string, { processed: number; total: number; success: number; failed: number; percent: number }> = {}
      for (const entry of entries) {
        if (entry) nextProgress[entry[0]] = entry[1]
      }
      setProgressMap(nextProgress)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取任务失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  const resume = async (job: GenerationJob) => {
    try {
      const result = await resumeGenerationJob(job.id)
      if (!result.resumable) {
        toast.error('旧任务无目标快照，无法续跑；请删除后重建任务')
        await refresh()
        return
      }
      toast.success(`任务已恢复，从第 ${result.cursor} 项继续（剩余 ${result.targets.length} 词）`)
      const deckId = typeof job.filter?.deckId === 'string' ? job.filter.deckId : job.source
      navigate(`/decks/${encodeURIComponent(deckId)}/generate?jobId=${encodeURIComponent(job.id)}`)
      await refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '续跑失败')
    }
  }

  return (
    <PageShell title="AI 生成任务" backTo="/me">
      <div className="mm-btn-row">
        <button type="button" className="mm-btn" onClick={() => void refresh()}>刷新</button>
        <button
          type="button"
          className="mm-btn"
          onClick={() => {
            void clearFinishedGenerationJobs().then((count) => {
              toast.success(`已清理 ${count} 个完成任务`)
              void refresh()
            })
          }}
        >
          清理已完成
        </button>
      </div>
      {loading ? <div className="mm-caption">加载中…</div> : null}
      {!loading && jobs.length === 0 ? (
        <EmptyState title="暂无生成任务" description="在注释面/AI 面板发起批量生成后会出现在这里。" />
      ) : null}
      {jobs.length > 0 ? (
        <div className="mm-list">
          {jobs.map((job) => (
            <div className="mm-row" key={job.id}>
              <span className="mm-row-main">
                <span className="mm-row-title">{job.name}</span>
                <span className="mm-row-sub">
                  {STATUS_LABEL[job.status]} · {KIND_LABEL[job.kind] ?? job.kind} · 进度{' '}
                  {progressMap[job.id]
                    ? `${progressMap[job.id]!.processed}/${progressMap[job.id]!.total}（${progressMap[job.id]!.percent}%）· 成功 ${progressMap[job.id]!.success} · 失败 ${progressMap[job.id]!.failed}`
                    : `${job.cursor}/${job.targetTotal ?? '?'} · 成功 ${job.results.length} · 失败 ${job.failed.length}`}
                  {job.budget?.spentYuan != null ? ` · 已花费 ¥${job.budget.spentYuan.toFixed(2)}` : ''}
                  {job.concurrency != null ? ` · 并发 ${job.concurrency}` : ''}
                  {job.batchSize != null ? ` · 批次 ${job.batchSize}` : ''}
                  {job.kinds?.length ? ` · 类型 ${job.kinds.join('/')}` : ''}
                </span>
                {job.error ? <span className="mm-row-sub mm-danger-text">{job.error}</span> : null}
              </span>
              <span className="generation-job-actions">
                {job.status === 'running' || job.status === 'queued' ? (
                  <button
                    type="button"
                    className="mm-btn mm-btn--sm"
                    onClick={() => {
                      void pauseGenerationJob(job.id)
                        .then(refresh)
                        .catch((error) => toast.error(error instanceof Error ? error.message : '暂停失败'))
                    }}
                  >
                    暂停
                  </button>
                ) : null}
                {!['completed', 'canceled'].includes(job.status) ? (
                  <button
                    type="button"
                    className="mm-btn mm-btn--sm"
                    onClick={() => {
                      void cancelGenerationJob(job.id)
                        .then(refresh)
                        .catch((error) => toast.error(error instanceof Error ? error.message : '取消失败'))
                    }}
                  >
                    取消
                  </button>
                ) : null}
                {job.status !== 'completed' && job.status !== 'running' ? (
                  <button type="button" className="mm-btn mm-btn--sm" onClick={() => void resume(job)}>
                    继续
                  </button>
                ) : null}
                <button
                  type="button"
                  className="mm-btn mm-btn--sm"
                  onClick={() => {
                    const name = window.prompt('任务名称', job.name)
                    if (!name || name.trim() === job.name) return
                    void renameGenerationJob(job.id, name)
                      .then(refresh)
                      .catch((error) => toast.error(error instanceof Error ? error.message : '重命名失败'))
                  }}
                >
                  重命名
                </button>
                <button
                  type="button"
                  className="mm-btn mm-btn--sm"
                  onClick={() => {
                    void deleteGenerationJob(job.id).then(refresh)
                  }}
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </PageShell>
  )
}
