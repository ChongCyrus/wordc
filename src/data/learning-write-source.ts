/** 0.11.0 M4b-2：学习写源（states/plans/reviewLogs）切换门禁；sqlite 失败进入只读，不回退 IDB 双源 */
import { getDb } from './db'
import { getIdbCacheMeta } from './idb-cache'
import { isSqliteAvailable, sqliteHealth, sqliteQuery } from './native-sqlite'
import { readPlanFromSqliteRaw } from './sqlite-read'
import { SQLITE_SCHEMA_VERSION } from './sqlite-store'
import { rebuildIdbCacheFromSqlite } from './cache-rebuild'
import { withDataWriteLock } from './write-lock'

function extractSqliteCountsFromHealth(healthValue: unknown): { states: number; plans: number; settings: number; reviewLogs: number } | null {
  const health = healthValue as { counts?: Record<string, number>; data?: { counts?: Record<string, number> } } | null | undefined
  const counts = health?.counts ?? health?.data?.counts
  if (!counts) return null
  return {
    states: Number(counts.states ?? 0),
    plans: Number(counts.plans ?? 0),
    settings: Number(counts.settings ?? 0),
    reviewLogs: Number(counts.review_logs ?? counts.reviewLogs ?? 0),
  }
}

export type LearningWriteSource = 'idb' | 'sqlite' | 'readonly'
export const LEARNING_WRITE_SOURCE_KEY = 'data.learningWriteSource'

let learningWriteSource: LearningWriteSource = 'idb'

export function getLearningWriteSource(): LearningWriteSource {
  return learningWriteSource
}

export async function persistLearningWriteSource(source: LearningWriteSource): Promise<void> {
  learningWriteSource = source
  await getDb().meta.put({ key: LEARNING_WRITE_SOURCE_KEY, value: { source, enabledAt: Date.now(), schemaVersion: SQLITE_SCHEMA_VERSION }, updatedAt: Date.now() })
}

/** 启动恢复：meta=sqlite 必须校验通过；失败进入 readonly，绝不回退 IDB 写 */
export interface LearningWriteRestoreDiag {
  at: number
  wanted?: string
  bridge: boolean
  health?: { ok: boolean; userVersion?: number; readOnly?: boolean; counts?: Record<string, number>; error?: string }
  cache?: { ok: boolean; dirty?: boolean; sqliteUserVersion?: number; error?: string }
  plan?: { ok: boolean; idbLength?: number; sqliteLength?: number; error?: string }
  rebuild?: { ok: boolean; error?: string; delta?: unknown }
  recovered?: boolean
  error?: string
}

export async function getLearningWriteDiagnostics(): Promise<LearningWriteRestoreDiag | null> {
  const row = await getDb().meta.get('learningWrite.diag')
  return (row?.value as LearningWriteRestoreDiag | undefined) ?? null
}

/** 启动恢复：meta=sqlite 必须校验通过；失败先尝试从 SQLite 重建 cache/plan，再失败进 readonly */
export async function restoreLearningWriteSource(): Promise<LearningWriteSource> {
  const row = await getDb().meta.get(LEARNING_WRITE_SOURCE_KEY)
  const value = row?.value as { source?: LearningWriteSource } | string | undefined
  const wanted = typeof value === 'string' ? value : value?.source
  if (wanted === 'readonly') {
    learningWriteSource = 'readonly'
    return learningWriteSource
  }
  if (wanted !== 'sqlite') {
    // 0.11.0-rc1 修复：自动迁移超时/进程重启后，meta 可能缺失但 SQLite 已迁移完成；
    // 仅在无显式写源、无 rollback manifest、migration_state=done 时自动收尾为 sqlite。
    if (wanted == null) {
      try {
        const health = await sqliteHealth(5_000)
        const counts = extractSqliteCountsFromHealth(health)
        const sqliteHasFacts = counts && (counts.states > 0 || counts.plans > 0 || counts.settings > 0 || counts.reviewLogs > 0)
        const rollback = await getDb().meta.get('rollback.manifest')
        if (sqliteHasFacts && !rollback) {
          const mig = await sqliteQuery({ table: 'migration_state', where: { step: 'legacy-idb' }, limit: 1 }, 5_000)
          const done = ((mig.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]?.status === 'done'
          if (done) {
            const { rebuildIdbCacheFromSqlite } = await import('./cache-rebuild')
            const cache = await getIdbCacheMeta()
            if (!cache || cache.dirty || cache.sqliteUserVersion !== SQLITE_SCHEMA_VERSION) {
              await rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true }).catch(() => undefined)
            }
            learningWriteSource = 'sqlite'
            await persistLearningWriteSource('sqlite').catch(() => undefined)
            const { persistSettingsWriteMode } = await import('./settings.repo')
            await persistSettingsWriteMode('sqlite').catch(() => undefined)
            return learningWriteSource
          }
        }
      } catch {
        /* 回退 idb 安全 */
      }
    }
    learningWriteSource = 'idb'
    return learningWriteSource
  }
  const diag: LearningWriteRestoreDiag = { at: Date.now(), wanted, bridge: isSqliteAvailable() }
  try {
    if (!diag.bridge) throw new Error('SQLite bridge 不可用')
    const health = await sqliteHealth(5_000)
    diag.health = {
      ok: health.ok !== false,
      userVersion: Number(health.userVersion ?? 0),
      readOnly: health.readOnly === true,
      ...((health as unknown as { counts?: Record<string, number> }).counts ? { counts: (health as unknown as { counts?: Record<string, number> }).counts } : {}),
    }
    if (health.ok === false) throw new Error(health.message ?? 'health 失败')
    if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) throw new Error(`schema=${String(health.userVersion ?? 0)}`)
    if (health.readOnly === true) throw new Error('SQLite readOnly=true')
    const checkCache = async (): Promise<void> => {
      const cache = await getIdbCacheMeta()
      diag.cache = { ok: Boolean(cache && !cache.dirty && cache.sqliteUserVersion === SQLITE_SCHEMA_VERSION), dirty: cache?.dirty, sqliteUserVersion: cache?.sqliteUserVersion }
      if (!cache || cache.dirty || cache.sqliteUserVersion !== SQLITE_SCHEMA_VERSION) throw new Error('IDB cache 未就绪')
    }
    const checkPlan = async (): Promise<void> => {
      const settings = await (await import('./settings.repo')).getSettings()
      const deckId = settings['data.selectedDeckId']
      if (!deckId) return
      const { planIdOf } = await import('./plan-core')
      const { localDateKey } = await import('../core')
      const id = planIdOf(localDateKey(Date.now()), deckId)
      const idbPlan = await getDb().plans.get(id)
      const sqlitePlan = await readPlanFromSqliteRaw(id)
      diag.plan = { ok: Boolean(sqlitePlan && idbPlan && sqlitePlan.wordIds.length === idbPlan.wordIds.length), idbLength: idbPlan?.wordIds.length, sqliteLength: sqlitePlan?.wordIds.length }
      if (!diag.plan.ok) throw new Error('IDB/SQLite plan 长度不一致')
    }
    try {
      await checkCache()
      await checkPlan()
    } catch (error) {
      // 可恢复：以 SQLite 事实重建 cache/plan，再重试一次；成功则不降级 readonly
      diag.error = error instanceof Error ? error.message : String(error)
      const { rebuildIdbCacheFromSqlite } = await import('./cache-rebuild')
      const rebuilt = await rebuildIdbCacheFromSqlite({ unsafe: true })
      diag.rebuild = {
        ok: rebuilt.ok,
        ...(rebuilt.error ? { error: rebuilt.error } : {}),
        ...(rebuilt.conflict ? { error: `conflict: ${rebuilt.conflict}` } : {}),
        ...(rebuilt.delta ? { delta: rebuilt.delta } : {}),
      }
      if (!rebuilt.ok) throw new Error(`cache 重建失败：${rebuilt.error ?? rebuilt.conflict ?? '未知'}`)
      diag.recovered = true
      await checkCache()
      await checkPlan()
    }
    learningWriteSource = 'sqlite'
    delete diag.error
  } catch (error) {
    learningWriteSource = 'readonly'
    diag.error = error instanceof Error ? error.message : String(error)
  }
  await getDb().meta.put({ key: 'learningWrite.diag', value: diag, updatedAt: Date.now() }).catch(() => undefined)
  return learningWriteSource
}

export interface EnableLearningSqliteResult {
  ok: boolean
  source?: LearningWriteSource
  error?: string
  planWordIdsLength?: number
}

/** M4b-2-1 门禁：备份 + plan reconcile + schema/cache 校验后开启学习 SQLite 写 */
export async function enableLearningSqliteWrite(opts: {
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  expectedPlanWordIds?: number
} = {}): Promise<EnableLearningSqliteResult> {
  if (!isSqliteAvailable()) return { ok: false, error: 'SQLite 不可用' }
  const execute = async (): Promise<EnableLearningSqliteResult> => {
    if (opts.preBackup) {
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) return { ok: false, error: `预备份失败：${backup.error ?? '未知'}` }
    }
    const health = await sqliteHealth(5_000)
    if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) return { ok: false, error: `schema 不是 v${SQLITE_SCHEMA_VERSION}` }
    const cache = await getIdbCacheMeta()
    if (!cache || cache.dirty || cache.sqliteUserVersion !== SQLITE_SCHEMA_VERSION) return { ok: false, error: 'IDB cache 未就绪' }
    const settings = await (await import('./settings.repo')).getSettings()
    const deckId = settings['data.selectedDeckId']
    if (!deckId) return { ok: false, error: '未选择词库' }
    const { planIdOf } = await import('./plan-core')
    const { localDateKey } = await import('../core')
    const planId = planIdOf(localDateKey(Date.now()), deckId)
    const idbPlan = await getDb().plans.get(planId)
    const sqlitePlan = await readPlanFromSqliteRaw(planId)
    if (!idbPlan || !sqlitePlan) return { ok: false, error: 'current plan 不完整，先 reconcile' }
    if (idbPlan.wordIds.length !== sqlitePlan.wordIds.length || idbPlan.index !== sqlitePlan.index || idbPlan.completedAt !== sqlitePlan.completedAt) {
      return { ok: false, error: 'IDB/SQLite plan 不一致，先 reconcile' }
    }
    if (opts.expectedPlanWordIds != null && sqlitePlan.wordIds.length !== opts.expectedPlanWordIds) {
      return { ok: false, error: `plan wordIds=${sqlitePlan.wordIds.length} 与预期 ${opts.expectedPlanWordIds} 不一致` }
    }
    await persistLearningWriteSource('sqlite')
    return { ok: true, source: 'sqlite', planWordIdsLength: sqlitePlan.wordIds.length }
  }
  return withDataWriteLock(execute)
}

/** 显式回退：先以 SQLite 重建 IDB plan/cache 并校验一致，才允许改回 idb */
export async function revertLearningWriteSourceToIdb(opts: { preBackup?: () => Promise<void | { ok: boolean; error?: string }> } = {}): Promise<{ ok: boolean; error?: string }> {
  const execute = async () => {
    if (opts.preBackup) {
      const backup = await opts.preBackup()
      if (backup && backup.ok === false) return { ok: false, error: `预备份失败：${backup.error ?? '未知'}` }
    }
    // 门禁：完整 M4a cache 重建（states/plans/settings/reviewLogs）+ 校验，才允许回 idb
    const rebuilt = await rebuildIdbCacheFromSqlite({ unsafe: true, dryRun: false, skipWriteLock: true })
    if (!rebuilt.ok) return { ok: false, error: `cache 重建失败：${rebuilt.error ?? rebuilt.conflict ?? '未知'}` }
    const settings = await (await import('./settings.repo')).getSettings()
    const deckId = settings['data.selectedDeckId']
    if (deckId) {
      const { planIdOf } = await import('./plan-core')
      const { localDateKey } = await import('../core')
      const planId = planIdOf(localDateKey(Date.now()), deckId)
      const idbPlan = await getDb().plans.get(planId)
      const sqlitePlan = await readPlanFromSqliteRaw(planId)
      if (!idbPlan || !sqlitePlan || idbPlan.wordIds.length !== sqlitePlan.wordIds.length || idbPlan.index !== sqlitePlan.index) {
        return { ok: false, error: 'SQLite/IDB plan 仍不一致，拒绝回退' }
      }
    }
    await persistLearningWriteSource('idb')
    return { ok: true }
  }
  return withDataWriteLock(execute)
}

/** 只读恢复模式：不可重试，UI 引导诊断/备份恢复 */
export class LearningWriteReadonlyError extends Error {
  readonly retryable = false
  readonly code = 'LEARNING_READONLY'
  constructor(message: string) {
    super(message)
    this.name = 'LearningWriteReadonlyError'
  }
}

/** 评分冲突/锁失败用可重试错误，UI 保留输入 */
export class LearningWriteRetryableError extends Error {
  readonly retryable = true
  constructor(message: string) {
    super(message)
    this.name = 'LearningWriteRetryableError'
  }
}


/** 批次A：sqlite 模式下禁止只写 IDB 的破坏性操作，直到对应 SQLite 事务实现 */
export function assertIdbMutationAllowed(operation: string): void {
  const source = getLearningWriteSource()
  if (source === 'readonly') throw new LearningWriteReadonlyError(`学习数据库只读，禁止 ${operation}`)
  if (source === 'sqlite') throw new LearningWriteReadonlyError(`${operation} 尚未实现 SQLite 事务，已拒绝以避免 IDB/SQLite 双源`)
}
