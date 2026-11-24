/** 0.11.0 M6：SQLite→IDB 回退缓存/0.10 迁移包/再次升级 delta 检测 */
import { getDb } from './db'
import { withDataWriteLock } from './write-lock'
import { getDataEpoch } from './data-epoch'
import { rebuildIdbCacheFromSqlite } from './cache-rebuild'
import { exportMigrationText } from './import-export'
import { isSqliteAvailable, sqliteHealth, sqliteQuery } from './native-sqlite'
import { extractSqliteCounts } from './sqlite-store'

export const ROLLBACK_MANIFEST_KEY = 'rollback.manifest'

export interface RollbackManifest {
  format: 'momo-rollback-manifest'
  formatVersion: 1
  createdAt: number
  dataEpoch: number
  counts: { states: number; plans: number; settings: number; reviewLogs: number }
  sqliteUserVersion: number
  appVersion: string
}

function idbCounts() {
  const db = getDb()
  return Promise.all([db.states.count(), db.plans.count(), db.settings.count(), db.reviewLogs.count()]).then(
    ([states, plans, settings, reviewLogs]) => ({ states, plans, settings, reviewLogs }),
  )
}

/** 回退门禁：SQLite→IDB 完整重建 + counts/抽样/generation/dirty 校验 + manifest */
export async function buildIdbRollbackCache(opts: {
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  appVersion?: string
} = {}): Promise<{ ok: boolean; manifest?: RollbackManifest; error?: string }> {
  if (!isSqliteAvailable()) return { ok: false, error: 'SQLite 不可用' }
  if (opts.preBackup) {
    const backup = await opts.preBackup()
    if (backup && backup.ok === false) return { ok: false, error: `预备份失败：${backup.error ?? '未知'}` }
  }
  const rebuilt = await rebuildIdbCacheFromSqlite({ unsafe: true })
  if (!rebuilt.ok) return { ok: false, error: `IDB 回退缓存重建失败：${rebuilt.error ?? rebuilt.conflict ?? '未知'}` }
  const health = await sqliteHealth(5_000)
  const sqliteCounts = extractSqliteCounts(health as never)
  const counts = await idbCounts()
  if (!sqliteCounts || counts.states !== sqliteCounts.states || counts.plans !== sqliteCounts.plans || counts.settings !== sqliteCounts.settings || counts.reviewLogs !== sqliteCounts.reviewLogs) {
    return { ok: false, error: '回退后 IDB/SQLite counts 不一致' }
  }
  const manifest: RollbackManifest = {
    format: 'momo-rollback-manifest',
    formatVersion: 1,
    createdAt: Date.now(),
    dataEpoch: await getDataEpoch(),
    counts,
    sqliteUserVersion: Number(health.userVersion ?? 0),
    appVersion: opts.appVersion ?? '0.11.0',
  }
  await getDb().meta.put({ key: ROLLBACK_MANIFEST_KEY, value: manifest, updatedAt: Date.now() })
  return { ok: true, manifest }
}

/** 生成 0.10 可读学习进度迁移 JSON（基于已重建 IDB） */
export async function buildRollbackMigrationText(): Promise<string> {
  const text = await exportMigrationText()
  const parsed = JSON.parse(text) as Record<string, unknown>
  return JSON.stringify({ ...parsed, rollback: { forVersion: '0.10.0', source: 'sqlite-rollback', at: Date.now() } })
}

async function queryAll(table: string, key: string): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (let offset = 0; offset < 1_000_000; offset += 500) {
    const response = await sqliteQuery({ table, limit: 500, offset, orderBy: key, direction: 'asc' }, 5_000)
    if (response.ok === false) throw new Error((response as { message?: string }).message ?? 'query failed')
    const page = (response.rows as Array<Record<string, unknown>> | undefined) ?? []
    for (const row of page) {
      const id = String(row[key] ?? '')
      if (seen.has(id)) continue
      seen.add(id)
      out.push(row)
    }
    if (page.length < 500) break
  }
  return out
}

/** 再次 0.11 升级：分页检测 IDB 回退期间新增/更新，非空必须 apply delta 或拒绝 */
export async function detectIdbDeltaSinceSqlite(): Promise<{ hasDelta: boolean; states: number; plans: number; reviewLogs: number; settings: number; deletedStates: string[]; deletedPlans: string[]; deletedLogs: string[]; deletedSettings: string[]; stateRows: unknown[]; planRows: unknown[]; logRows: unknown[]; settingRows: unknown[] }> {
  const db = getDb()
  const [idbStates, idbPlans, idbLogs, idbSettings, sqliteStates, sqlitePlans, sqliteLogs, sqliteSettings] = await Promise.all([
    db.states.toArray(), db.plans.toArray(), db.reviewLogs.toArray(), db.settings.toArray(),
    queryAll('states', 'word_id'), queryAll('plans', 'id'), queryAll('review_logs', 'id'), queryAll('settings', 'key'),
  ])
  const stateMap = new Map(sqliteStates.map((row) => [String(row.word_id), Number(row.updated_at ?? 0)]))
  const planMap = new Map(sqlitePlans.map((row) => [String(row.id), Number(row.updated_at ?? 0)]))
  const logIds = new Set(sqliteLogs.map((row) => String(row.id)))
  const stateRows = idbStates.filter((state) => (stateMap.get(state.wordId) ?? -1) < state.updatedAt)
  const planRows = idbPlans.filter((plan) => (planMap.get(plan.id) ?? -1) < plan.updatedAt)
  const logRows = idbLogs.filter((log) => log.id != null && !logIds.has(String(log.id)))
  const settingMap = new Map(sqliteSettings.map((row) => [String(row.key), Number(row.updated_at ?? 0)]))
  const settingRows = idbSettings.filter((setting) => (settingMap.get(setting.key) ?? -1) < setting.updatedAt)
  const idbStateIds = new Set(idbStates.map((state) => state.wordId))
  const idbPlanIds = new Set(idbPlans.map((plan) => plan.id))
  const idbLogIds = new Set(idbLogs.map((log) => String(log.id)))
  const idbSettingKeys = new Set<string>(idbSettings.map((setting) => String(setting.key)))
  const deletedStates = sqliteStates.map((row) => String(row.word_id)).filter((id) => !idbStateIds.has(id))
  const deletedPlans = sqlitePlans.map((row) => String(row.id)).filter((id) => !idbPlanIds.has(id))
  const deletedLogs = sqliteLogs.map((row) => String(row.id)).filter((id) => !idbLogIds.has(id))
  const deletedSettings = sqliteSettings.map((row) => String(row.key)).filter((key) => !idbSettingKeys.has(key))
  return { hasDelta: stateRows.length + planRows.length + logRows.length + settingRows.length + deletedStates.length + deletedPlans.length + deletedLogs.length + deletedSettings.length > 0, states: stateRows.length, plans: planRows.length, reviewLogs: logRows.length, settings: settingRows.length, deletedStates, deletedPlans, deletedLogs, deletedSettings, stateRows, planRows, logRows, settingRows }
}

/** 升级前把 IDB delta upsert 回 SQLite；preBackup 失败/无 delta 拒绝写 */
export function applyIdbDeltaToSqlite(opts: { preBackup?: () => Promise<void | { ok: boolean; error?: string }> } = {}): Promise<{ ok: boolean; applied: { states: number; plans: number; reviewLogs: number; settings: number }; error?: string }> {
  return withDataWriteLock(() => applyIdbDeltaToSqliteInner(opts))
}

async function applyIdbDeltaToSqliteInner(opts: { preBackup?: () => Promise<void | { ok: boolean; error?: string }> } = {}): Promise<{ ok: boolean; applied: { states: number; plans: number; reviewLogs: number; settings: number }; error?: string }> {
  const delta = await detectIdbDeltaSinceSqlite()
  if (!delta.hasDelta) return { ok: true, applied: { states: 0, plans: 0, reviewLogs: 0, settings: 0 } }
  // 0.10 回退期删除：SQLite 有、IDB 无。默认拒绝，需人工确认/manifest 安全删除。
  if (delta.deletedStates.length + delta.deletedPlans.length + delta.deletedLogs.length + delta.deletedSettings.length > 0) {
    return { ok: false, applied: { states: 0, plans: 0, reviewLogs: 0, settings: 0 }, error: `检测到 SQLite 有、IDB 无的删除候选（states ${delta.deletedStates.length}/plans ${delta.deletedPlans.length}/logs ${delta.deletedLogs.length}/settings ${delta.deletedSettings.length}），默认拒绝升级；需人工确认后安全删除` }
  }
  if (!opts.preBackup) return { ok: false, applied: { states: 0, plans: 0, reviewLogs: 0, settings: 0 }, error: '升级 delta 前必须完整备份' }
  const backup = await opts.preBackup()
  if (backup && backup.ok === false) return { ok: false, applied: { states: 0, plans: 0, reviewLogs: 0, settings: 0 }, error: `预备份失败：${backup.error ?? '未知'}` }
  const { buildStateSqliteRow } = await import('./study-sqlite')
  const { planRow } = await import('./plan-sqlite')
  const ops: unknown[] = []
  for (const state of delta.stateRows as Array<Parameters<typeof buildStateSqliteRow>[0]>) ops.push({ op: 'upsert', table: 'states', row: buildStateSqliteRow(state) })
  for (const plan of delta.planRows as Array<import('./plan.types').DailyPlan>) ops.push({ op: 'upsert', table: 'plans', row: planRow(plan) })
  for (const setting of delta.settingRows as Array<{ key: string; value: unknown; updatedAt: number }>) ops.push({ op: 'upsert', table: 'settings', row: { key: setting.key, value_json: JSON.stringify(setting.value), updated_at: setting.updatedAt } })
  for (const log of delta.logRows as Array<Record<string, unknown>>) {
    const row: Record<string, unknown> = {
      word_id: log.wordId, deck_id: log.deckId, rating: log.rating, reviewed_at: log.reviewedAt,
      stability_before: log.stabilityBefore, difficulty_before: log.difficultyBefore, stability_after: log.stabilityAfter, difficulty_after: log.difficultyAfter,
      elapsed_days: log.elapsedDays, next_interval_days: log.nextIntervalDays, retrievability_at_review: log.retrievabilityAtReview ?? null,
      long_term_update: log.longTermUpdate ? 1 : 0, corrected: log.corrected ? 1 : 0, corrected_by: log.correctedBy ?? null,
      state_before_json: log.stateBefore ? JSON.stringify(log.stateBefore) : null, meaning_changes_json: log.meaningChanges ? JSON.stringify(log.meaningChanges) : null,
      phase_before: log.phaseBefore ?? null, phase_after: log.phaseAfter ?? null,
    }
    if (log.id != null) row.id = log.id
    ops.push({ op: 'upsert', table: 'review_logs', row })
  }
  let tx
  try {
    tx = await (await import('./native-sqlite')).sqliteTx(ops)
  } catch (error) {
    const { persistLearningWriteSource } = await import('./learning-write-source')
    await persistLearningWriteSource('readonly').catch(() => undefined)
    return { ok: false, applied: { states: 0, plans: 0, reviewLogs: 0, settings: 0 }, error: error instanceof Error ? error.message : String(error) }
  }
  if (tx.ok === false) {
    const { persistLearningWriteSource } = await import('./learning-write-source')
    await persistLearningWriteSource('readonly').catch(() => undefined)
    return { ok: false, applied: { states: 0, plans: 0, reviewLogs: 0, settings: 0 }, error: tx.message ?? 'delta 写入失败' }
  }
  // apply 后强校验：SQLite health counts 必须与 IDB 一致
  try {
    const { sqliteHealth } = await import('./native-sqlite')
    const { extractSqliteCounts } = await import('./sqlite-store')
    const health = await sqliteHealth(5_000)
    const sqliteCounts = extractSqliteCounts(health as never)
    const idb = await getDb()
    const counts = await Promise.all([idb.states.count(), idb.plans.count(), idb.settings.count(), idb.reviewLogs.count()])
    if (!sqliteCounts || counts[0] !== sqliteCounts.states || counts[1] !== sqliteCounts.plans || counts[2] !== sqliteCounts.settings || counts[3] !== sqliteCounts.reviewLogs) {
      const { persistLearningWriteSource } = await import('./learning-write-source')
      await persistLearningWriteSource('readonly').catch(() => undefined)
      return { ok: false, applied: { states: delta.states, plans: delta.plans, reviewLogs: delta.reviewLogs, settings: delta.settings }, error: 'delta apply 后 SQLite/IDB counts 不一致' }
    }
  } catch (error) {
    const { persistLearningWriteSource } = await import('./learning-write-source')
    await persistLearningWriteSource('readonly').catch(() => undefined)
    return { ok: false, applied: { states: delta.states, plans: delta.plans, reviewLogs: delta.reviewLogs, settings: delta.settings }, error: `delta apply 后校验失败：${error instanceof Error ? error.message : String(error)}` }
  }
  return { ok: true, applied: { states: delta.states, plans: delta.plans, reviewLogs: delta.reviewLogs, settings: delta.settings } }
}
