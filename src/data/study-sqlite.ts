/** 0.11.0 M4b-2-1：submitRating 的 SQLite 单事务实现（states/plans/reviewLogs/client_ops） */
import { localDateKey, scheduleNext } from '../core'
import type { Rating, WordState } from '../core'
import type { ReviewLogV2 } from './plan.types'
import type { DailyPlan } from './plan.types'
import { applyRatingToPlan } from './plan-core'
import { buildInitialState } from './word-factory'
import { getDb } from './db'
import { isSqliteAvailable, sqliteQuery, sqliteTx } from './native-sqlite'
import { SQLITE_SCHEMA_VERSION } from './sqlite-store'
import { mapSqliteReviewLogRow, readPlanThroughCache, readStateThroughCache } from './sqlite-read'
import { withDataWriteLock } from './write-lock'
import { getLearningWriteSource, LearningWriteReadonlyError, LearningWriteRetryableError } from './learning-write-source'

/** 进程内幂等重放缓存：同一 clientOpId 在本次会话重复提交不再走原生查询/事务。 */
const ratingReplayCache = new Map<string, SubmitRatingSqliteResult>()
const RATING_REPLAY_CACHE_MAX = 32

export interface SubmitRatingSqliteOptions {
  planId?: string
  clientOpId?: string
  scheduleMode?: 'normal' | 'skip'
  epoch?: number
}

export interface SubmitRatingSqliteResult {
  state: WordState
  log: ReviewLogV2
  intervalDays: number
  longTermUpdate: boolean
  requeue: 'requeue-forgot' | 'requeue-vague' | 'none'
  idempotentReplay?: boolean
}

export function buildStateSqliteRow(state: WordState): Record<string, unknown> {
  return stateRow(state)
}

function stateRow(state: WordState): Record<string, unknown> {
  return {
    word_id: state.wordId, deck_id: state.deckId, phase: state.phase,
    stability: state.stability, difficulty: state.difficulty, reps: state.reps, lapses: state.lapses,
    first_seen_at: state.firstSeenAt, last_reviewed_at: state.lastReviewedAt, due_at: state.dueAt,
    next_interval_days: state.nextIntervalDays, retrievability: state.retrievability,
    last_rating: state.lastRating, same_day_count: state.sameDayCount, same_day_date: state.sameDayDate,
    today_progress: state.todayProgress ?? null, today_progress_level: state.todayProgressLevel ?? null,
    can_finish_today: state.canFinishToday == null ? null : state.canFinishToday ? 1 : 0,
    meaning_stats_json: JSON.stringify(state.meaningStats ?? {}),
    core_sense_stats_json: state.coreSenseStats ? JSON.stringify(state.coreSenseStats) : null,
    part_stats_json: state.partStats ? JSON.stringify(state.partStats) : null,
    same_day_requeued: state.sameDayRequeued,
    imported_from: state.importedFrom ?? null, imported_at: state.importedAt ?? null,
    created_at: state.createdAt, updated_at: state.updatedAt,
  }
}

export function buildReviewLogSqliteRow(log: ReviewLogV2, opId: string, now: number): Record<string, unknown> {
  return {
    word_id: log.wordId,
    deck_id: log.deckId,
    rating: log.rating,
    reviewed_at: log.reviewedAt ?? now,
    stability_before: log.stabilityBefore ?? null,
    difficulty_before: log.difficultyBefore ?? null,
    stability_after: log.stabilityAfter ?? null,
    difficulty_after: log.difficultyAfter ?? null,
    elapsed_days: log.elapsedDays ?? null,
    next_interval_days: log.nextIntervalDays ?? null,
    retrievability_at_review: log.retrievabilityAtReview ?? null,
    long_term_update: log.longTermUpdate ? 1 : 0,
    corrected: log.corrected ? 1 : 0,
    corrected_by: log.correctedBy ?? null,
    state_before_json: log.stateBefore ? JSON.stringify(log.stateBefore) : null,
    meaning_changes_json: (log as unknown as { meaningChanges?: unknown }).meaningChanges ? JSON.stringify((log as unknown as { meaningChanges?: unknown }).meaningChanges) : null,
    phase_before: (log as unknown as { phaseBefore?: string }).phaseBefore ?? null,
    phase_after: (log as unknown as { phaseAfter?: string }).phaseAfter ?? null,
    client_op_id: opId,
  }
}

function planRow(plan: DailyPlan): Record<string, unknown> {
  return {
    id: plan.id, date: plan.date, deck_id: plan.deckId,
    word_ids_json: JSON.stringify(plan.wordIds), idx: plan.index,
    sources_json: JSON.stringify(plan.sources ?? {}), goals_json: JSON.stringify(plan.goals ?? {}),
    ratings_json: JSON.stringify(plan.ratings ?? []),
    wc_counts_json: plan.wcCounts ? JSON.stringify(plan.wcCounts) : null,
    completed_at: plan.completedAt != null && Number(plan.completedAt) > 0 ? plan.completedAt : null,
    created_at: plan.createdAt, updated_at: plan.updatedAt,
  }
}

async function ensureSqliteMode(): Promise<void> {
  const source = getLearningWriteSource()
  if (source === 'sqlite') return
  if (source === 'readonly') throw new LearningWriteReadonlyError('学习数据库处于只读恢复模式，请到诊断/备份恢复')
  throw new LearningWriteRetryableError('学习写源尚未切换到 SQLite')
}

/** 同一 opId 重放返回首次结果，不重复写 */
let ratingCacheTask: Promise<void> = Promise.resolve()
let ratingCacheChain: Promise<void> = Promise.resolve()
let ratingCacheSeq = 0
const ratingCacheEvents: string[] = []
export function getRatingCacheDebugEvents(): string[] { return [...ratingCacheEvents] }

/** task-299：等待后台 IDB cache 回填（测试/退出前用） */
export async function flushRatingCacheWarmup(): Promise<void> { await ratingCacheTask }

export async function submitRatingSqlite(
  wordId: string,
  rating: Rating,
  now: number = Date.now(),
  opts: SubmitRatingSqliteOptions = {},
): Promise<SubmitRatingSqliteResult> {
  await ensureSqliteMode()
  return withDataWriteLock(async () => {
    if (!isSqliteAvailable()) throw new LearningWriteRetryableError('SQLite 不可用，进入只读恢复')
    const db = getDb()
    let word = await db.words.get(wordId)
    if (!word) {
      try {
        const { ensureBuiltinDeckWords } = await import('./builtin')
        await ensureBuiltinDeckWords(wordId.split(':')[0] ?? '')
        word = await db.words.get(wordId)
      } catch {
        /* fallthrough */
      }
    }
    if (!word) throw new Error(`词条不存在：${wordId}`)
    const opId = opts.clientOpId ?? `rating-${wordId}-${now}`
    const replay = ratingReplayCache.get(opId)
    if (replay) return { ...replay, idempotentReplay: true }
    // 显式传入的 clientOpId 才做跨重启幂等回查；默认 opId 每次唯一，避免每次评分多一次原生查询
    if (opts.clientOpId) {
      const cached = await sqliteQuery({ table: 'client_ops', where: { op_id: opId }, limit: 1 }, 5_000).catch(() => null)
      const row = ((cached?.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
      if (row?.result_json) return { ...(JSON.parse(String(row.result_json)) as SubmitRatingSqliteResult), idempotentReplay: true }
    }
    // 性能/安全：cache 可用时读 IDB；dirty 时自动回源 SQLite（readStateThroughCache 内含门禁）
    const existingState = await readStateThroughCache(wordId, 'high')
    const stateBefore = existingState ? { ...existingState } : null
    const prev = existingState ?? buildInitialState(word, now)
    const result = scheduleNext(prev, rating, now, undefined, { scheduleMode: opts.scheduleMode === 'skip' ? 'skip' : 'normal' })
    const state: WordState = { ...result.state, updatedAt: now }
    const logInput: ReviewLogV2 = { ...result.log, stateBefore }
    delete logInput.id
    let nextPlan: DailyPlan | null = null
    if (opts.planId && opts.scheduleMode !== 'skip') {
      // 性能/安全：cache 可用时读 IDB；dirty 时自动回源 SQLite（readPlanThroughCache 内含门禁）
      const plan = await readPlanThroughCache(opts.planId, 'high')
      if (plan) {
        const failedLastTime = prev.lastRating === 'vague' || prev.lastRating === 'forgot'
        const forceOneMoreRecall = result.requeue === 'none' && result.completesToday && !result.longTermUpdate && failedLastTime && (prev.todayProgress ?? 0) < 1
        const forceRequeueOnRequeuedOccurrence = rating === 'familiar' && !result.longTermUpdate && failedLastTime && plan.sources[wordId] === 'requeue'
        const insertRequeue = result.requeue !== 'none' || result.completesToday === false || forceOneMoreRecall || forceRequeueOnRequeuedOccurrence
        nextPlan = applyRatingToPlan(plan, { wordId, rating, reviewedAt: now, longTermUpdate: result.longTermUpdate, insertRequeue })
      }
    }
    const ops: unknown[] = [
      { op: 'upsert', table: 'states', row: stateRow(state) },
      {
        op: 'insert',
        table: 'review_logs',
        row: buildReviewLogSqliteRow({ ...logInput, wordId, deckId: state.deckId }, opId, now),
      },
    ]
    if (nextPlan) ops.push({ op: 'upsert', table: 'plans', row: planRow(nextPlan) })
    const persistedResult: SubmitRatingSqliteResult = {
      state,
      log: { ...logInput, id: 0 } as ReviewLogV2,
      intervalDays: state.nextIntervalDays,
      longTermUpdate: result.longTermUpdate,
      requeue: result.requeue,
    }
    ops.push({ op: 'insert', table: 'client_ops', row: { op_id: opId, kind: 'submit-rating', at: now, result_json: JSON.stringify(persistedResult) } })
    const expect = { userVersion: SQLITE_SCHEMA_VERSION, ...(opts.epoch != null ? { dataEpoch: opts.epoch } : {}) }
    let tx = await sqliteTx(ops, { expect, priority: 'high' })
    if (tx.ok === false && (tx as { code?: string }).code === 'E_CONFLICT') {
      // epoch 冲突：重试一次（事务未提交，安全）
      tx = await sqliteTx(ops, { expect, priority: 'high' })
    }
    if (tx.ok === false) {
      const code = (tx as { code?: string }).code
      if (code === 'E_CONFLICT' || code === 'E_BUSY') throw new LearningWriteRetryableError(tx.message ?? 'SQLite 繁忙，请重试')
      throw new Error(tx.message ?? '评分 SQLite 事务失败')
    }
    // P0：tx 已提交；返回前先置 dirty（保留两个小 IDB 操作），避免下一次评分读到旧 cache
    const idbCache = await import('./idb-cache')
    const cacheMetaBefore = await idbCache.getIdbCacheMeta().catch(() => null)
    await idbCache.markIdbCacheDirty('rating-tx-committed')
    // task-299：review_logs 回查 + IDB cache 写移到后台；按 promise 链串行，只有最新序号清 dirty
    const seq = ++ratingCacheSeq
    const runCache = async () => {
      ratingCacheEvents.push(`start:${seq}`)
      try {
        const date = localDateKey(now)
        let cachedLog = persistedResult.log
        try {
          const logResponse = await sqliteQuery({ table: 'review_logs', where: { client_op_id: opId }, limit: 1 }, 5_000, 'high')
          const logRaw = ((logResponse.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
          if (logRaw) cachedLog = mapSqliteReviewLogRow(logRaw) as unknown as ReviewLogV2
        } catch {
          /* fallback */
        }
        await db.transaction('rw', db.states, db.plans, db.reviewLogs, db.meta, async () => {
          await db.states.put(state)
          if (nextPlan) await db.plans.put(nextPlan)
          if (cachedLog) await db.reviewLogs.put(cachedLog as never)
          await db.meta.put({ key: 'lastStudyDate', value: date, updatedAt: now })
        })
        if (seq === ratingCacheSeq) {
          // C-06：compare-and-clear；期间若其它写失败把 dirty 原因改掉，不清
          const current = await idbCache.getIdbCacheMeta().catch(() => null)
          const stillOurs = current?.dirty === true && current.reason === 'rating-tx-committed'
          if (stillOurs) await idbCache.clearIdbCacheDirty(cacheMetaBefore ?? { generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false })
          else await idbCache.markIdbCacheDirty('rating-cache-preserved-other-dirty')
        } else {
          await idbCache.markIdbCacheDirty('rating-cache-newer-pending')
        }
      } catch {
        const { markIdbCacheDirty } = await import('./idb-cache')
        await markIdbCacheDirty('rating-cache-write-failed').catch(() => undefined)
      } finally {
        ratingCacheEvents.push(`end:${seq}`)
        if (ratingCacheEvents.length > 200) ratingCacheEvents.splice(0, ratingCacheEvents.length - 200)
      }
    }
    const chained = ratingCacheChain.then(runCache, runCache)
    ratingCacheChain = chained.catch(() => undefined)
    ratingCacheTask = chained
    const { notifySqliteFactsChanged } = await import('./sqlite-checkpoint')
    notifySqliteFactsChanged(2000)
    const finalResult = persistedResult
    ratingReplayCache.set(opId, finalResult)
    if (ratingReplayCache.size > RATING_REPLAY_CACHE_MAX) {
      const oldest = ratingReplayCache.keys().next().value
      if (oldest !== undefined) ratingReplayCache.delete(oldest)
    }
    return finalResult
  })
}

/** arch 单 tx reRate 用：纯构造 submitRating tx ops */
export function buildSubmitRatingTxOps(input: {
  state: import('../core').WordState
  logInput: import('./plan.types').ReviewLogV2
  plan: import('./plan.types').DailyPlan | null
  opId: string
  now: number
  kind?: string
  resultJson?: string
}): unknown[] {
  const state = input.state
  const ops: unknown[] = [
    { op: 'upsert', table: 'states', row: stateRow(state) },
    {
      op: 'insert',
      table: 'review_logs',
      row: buildReviewLogSqliteRow(input.logInput, input.opId, input.now),
    },
  ]
  if (input.plan) ops.push({ op: 'upsert', table: 'plans', row: planRow(input.plan) })
  const result = input.resultJson ?? JSON.stringify({
    state,
    log: { ...input.logInput, id: 0 },
    intervalDays: state.nextIntervalDays,
    longTermUpdate: Boolean(input.logInput.longTermUpdate),
    requeue: 'none',
    planIndex: input.plan?.index,
  })
  ops.push({ op: 'insert', table: 'client_ops', row: { op_id: input.opId, kind: input.kind ?? 'submit-rating', at: input.now, result_json: result } })
  return ops
}
