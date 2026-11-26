/** 0.11.0 M2：只读切换——cache 优先；dirty/版本不一致回源 SQLite；不双写 */
import type { DailyPlan } from './plan.types'
import type { WordState } from '../core/types'
import type { SettingRecord } from '../core'
import { getDb } from './db'
import { getDataEpoch } from './data-epoch'
import { getIdbCacheMeta, writeIdbCacheMeta, markIdbCacheDirty } from './idb-cache'
import { isSqliteAvailable, sqliteHealth, sqliteQuery } from './native-sqlite'
import { SQLITE_SCHEMA_VERSION } from './sqlite-store'
import { SQLITE_MIGRATION_STEP } from './migration-sqlite'

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === 'object') return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

export function mapSqliteStateRow(row: Record<string, unknown>): WordState {
  return {
    wordId: String(row.word_id),
    deckId: String(row.deck_id),
    phase: String(row.phase) as WordState['phase'],
    stability: Number(row.stability ?? 0),
    difficulty: Number(row.difficulty ?? 5),
    reps: Number(row.reps ?? 0),
    lapses: Number(row.lapses ?? 0),
    firstSeenAt: row.first_seen_at == null ? null : Number(row.first_seen_at),
    lastReviewedAt: row.last_reviewed_at == null ? null : Number(row.last_reviewed_at),
    dueAt: row.due_at == null ? null : Number(row.due_at),
    nextIntervalDays: Number(row.next_interval_days ?? 1),
    retrievability: Number(row.retrievability ?? 0),
    lastRating: (row.last_rating as WordState['lastRating']) ?? null,
    sameDayCount: Number(row.same_day_count ?? 0),
    sameDayDate: String(row.same_day_date ?? ''),
    meaningStats: parseJson<WordState['meaningStats']>(row.meaning_stats_json, {}),
    ...(row.core_sense_stats_json != null
      ? { coreSenseStats: parseJson<NonNullable<WordState['coreSenseStats']>>(row.core_sense_stats_json, {}) }
      : {}),
    ...(row.part_stats_json != null
      ? { partStats: parseJson<NonNullable<WordState['partStats']>>(row.part_stats_json, {}) }
      : {}),
    sameDayRequeued: Number(row.same_day_requeued ?? 0),
    ...(row.today_progress != null ? { todayProgress: Number(row.today_progress) } : {}),
    ...(row.today_progress_level != null ? { todayProgressLevel: Number(row.today_progress_level) } : {}),
    ...(row.can_finish_today != null ? { canFinishToday: Boolean(row.can_finish_today) } : {}),
    ...(row.imported_from != null ? { importedFrom: row.imported_from as WordState['importedFrom'] } : {}),
    ...(row.imported_at != null ? { importedAt: Number(row.imported_at) } : {}),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  } as WordState
}

export function mapSqlitePlanRow(row: Record<string, unknown>): DailyPlan {
  return {
    id: String(row.id),
    date: String(row.date),
    deckId: String(row.deck_id),
    wordIds: parseJson<string[]>(row.word_ids_json, []),
    index: Number(row.idx ?? 0),
    sources: parseJson<DailyPlan['sources']>(row.sources_json, {}),
    goals: parseJson<DailyPlan['goals']>(row.goals_json, { dailyGoal: 0, dueCount: 0, newBudget: 0, extraCount: 0 }),
    ratings: parseJson<DailyPlan['ratings']>(row.ratings_json, []),
    ...(row.wc_counts_json != null
      ? { wcCounts: parseJson<NonNullable<DailyPlan['wcCounts']>>(row.wc_counts_json, {}) }
      : {}),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
    completedAt: row.completed_at == null || Number(row.completed_at) <= 0 ? null : Number(row.completed_at),
  } as DailyPlan
}

export function mapSqliteSettingRow(row: Record<string, unknown>): SettingRecord {
  return {
    key: String(row.key) as SettingRecord['key'],
    value: parseJson<unknown>(row.value_json, null) as SettingRecord['value'],
    updatedAt: Number(row.updated_at ?? 0),
  }
}

export function mapSqliteReviewLogRow(row: Record<string, unknown>): Record<string, unknown> {
  const parse = (value: unknown, fallback: unknown) => {
    if (value == null) return fallback
    if (typeof value === 'object') return value
    try { return JSON.parse(String(value)) } catch { return fallback }
  }
  return {
    ...(row.id != null ? { id: Number(row.id) } : {}),
    wordId: String(row.word_id),
    deckId: String(row.deck_id),
    rating: row.rating,
    reviewedAt: Number(row.reviewed_at),
    stabilityBefore: Number(row.stability_before ?? 0),
    difficultyBefore: Number(row.difficulty_before ?? 0),
    stabilityAfter: Number(row.stability_after ?? 0),
    difficultyAfter: Number(row.difficulty_after ?? 0),
    elapsedDays: Number(row.elapsed_days ?? 0),
    nextIntervalDays: Number(row.next_interval_days ?? 0),
    retrievabilityAtReview: row.retrievability_at_review == null ? null : Number(row.retrievability_at_review),
    longTermUpdate: Boolean(row.long_term_update),
    corrected: Boolean(row.corrected),
    ...(row.corrected_by != null ? { correctedBy: Number(row.corrected_by) } : {}),
    ...(row.state_before_json != null ? { stateBefore: parse(row.state_before_json, null) } : {}),
    ...(row.meaning_changes_json != null ? { meaningChanges: parse(row.meaning_changes_json, []) } : {}),
    ...(row.phase_before != null ? { phaseBefore: row.phase_before } : {}),
    ...(row.phase_after != null ? { phaseAfter: row.phase_after } : {}),
    ...(row.client_op_id != null ? { clientOpId: String(row.client_op_id) } : {}),
  }
}

async function cacheUsable(): Promise<boolean> {
  // C-04：meta 缺失/读失败必须 fail-closed 回源 SQLite，不能默认信任 IDB cache
  try {
    const meta = await getIdbCacheMeta()
    if (!meta) return false
    return !meta.dirty
  } catch {
    return false
  }
}

async function withIdbFallback<T>(sqliteRead: () => Promise<T>, idbRead: () => Promise<T>): Promise<T> {
  try {
    return await sqliteRead()
  } catch {
    // 0.11.0 M4b-0：upgrade/锁/桥异常时读路径回退 IDB cache，避免 UI 永久 loading。
    return idbRead()
  }
}

async function queryRows(table: string, where: Record<string, unknown>, limit = 1, priority: 'high' | 'normal' = 'normal'): Promise<Record<string, unknown>[]> {
  const response = await sqliteQuery({ table, where, limit }, 800, priority)
  return (response.rows as Record<string, unknown>[] | undefined) ?? []
}

/** M2 只用 SQLite 回源，不写 cache/不迁移；无 SQLite 时回退 IDB */
export async function readStateThroughCache(wordId: string, priority: 'high' | 'normal' = 'normal'): Promise<WordState | null> {
  if (!isSqliteAvailable() || (await cacheUsable())) {
    return (await getDb().states.get(wordId)) ?? null
  }
  return withIdbFallback(
    async () => {
      const rows = await queryRows('states', { word_id: wordId }, 1, priority)
      return rows[0] ? mapSqliteStateRow(rows[0]) : null
    },
    async () => (await getDb().states.get(wordId)) ?? null,
  )
}

export async function readStatesThroughCache(wordIds?: readonly string[]): Promise<WordState[]> {
  if (!isSqliteAvailable() || (await cacheUsable())) {
    const db = getDb()
    if (!wordIds) return db.states.toArray()
    const rows = await db.states.bulkGet([...wordIds])
    return rows.filter((state): state is WordState => Boolean(state))
  }
  return withIdbFallback(
    async () => {
      const response = await sqliteQuery({
        table: 'states',
        ...(wordIds ? { where: { word_id: { in: [...wordIds] } } } : {}),
        limit: wordIds?.length ?? 1000,
      })
      return ((response.rows as Record<string, unknown>[] | undefined) ?? []).map(mapSqliteStateRow)
    },
    async () => {
      const db = getDb()
      if (!wordIds) return db.states.toArray()
      const rows = await db.states.bulkGet([...wordIds])
      return rows.filter((state): state is WordState => Boolean(state))
    },
  )
}

export async function readPlanThroughCache(planId: string, priority: 'high' | 'normal' = 'normal'): Promise<DailyPlan | null> {
  if (!isSqliteAvailable() || (await cacheUsable())) {
    return (await getDb().plans.get(planId)) ?? null
  }
  return withIdbFallback(
    async () => {
      const rows = await queryRows('plans', { id: planId }, 1, priority)
      return rows[0] ? mapSqlitePlanRow(rows[0]) : null
    },
    async () => (await getDb().plans.get(planId)) ?? null,
  )
}

/** 直接读 SQLite plan（不看 cache/dirty），用于 M4b1 前 plan 自愈对比 */
export async function readPlanFromSqliteRaw(planId: string): Promise<DailyPlan | null> {
  if (!isSqliteAvailable()) return null
  try {
    const rows = await queryRows('plans', { id: planId }, 1)
    return rows[0] ? mapSqlitePlanRow(rows[0]) : null
  } catch {
    return null
  }
}

export async function readSettingsThroughCache(): Promise<SettingRecord[]> {
  if (!isSqliteAvailable() || (await cacheUsable())) return getDb().settings.toArray()
  return withIdbFallback(
    async () => {
      const response = await sqliteQuery({ table: 'settings', limit: 1000 }, 800)
      return ((response.rows as Record<string, unknown>[] | undefined) ?? []).map(mapSqliteSettingRow)
    },
    async () => getDb().settings.toArray(),
  )
}

export interface M2BootstrapResult {
  mode: 'cache' | 'sqlite-dirty' | 'unsupported' | 'empty'
  statesInCache: number
  statesInSqlite?: number
}

/**
 * M2 启动引导：当前 IDB 有数据、SQLite counts=0 时**标记 cache ready**，不迁移、不覆盖。
 * SQLite 已有数据或 cache 缺失时标记 dirty，读路径回源 SQLite（仍不迁移）。
 */
export async function bootstrapM2ReadCache(): Promise<M2BootstrapResult> {
  const db = getDb()
  const idbStates = await db.states.count()
  if (!isSqliteAvailable()) return { mode: 'unsupported', statesInCache: idbStates }
  const existing = await getIdbCacheMeta()
  if (existing && !existing.dirty) {
    if (existing.sqliteUserVersion < SQLITE_SCHEMA_VERSION) {
      await writeIdbCacheMeta({ ...existing, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false })
    }
    return { mode: 'cache', statesInCache: idbStates }
  }
  const epoch = await getDataEpoch()
  try {
    const health = await sqliteHealth(30_000)
    const payload = health.data as { counts?: { states?: number }; states?: number } | undefined
    const sqliteStates = Number(
      (health as unknown as { counts?: { states?: number } }).counts?.states
        ?? payload?.counts?.states
        ?? payload?.states
        ?? 0,
    )
    const userVersion = Number(health.userVersion ?? 0)
    // M2 是只读阶段且尚未迁移：SQLite 无历史数据时，历史 240 states 只在 IDB。
    // 绝不能把带 IDB 历史的用户标成 dirty 去读空 SQLite（会表现为进度消失）。
    if (sqliteStates > 0 && idbStates > 0) {
      // M3 迁移未完成时 SQLite 可能已有部分批次：绝不能 dirty 回源，否则历史 IDB 进度“消失”
      let migrationDone = false
      try {
        const migration = await sqliteQuery({
          table: 'migration_state',
          where: { step: SQLITE_MIGRATION_STEP },
          limit: 1,
        })
        const row = ((migration.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
        migrationDone = row?.status === 'done'
      } catch {
        migrationDone = false
      }
      if (!migrationDone) {
        await writeIdbCacheMeta({
          generation: epoch,
          sqliteUserVersion: userVersion || SQLITE_SCHEMA_VERSION,
          rebuiltAt: Date.now(),
          dirty: false,
          reason: 'm3-migration-incomplete-cache-primary',
        })
        return { mode: 'cache', statesInCache: idbStates, statesInSqlite: sqliteStates }
      }
    }
    if (sqliteStates === 0 && idbStates > 0) {
      await writeIdbCacheMeta({
        generation: epoch,
        sqliteUserVersion: userVersion || SQLITE_SCHEMA_VERSION,
        rebuiltAt: Date.now(),
        dirty: false,
        reason: 'm2-cache-bootstrap',
      })
      return { mode: 'cache', statesInCache: idbStates, statesInSqlite: 0 }
    }
    if (sqliteStates === 0 && idbStates === 0) {
      await writeIdbCacheMeta({
        generation: epoch,
        sqliteUserVersion: userVersion || SQLITE_SCHEMA_VERSION,
        rebuiltAt: Date.now(),
        dirty: false,
        reason: 'm2-empty-cache',
      })
      return { mode: 'empty', statesInCache: 0, statesInSqlite: 0 }
    }
    await markIdbCacheDirty('m2-sqlite-has-data')
    return { mode: 'sqlite-dirty', statesInCache: idbStates, statesInSqlite: sqliteStates }
  } catch {
    // health 失败时 M2 必须继续 IDB（历史尚未迁移），不能 dirty 回源空 SQLite。
    if (idbStates > 0) {
      await writeIdbCacheMeta({
        generation: epoch,
        sqliteUserVersion: SQLITE_SCHEMA_VERSION,
        rebuiltAt: Date.now(),
        dirty: false,
        reason: 'm2-health-failed-cache-fallback',
      }).catch(() => undefined)
      return { mode: 'cache', statesInCache: idbStates }
    }
    await markIdbCacheDirty('m2-health-failed')
    return { mode: 'sqlite-dirty', statesInCache: 0 }
  }
}

export async function primeM2ReadCacheForTests(meta: {
  generation: number
  sqliteUserVersion: number
  dirty?: boolean
}): Promise<void> {
  await writeIdbCacheMeta({
    generation: meta.generation,
    sqliteUserVersion: meta.sqliteUserVersion,
    rebuiltAt: Date.now(),
    dirty: meta.dirty === true,
  })
}
