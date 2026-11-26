/** 0.11.0 M4b-2-0：切换学习写事务前，把 IDB 当前 today plan reconcile 到 SQLite（IDB 是 M4b2 前事实） */
import type { DailyPlan } from './plan.types'
import { getDb } from './db'
import { bumpDataEpoch } from './data-epoch'
import { getSettings } from './settings.repo'
import { mapSqlitePlanRow } from './sqlite-read'
import { isSqliteAvailable, sqliteHealth, sqliteQuery, sqliteTx } from './native-sqlite'
import { SQLITE_SCHEMA_VERSION } from './sqlite-store'
import { planIdOf } from './plan-core'
import { localDateKey } from '../core'
import { withDataWriteLock } from './write-lock'

export interface ReconcilePlanResult {
  ok: boolean
  dryRun: boolean
  planId?: string
  idb?: { wordIdsLength: number; index: number; completedAt: number | null; updatedAt: number } | null
  sqlite?: { wordIdsLength: number; index: number; completedAt: number | null } | null
  changed: boolean
  error?: string
}

export interface ReconcilePlanOptions {
  dryRun?: boolean
  now?: number
  deckId?: string | null
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  unsafe?: boolean
  sqliteQueryImpl?: (query: Record<string, unknown>) => Promise<{ ok: boolean; rows?: unknown[]; message?: string }>
  sqliteTxImpl?: (ops: unknown[]) => Promise<{ ok: boolean; message?: string }>
  sqliteHealthImpl?: () => Promise<{ ok: boolean; userVersion?: number; counts?: Record<string, number>; message?: string }>
}

function planRow(plan: DailyPlan): Record<string, unknown> {
  return {
    id: plan.id,
    date: plan.date,
    deck_id: plan.deckId,
    word_ids_json: JSON.stringify(plan.wordIds),
    idx: plan.index,
    sources_json: JSON.stringify(plan.sources ?? {}),
    goals_json: JSON.stringify(plan.goals ?? {}),
    ratings_json: JSON.stringify(plan.ratings ?? []),
    wc_counts_json: plan.wcCounts ? JSON.stringify(plan.wcCounts) : null,
    completed_at: plan.completedAt != null && Number(plan.completedAt) > 0 ? plan.completedAt : null,
    created_at: plan.createdAt,
    updated_at: plan.updatedAt,
  }
}

/**
 * M4b-2-0：IDB 当前 plan → SQLite（不反向覆盖）。
 * - 非 dryRun 必须 preBackup；withDataWriteLock；
 * - upsert 后重读 SQLite 校验 wordIdsLength/index/completedAt；
 * - 成功后重建 IDB plan cache（此时两边一致）、epoch+1。
 */
export async function reconcileTodayPlanToSqlite(opts: ReconcilePlanOptions = {}): Promise<ReconcilePlanResult> {
  const dryRun = opts.dryRun === true
  const now = opts.now ?? Date.now()
  if (!isSqliteAvailable()) return { ok: false, dryRun, changed: false, error: 'SQLite 不可用' }
  const query = opts.sqliteQueryImpl ?? ((q: Record<string, unknown>) => sqliteQuery(q, 5_000))
  const tx = opts.sqliteTxImpl ?? ((ops: unknown[]) => sqliteTx(ops))
  const health = opts.sqliteHealthImpl ?? (() => sqliteHealth(30_000))
  const execute = async (): Promise<ReconcilePlanResult> => {
    const settings = await getSettings()
    const deckId = opts.deckId === undefined ? settings['data.selectedDeckId'] : opts.deckId
    if (!deckId) return { ok: false, dryRun, changed: false, error: '未选择词库' }
    const planId = planIdOf(localDateKey(now), deckId)
    const idbPlan = (await getDb().plans.get(planId)) ?? null
    if (!idbPlan) return { ok: false, dryRun, planId, changed: false, error: 'IDB 当前 plan 不存在，拒绝 reconcile' }
    const response = await query({ table: 'plans', where: { id: planId }, limit: 1 })
    if (response.ok === false) return { ok: false, dryRun, planId, changed: false, error: response.message ?? '查询 SQLite plan 失败' }
    const raw = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    const sqlitePlan = raw ? mapSqlitePlanRow(raw) : null
    const idb = { wordIdsLength: idbPlan.wordIds.length, index: idbPlan.index, completedAt: idbPlan.completedAt, updatedAt: idbPlan.updatedAt }
    const sqlite = sqlitePlan
      ? { wordIdsLength: sqlitePlan.wordIds.length, index: sqlitePlan.index, completedAt: sqlitePlan.completedAt }
      : null
    const changed =
      !sqlitePlan ||
      sqlitePlan.wordIds.length !== idbPlan.wordIds.length ||
      sqlitePlan.index !== idbPlan.index ||
      sqlitePlan.completedAt !== idbPlan.completedAt ||
      idbPlan.updatedAt > sqlitePlan.updatedAt
    if (!changed) return { ok: true, dryRun, planId, idb, sqlite, changed: false }
    if (dryRun) return { ok: true, dryRun: true, planId, idb, sqlite, changed: true }
    if (!opts.unsafe) {
      if (!opts.preBackup) return { ok: false, dryRun: false, planId, idb, sqlite, changed: true, error: 'reconcile 前必须完整备份' }
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) return { ok: false, dryRun: false, planId, idb, sqlite, changed: true, error: `预备份失败：${backup.error ?? '未知'}` }
    }
    const beforeHealth = await health()
    if (Number(beforeHealth.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) {
      return { ok: false, dryRun: false, planId, idb, sqlite, changed: true, error: `SQLite schema 不是 v${SQLITE_SCHEMA_VERSION}` }
    }
    const write = await tx([{ op: 'upsert', table: 'plans', row: planRow(idbPlan) }])
    if (write.ok === false) return { ok: false, dryRun: false, planId, idb, sqlite, changed: true, error: write.message ?? 'SQLite plan 写入失败' }
    const after = await query({ table: 'plans', where: { id: planId }, limit: 1 })
    const afterRaw = ((after.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]
    const afterPlan = afterRaw ? mapSqlitePlanRow(afterRaw) : null
    if (
      !afterPlan ||
      afterPlan.wordIds.length !== idbPlan.wordIds.length ||
      afterPlan.index !== idbPlan.index ||
      afterPlan.completedAt !== idbPlan.completedAt
    ) {
      return { ok: false, dryRun: false, planId, idb, sqlite, changed: true, error: 'reconcile 后 SQLite 校验不一致' }
    }
    await bumpDataEpoch('reconcile-today-plan')
    return {
      ok: true,
      dryRun: false,
      planId,
      idb,
      sqlite: { wordIdsLength: afterPlan.wordIds.length, index: afterPlan.index, completedAt: afterPlan.completedAt },
      changed: true,
    }
  }
  return dryRun ? execute() : withDataWriteLock(execute)
}
