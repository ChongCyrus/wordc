import { useEffect, useState } from 'react'
import {
  clearFinishedGenerationJobs,
  deleteGenerationJob,
  listGenerationJobs,
  renameGenerationJob,
  resumeGenerationJob,
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
  const [jobs, setJobs] = useState<GenerationJob[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = async () => {
    try {
      setJobs(await listGenerationJobs())
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
      toast.success(`任务已恢复，从第 ${result.cursor} 项继续`)
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
                  {STATUS_LABEL[job.status]} · {KIND_LABEL[job.kind] ?? job.kind} · 进度 {job.cursor}/
                  {job.targetTotal ?? '?'} · 成功 {job.results.length} · 失败 {job.failed.length}
                  {job.budget?.spentYuan != null ? ` · 已花费 ¥${job.budget.spentYuan.toFixed(2)}` : ''}
                  {job.concurrency != null ? ` · 并发 ${job.concurrency}` : ''}
                </span>
                {job.error ? <span className="mm-row-sub mm-danger-text">{job.error}</span> : null}
              </span>
              <span className="generation-job-actions">
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
