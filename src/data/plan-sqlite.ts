/** 0.11.0 M4b-2-1：plan-only 简单写操作 SQLite 事务（save/setIndex/complete/clear） */
import type { DailyPlan } from './plan.types'
import type { Rating, WordState } from '../core'
import type { ReviewLogV2 } from './plan.types'
import { buildInitialState } from './word-factory'
import { buildStateSqliteRow } from './study-sqlite'
import { applyRatingToPlan, undoInPlan } from './plan-core'
import { localDateKey, scheduleNext } from '../core'
import { getDb } from './db'
import { isSqliteAvailable, sqliteQuery, sqliteTx } from './native-sqlite'
import { mapSqlitePlanRow, mapSqliteReviewLogRow } from './sqlite-read'
import { withDataWriteLock } from './write-lock'
import { getLearningWriteSource, LearningWriteReadonlyError, LearningWriteRetryableError } from './learning-write-source'
import { buildSubmitRatingTxOps } from './study-sqlite'

export function planRow(plan: DailyPlan): Record<string, unknown> {
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

function notifyPlanUpdated(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event('momo:plan-updated'))
}

async function writePlanSqlite(plan: DailyPlan, opts: { clientOpId?: string; kind?: string } = {}): Promise<void> {
  if (getLearningWriteSource() === 'readonly') throw new LearningWriteReadonlyError('学习数据库只读恢复模式，拒绝 plan 写')
  if (!isSqliteAvailable()) throw new LearningWriteRetryableError('SQLite 不可用，进入只读恢复')
  if (getLearningWriteSource() && getLearningWriteSource() !== 'sqlite' && getLearningWriteSource() !== 'readonly') {
    // 未切 SQLite 时仍走原 IDB 路径（由调用方决定）
    throw new LearningWriteRetryableError('学习写源不是 sqlite')
  }
  const ops: unknown[] = [{ op: 'upsert', table: 'plans', row: planRow(plan) }]
  if (opts.clientOpId) ops.push({ op: 'insert', table: 'client_ops', row: { op_id: opts.clientOpId, kind: opts.kind ?? 'plan-only', at: Date.now(), result_json: JSON.stringify({ planId: plan.id, index: plan.index, wordIdsLength: plan.wordIds.length }) } })
  const tx = await sqliteTx(ops, { priority: 'high' })
  if (tx.ok === false) throw new LearningWriteRetryableError(tx.message ?? 'plan SQLite 写失败')
  const metaBefore = await (await import('./idb-cache')).getIdbCacheMeta().catch(() => null)
  await (await import('./idb-cache')).markIdbCacheDirty('plan-tx-committed').catch(() => undefined)
  try {
    await getDb().plans.put(plan)
    notifyPlanUpdated()
    await (await import('./idb-cache')).clearIdbCacheDirty(metaBefore ?? { generation: 0, sqliteUserVersion: 3, dirty: false }).catch(() => undefined)
  } catch {
    const { markIdbCacheDirty } = await import('./idb-cache')
    await markIdbCacheDirty('plan-cache-write-failed').catch(() => undefined)
  }
}

export async function savePlanSqlite(plan: DailyPlan, clientOpId?: string): Promise<void> {
  return withDataWriteLock(() => writePlanSqlite(plan, { ...(clientOpId ? { clientOpId } : {}) }))
}

export async function setPlanIndexSqlite(planId: string, index: number, now = Date.now()): Promise<DailyPlan> {
  return withDataWriteLock(async () => {
    const response = await sqliteQuery({ table: 'plans', where: { id: planId }, limit: 1 }, 5_000, 'high')
    const raw = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    if (!raw) throw new Error('plan 不存在')
    const plan = mapSqlitePlanRow(raw)
    const next = { ...plan, index: Math.max(0, Math.min(Math.floor(index), plan.wordIds.length)), updatedAt: now }
    await writePlanSqlite(next, { kind: 'set-plan-index' })
    return next
  })
}

export async function completePlanSqlite(planId: string, now = Date.now()): Promise<DailyPlan> {
  return withDataWriteLock(async () => {
    const response = await sqliteQuery({ table: 'plans', where: { id: planId }, limit: 1 }, 5_000, 'high')
    const raw = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    if (!raw) throw new Error('plan 不存在')
    const plan = mapSqlitePlanRow(raw)
    const next = { ...plan, index: plan.wordIds.length, completedAt: plan.completedAt ?? now, updatedAt: now }
    await writePlanSqlite(next, { kind: 'complete-plan' })
    return next
  })
}

export async function clearPlanSqlite(planId: string): Promise<void> {
  if (getLearningWriteSource() === 'readonly') throw new LearningWriteReadonlyError('学习数据库只读恢复模式')
  if (!isSqliteAvailable()) throw new LearningWriteRetryableError('SQLite 不可用')
  return withDataWriteLock(async () => {
    const tx = await sqliteTx([{ op: 'delete', table: 'plans', where: { id: planId } }])
    if (tx.ok === false) throw new LearningWriteRetryableError(tx.message ?? 'plan 删除失败')
    await getDb().plans.delete(planId).catch(async () => {
      const { markIdbCacheDirty } = await import('./idb-cache')
      await markIdbCacheDirty('plan-delete-cache-failed').catch(() => undefined)
    })
  })
}

/** 复杂 plan-only（append/remove/undo）在 M4b-2-2 前禁止 sqlite 双源，明确可重试 */
export function assertComplexPlanWriteSupported(): void {
  if (getLearningWriteSource() === 'readonly') throw new LearningWriteReadonlyError('学习数据库只读恢复模式')
  if (getLearningWriteSource() === 'sqlite') throw new LearningWriteReadonlyError('复杂 plan-only 写尚未切换')
}

/** 复杂 plan-only：append 今日队列（SQLite 单 tx + clientOpId + cache） */
export async function appendWordsToTodayPlanSqlite(
  input: { wordIds: string[]; source?: 'manual' | 'random' | 'order'; allowRepeat?: boolean; clientOpId?: string },
  now = Date.now(),
): Promise<{ added: number; requested: number; plan: DailyPlan }> {
  return withDataWriteLock(async () => {
    const settings = await (await import('./settings.repo')).getSettings()
    const deckId = settings['data.selectedDeckId']
      if (!deckId) throw new Error('未选择词库')
    const { planIdOf } = await import('./plan-core')
    const { localDateKey } = await import('../core')
    const planId = planIdOf(localDateKey(now), deckId)
    const response = await sqliteQuery({ table: 'plans', where: { id: planId }, limit: 1 }, 5_000, 'high')
    const raw = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    const db = getDb()
    const plan = raw ? mapSqlitePlanRow(raw) : null
    if (!plan) throw new Error('今日计划不存在')
    const ids = [...new Set(input.wordIds.filter((id) => typeof id === 'string' && id.length > 0))]
    const words = await db.words.bulkGet(ids)
    const byId = new Map(words.filter(Boolean).map((word) => [word!.id, word!]))
    const states = await db.states.where('deckId').equals(deckId).toArray()
    const learned = new Set(states.filter((state) => state.phase !== 'new').map((state) => state.wordId))
    const existing = new Set(plan.wordIds)
    const accepted: string[] = []
    for (const id of ids) {
      const word = byId.get(id)
      if (!word || word.deckId !== deckId) continue
      if (input.allowRepeat !== true && (learned.has(id) || existing.has(id))) continue
      accepted.push(id)
    }
    const requested = input.wordIds.length
    if (accepted.length === 0) return { added: 0, requested, plan }
    const sources = { ...plan.sources }
    for (const id of accepted) sources[id] = input.source ?? 'manual'
    const next: DailyPlan = { ...plan, wordIds: [...plan.wordIds, ...accepted], sources, completedAt: null, updatedAt: now }
    await writePlanSqlite(next, { ...(input.clientOpId ? { clientOpId: input.clientOpId } : {}), kind: 'append-words' })
    return { added: accepted.length, requested, plan: next }
  })
}

/** 复杂 plan-only：remove 未学自动新词（SQLite 单 tx + cache） */
export async function removeUnlearnedAutoNewWordsSqlite(now = Date.now()): Promise<{ removed: number; plan: DailyPlan }> {
  return withDataWriteLock(async () => {
    const settings = await (await import('./settings.repo')).getSettings()
    const deckId = settings['data.selectedDeckId']
      if (!deckId) throw new Error('未选择词库')
    const { planIdOf } = await import('./plan-core')
    const { localDateKey } = await import('../core')
    const planId = planIdOf(localDateKey(now), deckId)
    const response = await sqliteQuery({ table: 'plans', where: { id: planId }, limit: 1 }, 5_000, 'high')
    const raw = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    const plan = raw ? mapSqlitePlanRow(raw) : null
    if (!plan) throw new Error('今日计划不存在')
    const db = getDb()
    const states = await db.states.where('deckId').equals(deckId).toArray()
    const learned = new Set(states.filter((state) => state.phase !== 'new').map((state) => state.wordId))
    const rated = new Set(plan.ratings.filter((rating) => !rating.corrected).map((rating) => rating.wordId))
    const removed = new Set<string>()
    for (const wordId of plan.wordIds) {
      if (plan.sources[wordId] !== 'goal') continue
      if (learned.has(wordId) || rated.has(wordId)) continue
      removed.add(wordId)
    }
    if (removed.size === 0) return { removed: 0, plan }
    const wordIds = plan.wordIds.filter((wordId) => !removed.has(wordId))
    const sources = { ...plan.sources }
    for (const wordId of removed) delete sources[wordId]
    let index = 0
    for (let i = 0; i < Math.min(plan.index, plan.wordIds.length); i += 1) if (!removed.has(plan.wordIds[i]!)) index += 1
    const next: DailyPlan = { ...plan, wordIds, sources, index, completedAt: null, updatedAt: now }
    await writePlanSqlite(next, { kind: 'remove-auto-new' })
    return { removed: removed.size, plan: next }
  })
}

/** undo SQLite 单事务：恢复/删除 state、log corrected、plan 回退、client_ops 幂等 */
export async function undoLastRatingSqlite(input: {
  wordId: string
  planId?: string
  now?: number
  clientOpId?: string
}): Promise<{ state: WordState; plan: DailyPlan; logId?: number } | null> {
  return withDataWriteLock(async () => {
    const now = input.now ?? Date.now()
    const db = getDb()
    const { localDateKey } = await import('../core')
    const today = localDateKey(now)
    const logsResponse = await sqliteQuery({ table: 'review_logs', where: { word_id: input.wordId }, limit: 50 }, 5_000, 'high')
    const logs = ((logsResponse.rows as Array<Record<string, unknown>> | undefined) ?? []).map(mapSqliteReviewLogRow)
    const candidate = logs
      .filter((log) => {
        const reviewedAt = Number((log as { reviewedAt?: number }).reviewedAt ?? 0)
        return localDateKey(reviewedAt) === today && (log as { corrected?: boolean }).corrected !== true
      })
      .sort((a, b) => Number((b as { reviewedAt?: number }).reviewedAt ?? 0) - Number((a as { reviewedAt?: number }).reviewedAt ?? 0))[0]
    if (!candidate) return null
    const stateBefore = (candidate as { stateBefore?: WordState | null }).stateBefore ?? null
    const logId = (candidate as { id?: number }).id
    const planId = input.planId
    const planResponse = planId ? await sqliteQuery({ table: 'plans', where: { id: planId }, limit: 1 }, 5_000, 'high') : { ok: true, rows: [] as unknown[] }
    const planRaw = ((planResponse.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    const plan = planRaw ? mapSqlitePlanRow(planRaw) : null
    const ops: unknown[] = []
    if (logId != null) ops.push({ op: 'update', table: 'review_logs', where: { id: logId }, patch: { corrected: 1 } })
    let restoredState: WordState
    if (stateBefore == null) {
      ops.push({ op: 'delete', table: 'states', where: { word_id: input.wordId } })
      const word = await db.words.get(input.wordId)
      if (!word) throw new Error(`词条不存在：${input.wordId}`)
      restoredState = { ...buildInitialState(word, now) }
    } else {
      restoredState = { ...stateBefore }
      ops.push({ op: 'upsert', table: 'states', row: buildStateSqliteRow(restoredState) })
    }
    let nextPlan: DailyPlan | null = plan
    if (plan) {
      const undone = (await import('./plan-core')).undoInPlan(plan, { wordId: input.wordId, reviewedAt: Number((candidate as { reviewedAt?: number }).reviewedAt ?? now) })
      nextPlan = undone.removed ? undone.plan : { ...plan, completedAt: null, updatedAt: now }
      ops.push({ op: 'upsert', table: 'plans', row: planRow(nextPlan) })
    }
    const opId = input.clientOpId ?? `undo-${input.wordId}-${logId ?? now}`
    try {
      const replay = await sqliteQuery({ table: 'client_ops', where: { op_id: opId }, limit: 1 }, 5_000, 'high')
      if (((replay.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]) {
        return nextPlan ? { state: restoredState, plan: nextPlan, ...(logId != null ? { logId } : {}) } : null
      }
    } catch {
      /* continue */
    }
    ops.push({ op: 'insert', table: 'client_ops', row: { op_id: opId, kind: 'undo-rating', at: now, result_json: JSON.stringify({ wordId: input.wordId, logId: logId ?? null }) } })
    const tx = await sqliteTx(ops, { priority: 'high' })
    if (tx.ok === false) throw new LearningWriteRetryableError(tx.message ?? 'undo SQLite 失败')
    try {
      await db.transaction('rw', db.states, db.plans, async () => {
        if (stateBefore == null) await db.states.delete(input.wordId)
        else await db.states.put(restoredState)
        if (nextPlan) await db.plans.put(nextPlan)
        await db.reviewLogs.put({ ...(candidate as unknown as ReviewLogV2), corrected: true, reverted: true } as never)
      })
    } catch {
      const { markIdbCacheDirty } = await import('./idb-cache')
      await markIdbCacheDirty('undo-cache-write-failed').catch(() => undefined)
    }
    return nextPlan ? { state: restoredState, plan: nextPlan, ...(logId != null ? { logId } : {}) } : null
  })
}

export async function reRateInPlanSqlite(input: {
  wordId: string
  rating: Rating
  now?: number
  planId?: string
  clientOpId?: string
}): Promise<{ state: WordState; plan: DailyPlan } | null> {
  return withDataWriteLock(async () => {
    if (getLearningWriteSource() === 'readonly') throw new LearningWriteReadonlyError('学习数据库只读恢复模式')
    if (!isSqliteAvailable()) throw new LearningWriteRetryableError('SQLite 不可用')
    const now = input.now ?? Date.now()
    const db = getDb()
    const today = localDateKey(now)
    const opId = input.clientOpId ?? `rerate-${input.wordId}-${now}`
    try {
      const replay = await sqliteQuery({ table: 'client_ops', where: { op_id: opId }, limit: 1 }, 5_000, 'high')
      const cached = ((replay.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
      if (cached?.result_json) {
        const parsed = JSON.parse(String(cached.result_json)) as { state: WordState; plan: DailyPlan }
        return { state: parsed.state, plan: parsed.plan }
      }
    } catch {
      /* 继续 */
    }
    const word = await db.words.get(input.wordId)
    if (!word) throw new Error(`词条不存在：${input.wordId}`)
    const logsResponse = await sqliteQuery({ table: 'review_logs', where: { word_id: input.wordId }, limit: 50 }, 5_000, 'high')
    const logs = ((logsResponse.rows as Array<Record<string, unknown>> | undefined) ?? []).map(mapSqliteReviewLogRow) as unknown as Array<ReviewLogV2 & { id?: number; reviewedAt: number; stateBefore?: WordState | null }>
    const candidate = logs
      .filter((log) => localDateKey(Number(log.reviewedAt ?? 0)) === today && log.corrected !== true)
      .sort((a, b) => Number(b.reviewedAt ?? 0) - Number(a.reviewedAt ?? 0))[0]
    if (!candidate) return null
    const planId = input.planId
    if (!planId) return null
    const planResponse = await sqliteQuery({ table: 'plans', where: { id: planId }, limit: 1 }, 5_000, 'high')
    const planRaw = ((planResponse.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    if (!planRaw) return null
    const plan = mapSqlitePlanRow(planRaw)
    // 1) undo 计算（先撤销旧 log/state/plan）
    const oldStateBefore = (candidate.stateBefore ?? null) as WordState | null
    const prev = oldStateBefore ?? buildInitialState(word, now)
    const undone = undoInPlan(plan, { wordId: input.wordId, reviewedAt: Number(candidate.reviewedAt ?? now) })
    const planAfterUndo: DailyPlan = undone.removed ? undone.plan : { ...plan, completedAt: null, updatedAt: now }
    // 2) 新 rating 计算（与 submitRatingSqlite 同语义）
    const scheduled = scheduleNext(prev, input.rating, now, undefined, { scheduleMode: 'normal' })
    const state: WordState = { ...scheduled.state, updatedAt: now }
    const logInput: ReviewLogV2 = { ...scheduled.log, stateBefore: oldStateBefore }
    delete logInput.id
    const failedLastTime = prev.lastRating === 'vague' || prev.lastRating === 'forgot'
    const forceOneMoreRecall = scheduled.requeue === 'none' && scheduled.completesToday && !scheduled.longTermUpdate && failedLastTime && (prev.todayProgress ?? 0) < 1
    const forceRequeueOnRequeuedOccurrence = input.rating === 'familiar' && !scheduled.longTermUpdate && failedLastTime && planAfterUndo.sources[input.wordId] === 'requeue'
    const insertRequeue = scheduled.requeue !== 'none' || scheduled.completesToday === false || forceOneMoreRecall || forceRequeueOnRequeuedOccurrence
    const nextPlan = applyRatingToPlan(planAfterUndo, {
      wordId: input.wordId,
      rating: input.rating,
      reviewedAt: now,
      longTermUpdate: scheduled.longTermUpdate,
      insertRequeue,
    })
    const persisted = { state, plan: nextPlan }
    // 复用 undo + submit 的纯 ops 构造；只由 submit helper 写一个 client_ops（reRate opId）。
    const undoOps = buildUndoRatingTxOps({
      logId: candidate.id ?? null,
      stateBefore: oldStateBefore,
      restoredState: prev,
      plan: null,
    })
    const submitOps = buildSubmitRatingTxOps({
      state,
      logInput,
      plan: nextPlan,
      opId,
      now,
      kind: 're-rate',
      resultJson: JSON.stringify(persisted),
    })
    const ops: unknown[] = [...undoOps, ...submitOps]
    const tx = await sqliteTx(ops, { priority: 'high' })
    if (tx.ok === false) throw new LearningWriteRetryableError(tx.message ?? 'reRate SQLite 事务失败')
    // 3) 一次性 cache 同步（states/plan/log + 旧 log corrected）
    let cachedLog: ReviewLogV2 = { ...logInput, id: 0 } as ReviewLogV2
    try {
      const logResponse = await sqliteQuery({ table: 'review_logs', where: { client_op_id: opId }, limit: 1 }, 5_000, 'high')
      const logRaw = ((logResponse.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
      if (logRaw) cachedLog = mapSqliteReviewLogRow(logRaw) as unknown as ReviewLogV2
    } catch {
      /* fallback */
    }
    try {
      await db.transaction('rw', db.states, db.plans, db.reviewLogs, db.meta, async () => {
        await db.states.put(state)
        await db.plans.put(nextPlan)
        if (candidate.id != null) await db.reviewLogs.put({ ...(candidate as unknown as ReviewLogV2), corrected: true, reverted: true } as never)
        await db.reviewLogs.put(cachedLog as never)
        await db.meta.put({ key: 'lastStudyDate', value: today, updatedAt: now })
      })
    } catch {
      const { markIdbCacheDirty } = await import('./idb-cache')
      await markIdbCacheDirty('rerate-cache-write-failed').catch(() => undefined)
    }
    return persisted
  })
}

/** arch 单 tx reRate 用：纯构造 undo ops（不写 client_ops，由 reRate 统一写） */
export function buildUndoRatingTxOps(input: {
  logId: number | null
  stateBefore: WordState | null
  restoredState: WordState
  plan: DailyPlan | null
}): unknown[] {
  const ops: unknown[] = []
  if (input.logId != null) ops.push({ op: 'update', table: 'review_logs', where: { id: input.logId }, patch: { corrected: 1 } })
  if (input.stateBefore == null) ops.push({ op: 'delete', table: 'states', where: { word_id: input.restoredState.wordId } })
  else ops.push({ op: 'upsert', table: 'states', row: buildStateSqliteRow(input.restoredState) })
  if (input.plan) ops.push({ op: 'upsert', table: 'plans', row: planRow(input.plan) })
  return ops
}
