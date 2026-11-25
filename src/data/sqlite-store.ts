/** 0.11.0 M1：SQLite schema 版本/DDL/health/tx/query/backup 封装（native 实际执行） */
import {
  sqliteBackup,
  sqliteQuery,
  sqliteCall,
  sqliteExec,
  sqliteHealth,
  sqliteIntegrity,
  sqliteRestoreDb,
  sqliteTx,
  type SqliteResponse,
} from './native-sqlite'
import { getDb } from './db'

export const SQLITE_SCHEMA_VERSION = 3
export const SQLITE_DB_NAME = 'momo.db'

/** tx/exec/query 白名单表；native 必须拒绝列表外表 */
export const SQLITE_ALLOWED_TABLES = [
  'states',
  'plans',
  'settings',
  'review_logs',
  'client_ops',
  'diag',
  'schema_meta',
  'migration_state',
] as const
export type SqliteTable = (typeof SQLITE_ALLOWED_TABLES)[number]

export interface SqliteColumn {
  name: string
  type: 'TEXT' | 'INTEGER' | 'REAL' | 'BLOB' | 'NULL'
  notNull?: boolean
  primaryKey?: boolean
}
export interface SqliteQueryResult<Row = Record<string, unknown>> {
  rows: Row[]
  columns: SqliteColumn[]
  nextCursor?: string | null
}
export interface SqliteTableCounts {
  states: number
  plans: number
  settings: number
  reviewLogs: number
}

/** 统一读取 health counts：native 顶层优先，兼容 data.counts；缺失返回 null（不得用行数兜底） */
export function extractSqliteCounts(response: {
  counts?: Partial<Record<string, number>>
  data?: { counts?: Partial<Record<string, number>> }
} | null | undefined): SqliteTableCounts | null {
  const counts = response?.counts ?? response?.data?.counts
  if (!counts) return null
  return {
    states: Number(counts.states ?? 0),
    plans: Number(counts.plans ?? counts.dailyPlans ?? 0),
    settings: Number(counts.settings ?? 0),
    reviewLogs: Number(counts.review_logs ?? counts.reviewLogs ?? 0),
  }
}

export interface SqliteBackupResult {
  ok: boolean
  path?: string
  bytes?: number
  at?: number
  message?: string
}

export const SQLITE_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS states (
    word_id TEXT PRIMARY KEY, deck_id TEXT NOT NULL, phase TEXT NOT NULL,
    stability REAL NOT NULL, difficulty REAL NOT NULL, reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0, first_seen_at INTEGER, last_reviewed_at INTEGER,
    due_at INTEGER, next_interval_days INTEGER NOT NULL DEFAULT 1, retrievability REAL NOT NULL DEFAULT 0,
    last_rating TEXT, same_day_count INTEGER NOT NULL DEFAULT 0, same_day_date TEXT NOT NULL DEFAULT '',
    today_progress REAL, today_progress_level REAL, can_finish_today INTEGER,
    meaning_stats_json TEXT, core_sense_stats_json TEXT, part_stats_json TEXT,
    imported_from TEXT, imported_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_states_deck ON states(deck_id)`,
  `CREATE INDEX IF NOT EXISTS idx_states_due ON states(due_at)`,
  `CREATE INDEX IF NOT EXISTS idx_states_phase_due ON states(phase, due_at)`,
  `CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY, date TEXT NOT NULL, deck_id TEXT NOT NULL,
    word_ids_json TEXT NOT NULL, idx INTEGER NOT NULL DEFAULT 0, sources_json TEXT NOT NULL,
    goals_json TEXT NOT NULL, ratings_json TEXT NOT NULL, wc_counts_json TEXT,
    completed_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    UNIQUE(date, deck_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_plans_deck_date ON plans(deck_id, date)`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS review_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, word_id TEXT NOT NULL, deck_id TEXT NOT NULL,
    rating TEXT NOT NULL, reviewed_at INTEGER NOT NULL,
    stability_before REAL, difficulty_before REAL, stability_after REAL, difficulty_after REAL,
    elapsed_days INTEGER, next_interval_days INTEGER, retrievability_at_review REAL,
    long_term_update INTEGER NOT NULL DEFAULT 0, corrected INTEGER NOT NULL DEFAULT 0,
    corrected_by INTEGER, state_before_json TEXT, meaning_changes_json TEXT,
    phase_before TEXT, phase_after TEXT, client_op_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_word ON review_logs(word_id)`,
  `CREATE INDEX IF NOT EXISTS idx_logs_deck_time ON review_logs(deck_id, reviewed_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_logs_client_op ON review_logs(client_op_id)`,
  `CREATE TABLE IF NOT EXISTS client_ops (
    op_id TEXT PRIMARY KEY, kind TEXT NOT NULL, at INTEGER NOT NULL, result_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS diag (
    id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, at INTEGER NOT NULL,
    reason TEXT, deck_id TEXT, payload_json TEXT, error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_diag_kind_time ON diag(kind, at)`,
  `CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value_json TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS migration_state (
    step TEXT PRIMARY KEY, status TEXT NOT NULL, started_at INTEGER, finished_at INTEGER, error TEXT
  )`,
  `PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`,
]

export interface SqliteHealthInfo {
  userVersion: number
  wal: boolean
  synchronous: string
  readOnly: boolean
  integrityOk: boolean
  sizeBytes?: number
}

/** 读 health 并做 schema/只读校验；降级/高版本由 native onDowngrade 保护，这里再拒绝 */
export async function ensureSqliteReady(): Promise<SqliteHealthInfo> {
  const response = await sqliteHealth()
  const info: SqliteHealthInfo = {
    userVersion: Number(response.userVersion ?? 0),
    wal: response.wal === true,
    synchronous: String(response.synchronous ?? ''),
    readOnly: response.readOnly === true,
    integrityOk: response.integrityOk !== false,
    ...(response.sizeBytes != null ? { sizeBytes: response.sizeBytes } : {}),
  }
  if (info.readOnly) throw new Error('SQLite 处于只读恢复模式，拒绝写入')
  if (info.userVersion > SQLITE_SCHEMA_VERSION) {
    throw new Error(`SQLite schema 版本过高（${info.userVersion} > ${SQLITE_SCHEMA_VERSION}），请升级 App，不降级删库`)
  }
  return info
}

/** 若 user_version=0，由 JS 发 DDL；正常升级由 native onCreate 负责 */
export async function ensureSqliteSchema(): Promise<SqliteHealthInfo> {
  const info = await ensureSqliteReady()
  if (info.userVersion === 0) {
    // native 只接受 insert/upsert/update/delete/query，DDL 必须由 onCreate 建；
    // user_version=0 表示 native 初始化异常，不能发 'sql' op 掩盖。
    throw new Error('SQLite 未初始化（user_version=0）：应由 native onCreate 建表，拒绝继续')
  }
  return info
}

export function getSqliteHealth(): Promise<SqliteResponse> {
  return sqliteHealth()
}
export function sqliteStoreExec(ops: unknown[], opts: Parameters<typeof sqliteExec>[1] = {}): Promise<SqliteResponse> {
  return sqliteExec(ops, opts)
}
export function sqliteStoreTx(ops: unknown[], opts: Parameters<typeof sqliteTx>[1] = {}): Promise<SqliteResponse> {
  return sqliteTx(ops, opts)
}
export function sqliteStoreQuery<T = unknown>(
  query: Record<string, unknown>,
  timeoutMs?: number,
): Promise<SqliteResponse<T>> {
  return sqliteQuery<T>(query, timeoutMs)
}
export function sqliteStoreBackup(): Promise<SqliteResponse> {
  return sqliteBackup()
}
export function sqliteStoreRestoreDb(path: string): Promise<SqliteResponse> {
  return sqliteRestoreDb(path)
}
export function sqliteStoreIntegrity(): Promise<SqliteResponse> {
  return sqliteIntegrity()
}
export function sqliteStorePing(): Promise<SqliteResponse> {
  return sqliteCall({ method: 'health', timeoutMs: 5_000 })
}


export interface M4b0SchemaOptions {
  /** 升级前强制完整备份；失败拒绝 */
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  unsafe?: boolean
  expectedCounts?: Partial<SqliteTableCounts>
  sqliteHealthImpl?: () => Promise<{
    ok: boolean
    userVersion?: number
    counts?: Partial<Record<string, number>>
    data?: { counts?: Partial<Record<string, number>> }
    message?: string
  }>
  sqliteQueryImpl?: (query: Record<string, unknown>) => Promise<{ ok: boolean; rows?: unknown[]; message?: string }>
}

export interface M4b0SchemaResult {
  ok: boolean
  beforeVersion?: number
  userVersion?: number
  counts?: SqliteTableCounts
  migrationDone?: boolean
  cacheUpdated?: boolean
  error?: string
}

/**
 * M4b-0 门禁：v1→v2 schema 升级后校验 + cache meta 版本更新。
 * 注意：DB_VERSION=2 时 native health 打开即触发 onUpgrade；native 在 ALTER 前已复制 v1 DB。
 * JS 的 preBackup 作为额外应用级完整备份，必须在任何 sqlite 调用前执行。
 */
export async function ensureM4b0Schema(opts: M4b0SchemaOptions = {}): Promise<M4b0SchemaResult> {
  if (!opts.unsafe && opts.preBackup) {
    const backup = await opts.preBackup()
    if (backup && backup.ok === false) return { ok: false, error: `预备份失败，拒绝升级：${backup.error ?? '未知'}` }
  }
  const health = opts.sqliteHealthImpl ? await opts.sqliteHealthImpl() : await sqliteHealth()
  if (health.ok === false) return { ok: false, error: health.message ?? 'SQLite health 失败' }
  const userVersion = Number(health.userVersion ?? 0)
  if (userVersion < SQLITE_SCHEMA_VERSION) {
    return { ok: false, userVersion, error: `SQLite schema 仍为 v${userVersion}，升级未完成/失败，保持 v1` }
  }
  if (userVersion > SQLITE_SCHEMA_VERSION) {
    return { ok: false, userVersion, error: `SQLite schema 版本过高 v${userVersion}，拒绝操作` }
  }
  const counts = extractSqliteCounts(health as never)
  if (!counts) return { ok: false, userVersion, error: 'health 缺少 counts，拒绝升级校验' }
  if (opts.expectedCounts) {
    const expected = { states: 0, plans: 0, settings: 0, reviewLogs: 0, ...opts.expectedCounts }
    if (
      counts.states !== expected.states ||
      counts.plans !== expected.plans ||
      counts.settings !== expected.settings ||
      counts.reviewLogs !== expected.reviewLogs
    ) {
      return { ok: false, userVersion, counts, error: `升级前后 facts counts 不一致（${counts.states}/${counts.plans}/${counts.settings}/${counts.reviewLogs}）` }
    }
  }
  const query = opts.sqliteQueryImpl ?? ((q: Record<string, unknown>) => sqliteQuery(q, 5_000))
  let migrationDone = false
  try {
    const migration = await query({ table: 'migration_state', where: { step: 'legacy-idb' }, limit: 1 })
    const row = ((migration.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    migrationDone = row?.status === 'done'
  } catch (error) {
    return { ok: false, userVersion, counts, error: `migration_state 校验失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!migrationDone) return { ok: false, userVersion, counts, error: 'migration_state 未 done，拒绝 M4b-0' }
  const { getDataEpoch } = await import('./data-epoch')
  const { getIdbCacheMeta, writeIdbCacheMeta } = await import('./idb-cache')
  const epoch = await getDataEpoch()
  const existing = await getIdbCacheMeta()
  await writeIdbCacheMeta({
    generation: existing?.generation ?? epoch,
    sqliteUserVersion: SQLITE_SCHEMA_VERSION,
    rebuiltAt: existing?.rebuiltAt ?? Date.now(),
    dirty: false,
  })
  return { ok: true, userVersion, counts, migrationDone, cacheUpdated: true }
}


/** M4b-0 门禁：升级前 IDB 事实计数（用于升级后 health counts 对比） */
export async function getIdbFactCounts(): Promise<SqliteTableCounts> {
  const db = getDb()
  const [states, plans, settings, reviewLogs] = await Promise.all([
    db.states.count(),
    db.plans.count(),
    db.settings.count(),
    db.reviewLogs.count(),
  ])
  return { states, plans, settings, reviewLogs }
}
