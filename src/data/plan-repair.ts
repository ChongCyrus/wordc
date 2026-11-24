/** 0.11.0 M4b 门禁：修复 M3 迁移/重建后 plan 字段（completed_at<=0→NULL、idx clamp、空 word_ids 回退 IDB） */
import type { DailyPlan } from './plan.types'
import { getDb } from './db'
import { isSqliteAvailable, sqliteQuery, sqliteTx } from './native-sqlite'
import { mapSqlitePlanRow } from './sqlite-read'
import { withDataWriteLock } from './write-lock'

export interface PlanRepairChange {
  id: string
  before: { completedAt: unknown; index: number; wordIds: number }
  after: { completedAt: number | null; index: number; wordIds: number }
  reason: string
}

export interface PlanRepairResult {
  ok: boolean
  dryRun: boolean
  scanned: number
  changes: PlanRepairChange[]
  applied: number
  /** 无法从 SQLite/IDB 恢复词表的 plan（需用备份/人工处理） */
  unrecoverable?: string[]
  error?: string
}

export interface RepairPlansOptions {
  dryRun?: boolean
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  unsafe?: boolean
  sqliteQueryImpl?: (query: Record<string, unknown>) => Promise<{ ok: boolean; rows?: unknown[]; message?: string }>
  sqliteTxImpl?: (ops: unknown[]) => Promise<{ ok: boolean; message?: string }>
  onProgress?: (progress: { done: number; total: number }) => void
}

function normalizeCompletedAt(value: unknown): number | null {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : null
}

function parseWordIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((id): id is string => typeof id === 'string')
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
    } catch {
      return []
    }
  }
  return []
}

function clampIndex(value: unknown, length: number): number {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(Math.floor(number), length))
}

function planRow(plan: DailyPlan, now: number): Record<string, unknown> {
  return {
    id: plan.id, date: plan.date, deck_id: plan.deckId,
    word_ids_json: JSON.stringify(plan.wordIds), idx: plan.index,
    sources_json: JSON.stringify(plan.sources ?? {}), goals_json: JSON.stringify(plan.goals ?? {}),
    ratings_json: JSON.stringify(plan.ratings ?? []),
    wc_counts_json: plan.wcCounts ? JSON.stringify(plan.wcCounts) : null,
    completed_at: normalizeCompletedAt(plan.completedAt),
    created_at: plan.createdAt ?? now, updated_at: now,
  }
}

/**
 * 一次性 repair（只修 plan 字段，不动 states/words）：
 * - completed_at<=0 / NaN → NULL；
 * - idx clamp 0..wordIds.length；
 * - word_ids_json 非数组/空 → 回退同 id 的 IDB plan；仍为空则保留原行并仅清 completedAt。
 * 非 dryRun 需 preBackup；失败不写。
 */
export async function repairMigratedPlans(opts: RepairPlansOptions = {}): Promise<PlanRepairResult> {
  const dryRun = opts.dryRun !== false
  if (!isSqliteAvailable()) return { ok: false, dryRun, scanned: 0, changes: [], applied: 0, error: '当前环境不支持原生 SQLite' }
  const query = opts.sqliteQueryImpl ?? ((q: Record<string, unknown>) => sqliteQuery(q))
  const tx = opts.sqliteTxImpl ?? ((ops: unknown[]) => sqliteTx(ops))
  const execute = async (): Promise<PlanRepairResult> => {
    const db = getDb()
    // M4 P1：plans 可能 >1000，必须按主键分页全量扫描
    const rows: Array<Record<string, unknown>> = []
    const seen = new Set<string>()
    const pageSize = 500
    for (let offset = 0; offset < 10_000_000; offset += pageSize) {
      const response = await query({ table: 'plans', limit: pageSize, offset, orderBy: 'id', direction: 'asc' })
      if (!response.ok) return { ok: false, dryRun, scanned: rows.length, changes: [], applied: 0, error: response.message ?? '查询 plans 失败' }
      const page = (response.rows as Array<Record<string, unknown>> | undefined) ?? []
      let added = 0
      for (const row of page) {
        const id = String(row.id)
        if (seen.has(id)) continue
        seen.add(id)
        rows.push(row)
        added += 1
      }
      if (added === 0) {
        return { ok: false, dryRun, scanned: rows.length, changes: [], applied: 0, error: 'plans 分页未生效（返回重复行），拒绝漏修' }
      }
      if (page.length < pageSize) break
    }
    const idbPlans = new Map((await db.plans.toArray()).map((plan) => [plan.id, plan]))
    const changes: PlanRepairChange[] = []
    const repairedPlans: DailyPlan[] = []
    const ops: unknown[] = []
    let index = 0
    for (const row of rows) {
      index += 1
      const mapped = mapSqlitePlanRow(row)
      const idb = idbPlans.get(String(row.id))
      let wordIds = parseWordIds(row.word_ids_json)
      let reason = ''
      if (wordIds.length === 0 && idb && idb.wordIds.length > 0) {
        wordIds = idb.wordIds
        reason = 'word_ids 空，回退 IDB'
      }
      const completedAt = normalizeCompletedAt(row.completed_at)
      const rawIndex = Number(row.idx ?? 0)
      const rawCompleted = row.completed_at
      const completedNeedsFix = rawCompleted != null && (!Number.isFinite(Number(rawCompleted)) || Number(rawCompleted) <= 0)
      const indexFullButNotCompleted = completedAt == null && wordIds.length > 0 && rawIndex >= wordIds.length
      let clampedIndex = clampIndex(rawIndex, wordIds.length)
      if (indexFullButNotCompleted) {
        clampedIndex = 0
        reason = reason || 'completedAt=null 但 index 已满，回到 index0'
      }
      const changed =
        completedNeedsFix ||
        indexFullButNotCompleted ||
        clampedIndex !== rawIndex ||
        (reason !== '' && wordIds.length > 0)
      if (changed) {
        const next: DailyPlan = {
          ...mapped,
          wordIds,
          index: clampedIndex,
          completedAt,
          updatedAt: Date.now(),
        }
        repairedPlans.push(next)
        ops.push({ op: 'upsert', table: 'plans', row: planRow(next, Date.now()) })
        changes.push({
          id: String(row.id),
          before: { completedAt: rawCompleted, index: Number(row.idx ?? 0), wordIds: parseWordIds(row.word_ids_json).length },
          after: { completedAt, index: clampedIndex, wordIds: wordIds.length },
          reason: reason || 'completed_at/idx/word_ids 归一化',
        })
      }
      opts.onProgress?.({ done: index, total: rows.length })
    }
    if (dryRun) return { ok: true, dryRun: true, scanned: rows.length, changes, applied: 0 }
    if (!opts.unsafe) {
      if (!opts.preBackup) return { ok: false, dryRun: false, scanned: rows.length, changes, applied: 0, error: 'plan repair 前必须先完整备份' }
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) return { ok: false, dryRun: false, scanned: rows.length, changes, applied: 0, error: `预备份失败：${backup.error ?? '未知'}` }
    }
    if (ops.length > 0) {
      const result = await tx(ops)
      if (result.ok === false) return { ok: false, dryRun: false, scanned: rows.length, changes, applied: 0, error: result.message ?? 'plan repair 写入失败' }
    }
    try {
      // 同步修复 IDB cache 中的 plan 字段（只 plans，不动 states）
      if (repairedPlans.length > 0) await db.plans.bulkPut(repairedPlans)
    } catch (error) {
      return { ok: false, dryRun: false, scanned: rows.length, changes, applied: ops.length, error: `SQLite 已修但 IDB cache 写入失败：${error instanceof Error ? error.message : String(error)}` }
    }
    return { ok: true, dryRun: false, scanned: rows.length, changes, applied: ops.length }
  }
  return dryRun ? execute() : withDataWriteLock(execute)
}
