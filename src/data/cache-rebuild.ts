/** 0.11.0 M4a：先 delta 同步 IDB 新进度 → 再重建 IDB cache；失败保留双方原数据 */
import { getDb } from './db'
import { getDataEpoch } from './data-epoch'
import { writeIdbCacheMeta } from './idb-cache'
import { isSqliteAvailable, sqliteHealth, sqliteQuery, sqliteTx } from './native-sqlite'
import { SQLITE_SCHEMA_VERSION, extractSqliteCounts } from './sqlite-store'
import {
  mapSqlitePlanRow,
  mapSqliteReviewLogRow,
  mapSqliteSettingRow,
  mapSqliteStateRow,
} from './sqlite-read'
import { withDataWriteLock } from './write-lock'
import type { DailyPlan, WordState } from '../core/types'

export interface CacheRebuildCounts {
  states: number
  plans: number
  settings: number
  reviewLogs: number
}

export interface CacheRebuildResult {
  ok: boolean
  dryRun: boolean
  delta: CacheRebuildCounts
  cacheCounts?: CacheRebuildCounts
  sqliteCounts?: CacheRebuildCounts
  generation?: number
  error?: string
  conflict?: string
}

export interface RebuildCacheOptions {
  dryRun?: boolean
  batchSize?: number
  sampleSize?: number
  /** 非 dryRun 必填：delta/重建前完整备份 */
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  unsafe?: boolean
  /** 调用方已持全局写锁 */
  skipWriteLock?: boolean
  /** C-07：分叉时由用户显式选择“以 SQLite 为准重建 IDB”；仍需 preBackup */
  force?: boolean
  onProgress?: (stage: string) => void
  sqliteQueryImpl?: (query: Record<string, unknown>) => Promise<{ ok: boolean; rows?: unknown[]; nextCursor?: string | null; message?: string }>
  sqliteHealthImpl?: () => Promise<{ ok: boolean; userVersion?: number; data?: { counts?: Partial<CacheRebuildCounts> }; message?: string }>
  sqliteTxImpl?: (ops: unknown[]) => Promise<{ ok: boolean; message?: string }>
}

type Row = Record<string, unknown>

function keyOf(table: string, row: Row): string {
  if (table === 'states') return String(row.word_id)
  if (table === 'plans') return String(row.id)
  if (table === 'settings') return String(row.key)
  return String(row.id)
}

const TABLE_KEY: Record<string, string> = {
  states: 'word_id',
  plans: 'id',
  settings: 'key',
  review_logs: 'id',
}

async function queryAll(
  query: (query: Record<string, unknown>) => Promise<{ ok: boolean; rows?: unknown[]; nextCursor?: string | null; message?: string }>,
  table: string,
  batchSize: number,
): Promise<Row[]> {
  const keyColumn = TABLE_KEY[table] ?? 'id'
  const out: Row[] = []
  const seen = new Set<string>()
  // native 必须支持 offset + 固定主键 orderBy；若忽略 offset，第二页会重复，直接报错而不是静默截断
  for (let offset = 0; offset < 1_000_000; offset += batchSize) {
    const response = await query({ table, limit: batchSize, offset, orderBy: keyColumn, direction: 'asc' })
    if (!response.ok) throw new Error(response.message ?? `query ${table} 失败`)
    const rows = (response.rows as Row[] | undefined) ?? []
    if (rows.length === 0) break
    let added = 0
    for (const row of rows) {
      const key = keyOf(table, row)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(row)
      added += 1
    }
    if (added === 0) {
      throw new Error(`SQLite 分页未生效（${table} offset=${offset} 返回重复行），拒绝截断重建`)
    }
    if (rows.length < batchSize) break
  }
  return out
}

function idbCounts(): Promise<CacheRebuildCounts> {
  const db = getDb()
  return Promise.all([db.states.count(), db.plans.count(), db.settings.count(), db.reviewLogs.count()]).then(
    ([states, plans, settings, reviewLogs]) => ({ states, plans, settings, reviewLogs }),
  )
}

function compareState(idb: WordState, sqlite: WordState | null): 'same' | 'idb-newer' | 'conflict' {
  if (!sqlite) return 'idb-newer'
  if (idb.updatedAt > sqlite.updatedAt) return 'idb-newer'
  if (idb.updatedAt < sqlite.updatedAt) return 'same' // SQLite fact 更新，重建时以 SQLite 为准
  const sameFacts =
    idb.phase === sqlite.phase &&
    idb.reps === sqlite.reps &&
    idb.lapses === sqlite.lapses &&
    idb.lastReviewedAt === sqlite.lastReviewedAt &&
    idb.dueAt === sqlite.dueAt
  return sameFacts ? 'same' : 'conflict'
}

function rowsForState(state: WordState): Row {
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

function rowsForPlan(plan: DailyPlan): Row {
  return {
    id: plan.id, date: plan.date, deck_id: plan.deckId,
    word_ids_json: JSON.stringify(plan.wordIds ?? []), idx: plan.index ?? 0,
    sources_json: JSON.stringify(plan.sources ?? {}), goals_json: JSON.stringify(plan.goals ?? {}),
    ratings_json: JSON.stringify(plan.ratings ?? []),
    wc_counts_json: plan.wcCounts ? JSON.stringify(plan.wcCounts) : null,
    completed_at: plan.completedAt ?? null, created_at: plan.createdAt, updated_at: plan.updatedAt,
  }
}

function rowsForLog(log: Row): Row {
  return {
    ...(log.id != null ? { id: log.id } : {}),
    word_id: log.wordId, deck_id: log.deckId, rating: log.rating, reviewed_at: log.reviewedAt,
    stability_before: log.stabilityBefore, difficulty_before: log.difficultyBefore,
    stability_after: log.stabilityAfter, difficulty_after: log.difficultyAfter,
    elapsed_days: log.elapsedDays, next_interval_days: log.nextIntervalDays,
    retrievability_at_review: log.retrievabilityAtReview ?? null,
    long_term_update: log.longTermUpdate ? 1 : 0, corrected: log.corrected ? 1 : 0,
    corrected_by: log.correctedBy ?? null,
    state_before_json: log.stateBefore ? JSON.stringify(log.stateBefore) : null,
    meaning_changes_json: log.meaningChanges ? JSON.stringify(log.meaningChanges) : null,
    phase_before: log.phaseBefore ?? null, phase_after: log.phaseAfter ?? null,
  }
}

/**
 * M4a：比较 IDB 与 SQLite；IDB 更新则先 delta upsert 到 SQLite，再按 SQLite 全量重建 cache。
 * 冲突/无法判定 → 拒绝，不动 IDB/SQLite；成功写 generation/dirty=false。
 */
export async function rebuildIdbCacheFromSqlite(opts: RebuildCacheOptions = {}): Promise<CacheRebuildResult> {
  const dryRun = opts.dryRun === true
  const batchSize = Math.max(1, Math.min(1000, Math.floor(opts.batchSize ?? 500)))
  const empty = { states: 0, plans: 0, settings: 0, reviewLogs: 0 }
  if (!isSqliteAvailable()) return { ok: false, dryRun, delta: empty, error: '当前环境不支持原生 SQLite' }
  const query = opts.sqliteQueryImpl ?? ((q: Record<string, unknown>) => sqliteQuery(q))
  const health = opts.sqliteHealthImpl ?? (() => sqliteHealth())
  const tx = opts.sqliteTxImpl ?? ((ops: unknown[]) => sqliteTx(ops))
  const execute = async (): Promise<CacheRebuildResult> => {
    const progress = opts.onProgress ?? (() => undefined)
    progress('start')
    const db = getDb()
    progress('read-idb-sqlite')
    const [idbStates, idbPlans, idbSettings, idbLogs, sqliteStateRows, sqlitePlanRows, sqliteSettingRows, sqliteLogRows] = await Promise.all([
      db.states.toArray(),
      db.plans.toArray(),
      db.settings.toArray(),
      db.reviewLogs.toArray(),
      queryAll(query, 'states', batchSize),
      queryAll(query, 'plans', batchSize),
      queryAll(query, 'settings', batchSize),
      queryAll(query, 'review_logs', batchSize),
    ])
    const sqliteStates = new Map(sqliteStateRows.map((row) => [String(row.word_id), mapSqliteStateRow(row)]))
    const sqlitePlans = new Map(sqlitePlanRows.map((row) => [String(row.id), mapSqlitePlanRow(row)]))
    const sqliteSettings = new Map(sqliteSettingRows.map((row) => [String(row.key), mapSqliteSettingRow(row)]))
    const sqliteLogIds = new Set(sqliteLogRows.map((row) => String(row.id)))
    const deltaOps: unknown[] = []
    const delta: CacheRebuildCounts = { ...empty }
    let conflict: string | undefined
    for (const state of idbStates) {
      const relation = compareState(state, sqliteStates.get(state.wordId) ?? null)
      if (relation === 'conflict') {
        conflict = `state 冲突：${state.wordId}`
        break
      }
      if (relation === 'idb-newer') {
        conflict = `IDB 与 SQLite 分叉（state ${state.wordId} 更新），拒绝用 IDB 反向覆盖 SQLite 事实源`
        break
      }
    }
    if (!conflict) {
      for (const plan of idbPlans) {
        const remote = sqlitePlans.get(plan.id)
        if (!remote) {
          conflict = `IDB 与 SQLite 分叉（plan ${plan.id} 仅 IDB 有），拒绝反向覆盖`
          break
        } else if (plan.updatedAt > remote.updatedAt) {
          conflict = `IDB 与 SQLite 分叉（plan ${plan.id} 更新），拒绝反向覆盖`
          break
        } else if (plan.updatedAt === remote.updatedAt && plan.index !== remote.index) {
          conflict = `plan 冲突：${plan.id}`
          break
        }
      }
    }
    if (!conflict) {
      for (const setting of idbSettings) {
        const remote = sqliteSettings.get(setting.key)
        if (!remote || setting.updatedAt > remote.updatedAt) {
          conflict = `IDB 与 SQLite 分叉（setting ${setting.key}），拒绝反向覆盖`
          break
        }
      }
    }
    if (!conflict) {
      for (const log of idbLogs) {
        if (log.id == null) continue
        if (!sqliteLogIds.has(String(log.id))) {
          conflict = `IDB 与 SQLite 分叉（review_log ${log.id}），拒绝反向覆盖`
          break
        }
      }
    }
    let forcedOverwrite = false
    if (conflict) {
      if (opts.force && !dryRun) {
        // 只标记，真正重写分支在下面统一处理（含 preBackup），不要在这里清掉 conflict 让分支不可达
        forcedOverwrite = true
      } else return { ok: false, dryRun, delta: empty, conflict }
    }
    if (dryRun) return { ok: true, dryRun: true, delta }
    // C-07/P0：force 模式 = 用户明确“以 SQLite 为准重建 IDB”，不做 delta、不写 SQLite，
    // 也不拿旧 IDB counts 做比对（恢复后 IDB 可能为空/陈旧）。
    if (opts.force && (conflict || forcedOverwrite) && !dryRun) {
      if (!opts.preBackup) return { ok: false, dryRun, delta: empty, conflict, error: '强制以 SQLite 为准重建前必须备份' }
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) return { ok: false, dryRun, delta: empty, conflict, error: `预备份失败：${backup.error ?? '未知错误'}` }
      // 恢复/换库后，函数开头抓到的 sqliteStateRows 可能已过期（空库），必须重新查询最新 SQLite 行
      const freshStateRows = await queryAll(query, 'states', batchSize)
      const freshPlanRows = await queryAll(query, 'plans', batchSize)
      const freshSettingRows = await queryAll(query, 'settings', batchSize)
      const freshLogRows = await queryAll(query, 'review_logs', batchSize)
      progress('write-cache')
      try {
        await db.transaction('rw', [db.states, db.plans, db.settings, db.reviewLogs], async () => {
          await db.states.clear(); await db.plans.clear(); await db.settings.clear(); await db.reviewLogs.clear()
          if (freshStateRows.length > 0) await db.states.bulkPut(freshStateRows.map(mapSqliteStateRow))
          if (freshPlanRows.length > 0) await db.plans.bulkPut(freshPlanRows.map(mapSqlitePlanRow))
          if (freshSettingRows.length > 0) await db.settings.bulkPut(freshSettingRows.map(mapSqliteSettingRow) as never)
          if (freshLogRows.length > 0) await db.reviewLogs.bulkPut(freshLogRows.map(mapSqliteReviewLogRow) as never)
        })
      } catch (error) {
        return { ok: false, dryRun: false, delta: empty, error: `强制 cache 重建事务失败：${error instanceof Error ? error.message : String(error)}` }
      }
      const cacheCounts = await idbCounts()
      const healthResponse = await health()
      const sqliteCounts = extractSqliteCounts(healthResponse as never)
      if (!sqliteCounts || cacheCounts.states !== sqliteCounts.states || cacheCounts.plans !== sqliteCounts.plans || cacheCounts.settings !== sqliteCounts.settings || cacheCounts.reviewLogs !== sqliteCounts.reviewLogs) {
        return { ok: false, dryRun: false, delta: empty, cacheCounts, ...(sqliteCounts ? { sqliteCounts } : {}), error: '强制重建后 cache/SQLite counts 不一致' }
      }
      progress('verify')
      const generation = await getDataEpoch()
      await writeIdbCacheMeta({ generation, sqliteUserVersion: Number(healthResponse.userVersion ?? SQLITE_SCHEMA_VERSION), rebuiltAt: Date.now(), dirty: false })
      return { ok: true, dryRun: false, delta: empty, cacheCounts, sqliteCounts, generation }
    }
    if (!opts.unsafe) {
      if (!opts.preBackup) return { ok: false, dryRun: false, delta, error: 'M4a 前必须先完整备份' }
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) return { ok: false, dryRun: false, delta, error: `预备份失败：${backup.error ?? '未知'}` }
    }
    if (deltaOps.length > 0) {
      const response = await tx(deltaOps)
      if (response.ok === false) return { ok: false, dryRun: false, delta, error: response.message ?? 'delta 同步失败' }
    }
    // delta 后重新查询，重建必须以最新 SQLite 行为准（不能复用 delta 前快照）
    const finalStateRows = deltaOps.length > 0 ? await queryAll(query, 'states', batchSize) : sqliteStateRows
    const finalPlanRows = deltaOps.length > 0 ? await queryAll(query, 'plans', batchSize) : sqlitePlanRows
    const finalSettingRows = deltaOps.length > 0 ? await queryAll(query, 'settings', batchSize) : sqliteSettingRows
    const finalLogRows = deltaOps.length > 0 ? await queryAll(query, 'review_logs', batchSize) : sqliteLogRows
    const finalSqliteStates = new Map(finalStateRows.map((row) => [String(row.word_id), mapSqliteStateRow(row)]))
    const finalSqlitePlans = new Map(finalPlanRows.map((row) => [String(row.id), mapSqlitePlanRow(row)]))
    const healthResponse = await health()
    const sqliteCounts = extractSqliteCounts(healthResponse as never)
    if (!sqliteCounts) {
      return { ok: false, dryRun: false, delta, error: 'health 缺少 counts，拒绝在无法校验时重建' }
    }
    const preCache = await idbCounts()
    const expected = {
      states: preCache.states,
      plans: preCache.plans,
      settings: preCache.settings,
      reviewLogs: preCache.reviewLogs,
    }
    if (
      sqliteCounts.states !== expected.states ||
      sqliteCounts.plans !== expected.plans ||
      sqliteCounts.settings !== expected.settings ||
      sqliteCounts.reviewLogs !== expected.reviewLogs
    ) {
      return { ok: false, dryRun: false, delta, cacheCounts: preCache, sqliteCounts, error: 'delta 后 SQLite/IDB counts 不一致，拒绝重建' }
    }
    const expectedCounts = {
      states: finalStateRows.length,
      plans: finalPlanRows.length,
      settings: finalSettingRows.length,
      reviewLogs: finalLogRows.length,
    }
    if (
      expectedCounts.states !== sqliteCounts.states ||
      expectedCounts.plans !== sqliteCounts.plans ||
      expectedCounts.settings !== sqliteCounts.settings ||
      expectedCounts.reviewLogs !== sqliteCounts.reviewLogs
    ) {
      return { ok: false, dryRun: false, delta, cacheCounts: preCache, sqliteCounts, error: 'SQLite 查询行数与 health counts 不一致，拒绝重建' }
    }
    const sampleSize = Math.max(1, Math.min(20, Math.floor(opts.sampleSize ?? 3)))
    for (const state of idbStates.slice(0, sampleSize)) {
      const row = finalSqliteStates.get(state.wordId)
      if (!row) return { ok: false, dryRun: false, delta, cacheCounts: preCache, error: `抽样 state 不存在：${state.wordId}` }
      if (row.phase !== state.phase || row.updatedAt !== state.updatedAt) {
        return { ok: false, dryRun: false, delta, cacheCounts: preCache, error: `抽样 state 不一致：${state.wordId}` }
      }
    }
    // M4a 门禁：抽样当前 plan，completedAt 归一化后必须与 IDB 一致，index/wordIds 长度一致
    for (const plan of idbPlans.slice(0, sampleSize)) {
      const row = finalSqlitePlans.get(plan.id)
      if (!row) return { ok: false, dryRun: false, delta, cacheCounts: preCache, error: `抽样 plan 不存在：${plan.id}` }
      const idbCompleted = Number(plan.completedAt) > 0 ? Number(plan.completedAt) : null
      if (row.completedAt !== idbCompleted) {
        return { ok: false, dryRun: false, delta, cacheCounts: preCache, error: `抽样 plan completedAt 不一致：${plan.id}` }
      }
      if (row.index !== plan.index || row.wordIds.length !== plan.wordIds.length) {
        return { ok: false, dryRun: false, delta, cacheCounts: preCache, error: `抽样 plan index/wordIds 不一致：${plan.id}` }
      }
    }
    progress('write-cache')
    const tables = [db.states, db.plans, db.settings, db.reviewLogs]
    try {
      await db.transaction('rw', tables, async () => {
        await db.states.clear(); await db.plans.clear(); await db.settings.clear(); await db.reviewLogs.clear()
        if (finalStateRows.length > 0) await db.states.bulkPut(finalStateRows.map(mapSqliteStateRow))
        if (finalPlanRows.length > 0) await db.plans.bulkPut(finalPlanRows.map(mapSqlitePlanRow))
        if (finalSettingRows.length > 0) await db.settings.bulkPut(finalSettingRows.map(mapSqliteSettingRow) as never)
        if (finalLogRows.length > 0) await db.reviewLogs.bulkPut(finalLogRows.map(mapSqliteReviewLogRow) as never)
      })
    } catch (error) {
      return { ok: false, dryRun: false, delta, error: `cache 重建事务失败：${error instanceof Error ? error.message : String(error)}` }
    }
    const cacheCounts = await idbCounts()
    if (
      cacheCounts.states !== sqliteCounts.states ||
      cacheCounts.plans !== sqliteCounts.plans ||
      cacheCounts.settings !== sqliteCounts.settings ||
      cacheCounts.reviewLogs !== sqliteCounts.reviewLogs
    ) {
      return { ok: false, dryRun: false, delta, cacheCounts, sqliteCounts, error: '重建后 cache counts 与 SQLite 不一致' }
    }
    progress('verify')
    const generation = await getDataEpoch()
    await writeIdbCacheMeta({
      generation,
      sqliteUserVersion: Number(healthResponse.userVersion ?? SQLITE_SCHEMA_VERSION),
      rebuiltAt: Date.now(),
      dirty: false,
    })
    return { ok: true, dryRun: false, delta, cacheCounts, sqliteCounts, generation }
  }
  return dryRun || opts.skipWriteLock ? execute() : withDataWriteLock(execute)
}

void rowsForState
void rowsForPlan
void rowsForLog
