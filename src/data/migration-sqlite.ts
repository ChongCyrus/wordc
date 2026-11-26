/** 0.11.0 M3：0.9/0.10 IndexedDB → SQLite 一次性迁移（M4 切写前必须先完成） */
import { getDb } from './db'
import { bumpDataEpoch, getDataEpoch } from './data-epoch'
import { getIdbCacheMeta, writeIdbCacheMeta } from './idb-cache'
import { sqliteHealth, sqliteQuery, sqliteTx, type SqliteResponse } from './native-sqlite'
import { SQLITE_SCHEMA_VERSION, extractSqliteCounts } from './sqlite-store'
import { withDataWriteLock } from './write-lock'

export const SQLITE_MIGRATION_VERSION = '0.11.0'
export const SQLITE_MIGRATION_STEP = 'legacy-idb'
export const SQLITE_MIGRATION_DONE_KEY = 'sqlite.migration.legacyIdb.done'

export interface SqliteMigrationCounts {
  states: number
  plans: number
  settings: number
  reviewLogs: number
}

export interface SqliteMigrationResult {
  ok: boolean
  dryRun: boolean
  skipped?: boolean
  counts: SqliteMigrationCounts
  sqliteCounts?: SqliteMigrationCounts
  batches: number
  error?: string
}

export interface MigrateIdbToSqliteOptions {
  dryRun?: boolean
  batchSize?: number
  now?: number
  /** 非 dryRun 必填：升级前强制完整备份；失败拒绝迁移 */
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  /** 仅供测试/内部重置；UI 不得使用 */
  unsafe?: boolean
  /** 调用方已自行清空 facts 并 reset migration_state；跳过 done/非空门禁，强制重放 IDB→SQLite */
  force?: boolean
  /** 调用方已持全局写锁（ensureLegacy/回退流程） */
  skipWriteLock?: boolean
  onProgress?: (progress: { phase: 'read' | 'backup' | 'write' | 'verify' | 'done'; done: number; total: number }) => void
  /** 测试注入；默认 native */
  sqliteTxImpl?: (ops: unknown[]) => Promise<SqliteResponse>
  sqliteQueryImpl?: (query: Record<string, unknown>) => Promise<SqliteResponse>
  sqliteHealthImpl?: () => Promise<SqliteResponse>
}

type LegacyData = {
  states: Array<Record<string, unknown>>
  plans: Array<Record<string, unknown>>
  settings: Array<Record<string, unknown>>
  reviewLogs: Array<Record<string, unknown>>
  counts: SqliteMigrationCounts
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  const step = Math.max(1, Math.floor(size))
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step))
  return out
}

export async function readLegacyIdbMigrationData(): Promise<LegacyData> {
  const db = getDb()
  const [states, plans, settings, reviewLogs] = await Promise.all([
    db.states.toArray(),
    db.plans.toArray(),
    db.settings.toArray(),
    db.reviewLogs.toArray(),
  ])
  return {
    states: states as unknown as Array<Record<string, unknown>>,
    plans: plans as unknown as Array<Record<string, unknown>>,
    settings: settings as unknown as Array<Record<string, unknown>>,
    reviewLogs: reviewLogs as unknown as Array<Record<string, unknown>>,
    counts: {
      states: states.length,
      plans: plans.length,
      settings: settings.length,
      reviewLogs: reviewLogs.length,
    },
  }
}

export function stateRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    word_id: row.wordId,
    deck_id: row.deckId,
    phase: row.phase,
    stability: row.stability,
    difficulty: row.difficulty,
    reps: row.reps,
    lapses: row.lapses,
    first_seen_at: row.firstSeenAt ?? null,
    last_reviewed_at: row.lastReviewedAt ?? null,
    due_at: row.dueAt ?? null,
    next_interval_days: row.nextIntervalDays ?? 1,
    retrievability: row.retrievability ?? 0,
    last_rating: row.lastRating ?? null,
    same_day_count: row.sameDayCount ?? 0,
    same_day_date: row.sameDayDate ?? '',
    today_progress: row.todayProgress ?? null,
    today_progress_level: row.todayProgressLevel ?? null,
    can_finish_today: row.canFinishToday == null ? null : row.canFinishToday ? 1 : 0,
    meaning_stats_json: JSON.stringify(row.meaningStats ?? {}),
    core_sense_stats_json: row.coreSenseStats ? JSON.stringify(row.coreSenseStats) : null,
    part_stats_json: row.partStats ? JSON.stringify(row.partStats) : null,
    same_day_requeued: row.sameDayRequeued ?? 0,
    imported_from: row.importedFrom ?? null,
    imported_at: row.importedAt ?? null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export function planRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    date: row.date,
    deck_id: row.deckId,
    word_ids_json: JSON.stringify(row.wordIds ?? []),
    idx: row.index ?? 0,
    sources_json: JSON.stringify(row.sources ?? {}),
    goals_json: JSON.stringify(row.goals ?? {}),
    ratings_json: JSON.stringify(row.ratings ?? []),
    wc_counts_json: row.wcCounts ? JSON.stringify(row.wcCounts) : null,
    completed_at: typeof row.completedAt === 'number' && row.completedAt > 0 ? row.completedAt : null,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  }
}

export function logRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(row.id != null ? { id: row.id } : {}),
    word_id: row.wordId,
    deck_id: row.deckId,
    rating: row.rating,
    reviewed_at: row.reviewedAt,
    stability_before: row.stabilityBefore,
    difficulty_before: row.difficultyBefore,
    stability_after: row.stabilityAfter,
    difficulty_after: row.difficultyAfter,
    elapsed_days: row.elapsedDays,
    next_interval_days: row.nextIntervalDays,
    retrievability_at_review: row.retrievabilityAtReview ?? null,
    long_term_update: row.longTermUpdate ? 1 : 0,
    corrected: row.corrected ? 1 : 0,
    corrected_by: row.correctedBy ?? null,
    state_before_json: row.stateBefore ? JSON.stringify(row.stateBefore) : null,
    meaning_changes_json: row.meaningChanges ? JSON.stringify(row.meaningChanges) : null,
    phase_before: row.phaseBefore ?? null,
    phase_after: row.phaseAfter ?? null,
  }
}

export function settingRow(row: Record<string, unknown>): Record<string, unknown> {
  return { key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updatedAt ?? Date.now() }
}

function countsFromHealth(response: SqliteResponse) { return extractSqliteCounts(response as never) }

function sameCounts(a: SqliteMigrationCounts, b: SqliteMigrationCounts): boolean {
  return a.states === b.states && a.plans === b.plans && a.settings === b.settings && a.reviewLogs === b.reviewLogs
}

async function queryMigrationState(
  query: (query: Record<string, unknown>) => Promise<SqliteResponse>,
): Promise<string | null> {
  try {
    const response = await query({ table: 'migration_state', where: { step: SQLITE_MIGRATION_STEP }, limit: 1 })
    const row = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    return row?.status ? String(row.status) : null
  } catch {
    return null
  }
}

/**
 * M3：一次性迁移。非 dryRun 时：全局写锁 → 强制备份 → 分批 upsert → counts 校验 →
 * 写 migration_state/schema_meta → epoch+1；失败不标完成、IDB 保留。
 * 迁移完成前写路径继续 IDB；M2 bootstrap 不得因 SQLite counts>0 dirty 回源。
 */
export async function migrateIdbToSqlite(
  opts: MigrateIdbToSqliteOptions = {},
): Promise<SqliteMigrationResult> {
  const dryRun = opts.dryRun !== false
  const batchSize = Math.max(1, Math.min(500, Math.floor(opts.batchSize ?? 200)))
  const tx = opts.sqliteTxImpl ?? ((batch: unknown[]) => sqliteTx(batch))
  const query = opts.sqliteQueryImpl ?? ((q: Record<string, unknown>) => sqliteQuery(q))
  const health = opts.sqliteHealthImpl ?? (() => sqliteHealth())
  const execute = async (): Promise<SqliteMigrationResult> => {
    const legacy = await readLegacyIdbMigrationData()
    const total = Object.values(legacy.counts).reduce((a, b) => a + b, 0)
    opts.onProgress?.({ phase: 'read', done: 0, total })
    if (dryRun) {
      const ops = [
        ...legacy.states.map((row) => ({ op: 'upsert', table: 'states', row: stateRow(row) })),
        ...legacy.plans.map((row) => ({ op: 'upsert', table: 'plans', row: planRow(row) })),
        ...legacy.settings.map((row) => ({ op: 'upsert', table: 'settings', row: settingRow(row) })),
        ...legacy.reviewLogs.map((row) => ({ op: 'upsert', table: 'review_logs', row: logRow(row) })),
      ]
      return { ok: true, dryRun: true, counts: legacy.counts, batches: chunk(ops, batchSize).length }
    }
    // 幂等：已完成先返回，不再要求/重复备份
    const previousMigration = await queryMigrationState(query)
    if (previousMigration === 'done' && !opts.force) {
      return { ok: true, dryRun: false, skipped: true, counts: legacy.counts, batches: 0 }
    }
    // C-01：force 只能内部 unsafe 使用，且必须已 reset/清理，禁止公开绕过门禁
    if (opts.force && !opts.unsafe) {
      return { ok: false, dryRun: false, counts: legacy.counts, sqliteCounts: { states: 0, plans: 0, settings: 0, reviewLogs: 0 }, batches: 0, error: 'force 迁移仅限内部调用（需要 unsafe:true + 已 reset migration_state）' }
    }
    // M3 前校验：SQLite facts 必须为空；仅允许上次 running/failed 的部分行重试，且不能超过 IDB counts
    const preHealth = await health()
    const preCounts = countsFromHealth(preHealth) ?? { states: 0, plans: 0, settings: 0, reviewLogs: 0 }
    const hasExistingFacts =
      preCounts.states > 0 || preCounts.plans > 0 || preCounts.settings > 0 || preCounts.reviewLogs > 0
    if (hasExistingFacts && !opts.force) {
      const isPartialRetry =
        (previousMigration === 'running' || previousMigration === 'failed') &&
        preCounts.states <= legacy.counts.states &&
        preCounts.plans <= legacy.counts.plans &&
        preCounts.settings <= legacy.counts.settings &&
        preCounts.reviewLogs <= legacy.counts.reviewLogs
      if (!isPartialRetry) {
        return {
          ok: false,
          dryRun: false,
          counts: legacy.counts,
          sqliteCounts: preCounts,
          batches: 0,
          error: 'SQLite facts 非空，拒绝迁移（请先确认/手动清理，不能静默替换）',
        }
      }
    }
    if (!opts.unsafe) {
      if (!opts.preBackup) throw new Error('迁移前必须先完成完整备份')
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) throw new Error(`预备份失败，已拒绝迁移：${backup.error ?? '未知错误'}`)
    }
    opts.onProgress?.({ phase: 'backup', done: 1, total: 1 })
    const now = opts.now ?? Date.now()
    const ops = [
      { op: 'upsert', table: 'migration_state', row: { step: SQLITE_MIGRATION_STEP, status: 'running', started_at: now, finished_at: null, error: null } },
      ...legacy.states.map((row) => ({ op: 'upsert', table: 'states', row: stateRow(row) })),
      ...legacy.plans.map((row) => ({ op: 'upsert', table: 'plans', row: planRow(row) })),
      ...legacy.settings.map((row) => ({ op: 'upsert', table: 'settings', row: settingRow(row) })),
      ...legacy.reviewLogs.map((row) => ({ op: 'upsert', table: 'review_logs', row: logRow(row) })),
    ]
    const batches = chunk(ops, batchSize)
    for (let i = 0; i < batches.length; i += 1) {
      const response = await tx(batches[i]!)
      if (response.ok === false) {
        await tx([{ op: 'upsert', table: 'migration_state', row: { step: SQLITE_MIGRATION_STEP, status: 'failed', started_at: now, finished_at: Date.now(), error: response.message ?? 'batch failed' } }]).catch(() => undefined)
        return { ok: false, dryRun: false, counts: legacy.counts, batches: i + 1, error: response.message ?? 'SQLite 迁移事务失败' }
      }
      opts.onProgress?.({ phase: 'write', done: i + 1, total: batches.length })
    }
    opts.onProgress?.({ phase: 'verify', done: batches.length, total: batches.length })
    const healthResponse = await health()
    const sqliteCounts = countsFromHealth(healthResponse)
    if (!sqliteCounts || !sameCounts(legacy.counts, sqliteCounts)) {
      await tx([{ op: 'upsert', table: 'migration_state', row: { step: SQLITE_MIGRATION_STEP, status: 'failed', started_at: now, finished_at: Date.now(), error: 'counts mismatch' } }]).catch(() => undefined)
      return {
        ok: false,
        dryRun: false,
        counts: legacy.counts,
        ...(sqliteCounts ? { sqliteCounts } : {}),
        batches: batches.length,
        error: '迁移 counts 不一致，未标记完成；IDB 保持不变',
      }
    }
    const epoch = await getDataEpoch()
    const nextEpoch = epoch + 1
    // 0.11.0 M3：done 必须是最后一个失败域。先写 cache ready，再 bump epoch，最后才标 migration_state=done。
    try {
      const existingCache = await getIdbCacheMeta()
      await writeIdbCacheMeta({
        generation: nextEpoch,
        sqliteUserVersion: existingCache?.sqliteUserVersion ?? SQLITE_SCHEMA_VERSION,
        rebuiltAt: Date.now(),
        dirty: false,
        reason: 'legacy-idb-migrated',
      })
    } catch (error) {
      return { ok: false, dryRun: false, counts: legacy.counts, sqliteCounts, batches: batches.length, error: `迁移 cache ready 写入失败，未标 done：${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      await bumpDataEpoch('migrateIdbToSqlite')
    } catch (error) {
      return { ok: false, dryRun: false, counts: legacy.counts, sqliteCounts, batches: batches.length, error: `迁移 epoch 写入失败，未标 done：${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      await tx([
        { op: 'upsert', table: 'migration_state', row: { step: SQLITE_MIGRATION_STEP, status: 'done', started_at: now, finished_at: Date.now(), error: null } },
        { op: 'upsert', table: 'schema_meta', row: { key: 'migrated_from', value_json: JSON.stringify(SQLITE_MIGRATION_VERSION) } },
        { op: 'upsert', table: 'schema_meta', row: { key: 'data_epoch', value_json: JSON.stringify(nextEpoch) } },
      ])
    } catch (error) {
      return { ok: false, dryRun: false, counts: legacy.counts, sqliteCounts, batches: batches.length, error: `迁移完成标记失败：${error instanceof Error ? error.message : String(error)}` }
    }
    opts.onProgress?.({ phase: 'done', done: batches.length, total: batches.length })
    return { ok: true, dryRun: false, counts: legacy.counts, sqliteCounts, batches: batches.length }
  }
  if (dryRun) return execute()
  if (opts.skipWriteLock) return execute()
  return withDataWriteLock(execute)
}

export function sqliteMigrationTargetVersion(): number {
  return SQLITE_SCHEMA_VERSION
}
