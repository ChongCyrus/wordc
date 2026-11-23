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

/** 0.6.0：并发 1–8；批次 1–50 */
export function clampGenerationConcurrency(value: unknown, fallback = 2): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(8, n))
}

export function clampGenerationBatchSize(value: unknown, fallback = 5): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(1, Math.min(50, n))
}

export interface GenerationJobTarget {
  wordId: string
  headword?: string
  /** 0.6.2：多类型任务每个 target 的记录类型 */
  kind?: string
  /** 0.6.3：目标级唯一标识/含义/本义 */
  targetKey?: string
  meaningId?: string
  meaningIndex?: number
  coreSenseIndex?: number
  coreSenseLabel?: string
  /** 生成上下文（含义/本义等；runner 缺省从 DB 补齐） */
  context?: Record<string, unknown>
}

export interface GenerationJob {
  id: string
  name: string
  kind: GenerationKind | 'root-etymology' | 'rare-meanings'
  /** 0.6.0：多类型任务 */
  kinds?: Array<GenerationKind | 'root-etymology' | 'rare-meanings'>
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
  results: Array<{ wordId?: string; headword?: string; kind?: string; targetKey?: string; at: number; payloadRef?: string }>
  failed: GenerationJobFailedItem[]
  budget?: { estimatedYuan?: number; maxCostPerRun?: number; spentYuan?: number }
  concurrency?: number
  /** 0.6.0：批次大小 1–50 */
  batchSize?: number
  status: GenerationJobStatus
  error?: string
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
}

function targetKeyForJob(target: GenerationJobTarget): string {
  if (target.targetKey) return target.targetKey
  const context = target.context ?? {}
  const meaningIndex =
    typeof target.meaningIndex === 'number'
      ? target.meaningIndex
      : typeof context.meaningIndex === 'number'
        ? context.meaningIndex
        : undefined
  const coreSenseIndex =
    typeof target.coreSenseIndex === 'number'
      ? target.coreSenseIndex
      : typeof context.coreSenseIndex === 'number'
        ? context.coreSenseIndex
        : undefined
  const suffix = meaningIndex != null ? `#m${meaningIndex}` : coreSenseIndex != null ? `#c${coreSenseIndex}` : ''
  return `${target.kind ?? 'item'}:${target.wordId}${suffix}`
}

/** 0.6.3：创建/更新 job 时补齐唯一 targetKey（旧 UI 可能只给 wordId+kind） */
export function normalizeGenerationJobTargets(targets: readonly GenerationJobTarget[]): GenerationJobTarget[] {
  const used = new Map<string, number>()
  return targets.map((target) => {
    const base = targetKeyForJob(target)
    const count = used.get(base) ?? 0
    used.set(base, count + 1)
    const targetKey = count === 0 ? base : `${base}#dup${count + 1}`
    return { ...target, targetKey }
  })
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
  kinds?: readonly (GenerationKind | 'root-etymology' | 'rare-meanings')[]
  batchSize?: number
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
    ...(input.kinds && input.kinds.length > 0 ? { kinds: [...input.kinds] } : {}),
    source: input.source,
    ...(input.filter ? { filter: input.filter } : {}),
    ...(input.targets ? { targets: normalizeGenerationJobTargets(input.targets) } : {}),
    ...(input.config ? { config: input.config } : {}),
    ...(input.sourceWordCount != null ? { sourceWordCount: Math.max(0, input.sourceWordCount) } : {}),
    cursor: 0,
    ...(input.targetTotal != null ? { targetTotal: Math.max(0, input.targetTotal) } : {}),
    results: [],
    failed: [],
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.concurrency != null ? { concurrency: clampGenerationConcurrency(input.concurrency) } : {}),
    ...(input.batchSize != null ? { batchSize: clampGenerationBatchSize(input.batchSize) } : {}),
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
      | 'kinds'
      | 'batchSize'
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
    ...(patch.targets ? { targets: normalizeGenerationJobTargets(patch.targets) } : {}),
    ...(patch.concurrency != null ? { concurrency: clampGenerationConcurrency(patch.concurrency, prev.concurrency ?? 2) } : {}),
    ...(patch.batchSize != null ? { batchSize: clampGenerationBatchSize(patch.batchSize, prev.batchSize ?? 5) } : {}),
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

/** 0.6.2：任务进度语义——processed=cursor（含失败），success=去重 results，failed=failed；
 * completed 时 processed=total，progress=100%，成功/失败单独展示，避免 47/48 误判。 */
export async function getGenerationJobProgress(id: string): Promise<{
  status: GenerationJobStatus
  processed: number
  total: number
  success: number
  failed: number
  percent: number
}> {
  const job = await getGenerationJob(id)
  if (!job) throw new Error(`生成任务不存在：${id}`)
  const total = job.targets?.length ?? job.targetTotal ?? 0
  const success = new Set(
    job.results.map((result) => result.targetKey ?? result.wordId).filter((key): key is string => Boolean(key)),
  ).size
  const processed = Math.min(total > 0 ? total : job.cursor, job.cursor)
  return {
    status: job.status,
    processed,
    total,
    success,
    failed: job.failed.length,
    percent: total > 0 ? Math.round((Math.min(processed, total) / total) * 100) : job.status === 'completed' ? 100 : 0,
  }
}

export async function pauseGenerationJob(id: string): Promise<GenerationJob> {
  return updateGenerationJob(id, { status: 'paused' })
}

/** 取消任务：保留已生成 results/cursor；不可续 */
export async function cancelGenerationJob(id: string): Promise<GenerationJob> {
  return updateGenerationJob(id, { status: 'canceled' })
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
