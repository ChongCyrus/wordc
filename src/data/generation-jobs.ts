/** 0.4.0/task-283 B2：AI 生成任务持久化（各类型共用，重启续跑/命名/删除） */
import { getDb } from './db'
import type { GenerationKind } from './ai/types'

export const GENERATION_JOBS_KEY = 'ai.generationJobs'
export const GENERATION_JOBS_MAX = 100

export type GenerationJobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'canceled'

export interface GenerationJobFailedItem {
  wordId?: string
  headword?: string
  index?: number
  code?: string
  message: string
}

export interface GenerationJobTarget {
  wordId: string
  headword?: string
}

export interface GenerationJob {
  id: string
  name: string
  kind: GenerationKind | 'root-etymology' | 'rare-meanings'
  source: string
  filter?: Record<string, unknown>
  /** 0.5.0：本次任务目标（重启续跑用；旧 job 无此字段） */
  targets?: GenerationJobTarget[]
  /** 0.5.0：生成配置（kinds/排除/batchSize/scope 等） */
  config?: Record<string, unknown>
  /** 0.5.0：来源词数（未截断前） */
  sourceWordCount?: number
  cursor: number
  targetTotal?: number
  results: Array<{ wordId?: string; headword?: string; kind?: string; at: number; payloadRef?: string }>
  failed: GenerationJobFailedItem[]
  budget?: { estimatedYuan?: number; maxCostPerRun?: number; spentYuan?: number }
  concurrency?: number
  status: GenerationJobStatus
  error?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
}

async function readJobs(): Promise<GenerationJob[]> {
  const row = await getDb().meta.get(GENERATION_JOBS_KEY)
  return Array.isArray(row?.value) ? (row.value as GenerationJob[]) : []
}

async function writeJobs(jobs: GenerationJob[]): Promise<void> {
  await getDb().meta.put({ key: GENERATION_JOBS_KEY, value: jobs, updatedAt: Date.now() })
}

export async function listGenerationJobs(): Promise<GenerationJob[]> {
  return (await readJobs()).sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getGenerationJob(id: string): Promise<GenerationJob | null> {
  return (await readJobs()).find((job) => job.id === id) ?? null
}

export async function createGenerationJob(input: {
  name?: string
  kind: GenerationJob['kind']
  source: string
  filter?: Record<string, unknown>
  /** 0.5.0：本次任务目标（重启续跑用；旧 job 无此字段） */
  targets?: GenerationJobTarget[]
  /** 0.5.0：生成配置（kinds/排除/batchSize/scope 等） */
  config?: Record<string, unknown>
  /** 0.5.0：来源词数（未截断前） */
  sourceWordCount?: number
  targetTotal?: number
  budget?: GenerationJob['budget']
  concurrency?: number
}): Promise<GenerationJob> {
  const jobs = await readJobs()
  if (jobs.length >= GENERATION_JOBS_MAX) {
    // 优先淘汰最旧的 completed/failed/canceled
    const removable = jobs.find((job) => ['completed', 'failed', 'canceled'].includes(job.status))
    if (!removable) throw new Error(`生成任务已达上限 ${GENERATION_JOBS_MAX}`)
  }
  const now = Date.now()
  const job: GenerationJob = {
    id: `genjob_${now}_${Math.random().toString(36).slice(2, 8)}`,
    name: input.name?.trim() || `AI 生成任务 ${new Date(now).toLocaleString('zh-CN')}`,
    kind: input.kind,
    source: input.source,
    ...(input.filter ? { filter: input.filter } : {}),
    ...(input.targets ? { targets: input.targets.map((target) => ({ wordId: target.wordId, ...(target.headword ? { headword: target.headword } : {}) })) } : {}),
    ...(input.config ? { config: input.config } : {}),
    ...(input.sourceWordCount != null ? { sourceWordCount: Math.max(0, input.sourceWordCount) } : {}),
    cursor: 0,
    ...(input.targetTotal != null ? { targetTotal: Math.max(0, input.targetTotal) } : {}),
    results: [],
    failed: [],
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.concurrency != null ? { concurrency: input.concurrency } : {}),
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  }
  const next = [job, ...jobs].slice(0, GENERATION_JOBS_MAX)
  await writeJobs(next)
  return job
}

/** 更新任务（命名/状态/cursor/results/failed/budget/concurrency/error） */
export async function updateGenerationJob(
  id: string,
  patch: Partial<
    Pick<
      GenerationJob,
      | 'name'
      | 'status'
      | 'cursor'
      | 'targetTotal'
      | 'results'
      | 'failed'
      | 'budget'
      | 'concurrency'
      | 'error'
      | 'filter'
      | 'source'
      | 'kind'
      | 'targets'
      | 'config'
      | 'sourceWordCount'
    >
  >,
): Promise<GenerationJob> {
  const jobs = await readJobs()
  const index = jobs.findIndex((job) => job.id === id)
  if (index < 0) throw new Error(`生成任务不存在：${id}`)
  const now = Date.now()
  const prev = jobs[index]!
  const status = patch.status ?? prev.status
  const next: GenerationJob = {
    ...prev,
    ...patch,
    ...(patch.name ? { name: patch.name.trim() || prev.name } : {}),
    status,
    updatedAt: now,
    ...(status === 'running' && prev.startedAt == null ? { startedAt: now } : {}),
    ...(['completed', 'failed', 'canceled'].includes(status) ? { finishedAt: now } : {}),
  }
  jobs[index] = next
  await writeJobs(jobs)
  return next
}

export async function appendGenerationJobResult(
  id: string,
  input: {
    wordId?: string
    headword?: string
    kind?: string
    cursor?: number
    result?: GenerationJob['results'][number]
  },
): Promise<GenerationJob> {
  const job = await getGenerationJob(id)
  if (!job) throw new Error(`生成任务不存在：${id}`)
  const results = input.result
    ? [...job.results, input.result]
    : [...job.results, { ...(input.wordId ? { wordId: input.wordId } : {}), ...(input.headword ? { headword: input.headword } : {}), ...(input.kind ? { kind: input.kind } : {}), at: Date.now() }]
  return updateGenerationJob(id, {
    results: results.slice(-5000),
    ...(input.cursor != null ? { cursor: Math.max(job.cursor, input.cursor) } : { cursor: job.cursor + 1 }),
  })
}

export async function appendGenerationJobFailed(id: string, failed: GenerationJobFailedItem): Promise<GenerationJob> {
  const job = await getGenerationJob(id)
  if (!job) throw new Error(`生成任务不存在：${id}`)
  return updateGenerationJob(id, { failed: [...job.failed, failed].slice(-2000) })
}

/** 按 cursor 返回剩余 targets；已完成/无 targets 返回空 */
export async function getGenerationJobPendingTargets(id: string): Promise<GenerationJobTarget[]> {
  const job = await getGenerationJob(id)
  if (!job) throw new Error(`生成任务不存在：${id}`)
  if (job.status === 'completed') return []
  return (job.targets ?? []).slice(Math.max(0, job.cursor))
}

/**
 * 重启续跑：返回 job+targets+config+cursor；running/queued/paused 可续。
 * 旧 job 无 targets → resumable=false（仍返回空数组，避免误以为可续）。
 */
export async function resumeGenerationJob(id: string): Promise<{
  job: GenerationJob
  targets: GenerationJobTarget[]
  config: Record<string, unknown>
  cursor: number
  resumable: boolean
}> {
  const job = await getGenerationJob(id)
  if (!job) throw new Error(`生成任务不存在：${id}`)
  const resumable = job.status !== 'completed' && job.status !== 'canceled' && Array.isArray(job.targets)
  if (!resumable) {
    return { job, targets: [], config: job.config ?? {}, cursor: job.cursor, resumable: false }
  }
  const next = await updateGenerationJob(id, { status: 'running' })
  return {
    job: next,
    targets: (next.targets ?? []).slice(Math.max(0, next.cursor)),
    config: next.config ?? {},
    cursor: next.cursor,
    resumable: true,
  }
}

export async function deleteGenerationJob(id: string): Promise<boolean> {
  const jobs = await readJobs()
  const next = jobs.filter((job) => job.id !== id)
  if (next.length === jobs.length) return false
  await writeJobs(next)
  return true
}

export async function renameGenerationJob(id: string, name: string): Promise<GenerationJob> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('任务名称不能为空')
  return updateGenerationJob(id, { name: trimmed })
}

export async function clearFinishedGenerationJobs(): Promise<number> {
  const jobs = await readJobs()
  const next = jobs.filter((job) => !['completed', 'failed', 'canceled'].includes(job.status))
  await writeJobs(next)
  return jobs.length - next.length
}
