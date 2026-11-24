/** rc2f：只读写源恢复/修复（强制中断的 SQLite 导入/迁移） */
import { getDb } from './db'
import { getDataEpoch } from './data-epoch'
import { getLearningWriteSource, persistLearningWriteSource } from './learning-write-source'
import { persistSettingsWriteMode } from './settings.repo'
import { rebuildIdbCacheFromSqlite } from './cache-rebuild'
import { isSqliteAvailable, sqliteHealth, sqliteIntegrity } from './native-sqlite'
import { extractSqliteCounts, SQLITE_SCHEMA_VERSION } from './sqlite-store'
import { listSqliteBackupFiles, getSqliteBackupManifest, restoreSqliteFactsBackup } from './sqlite-backup'
import { withDataWriteLock } from './write-lock'

export interface RecoverWriteSourceResult {
  ok: boolean
  mode: 'recovered-backup' | 'repaired-current' | 'skipped' | 'failed'
  counts?: { states: number; plans: number; settings: number; reviewLogs: number }
  error?: string
}

async function diag(value: unknown): Promise<void> {
  await getDb().meta.put({ key: 'learningWriteRecovery.diag', value: { at: Date.now(), ...((value as object) ?? {}) }, updatedAt: Date.now() }).catch(() => undefined)
}

async function finalizeRepair(): Promise<RecoverWriteSourceResult> {
  const rebuilt = await rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true })
  if (!rebuilt.ok) return { ok: false, mode: 'failed', error: rebuilt.error ?? rebuilt.conflict ?? 'cache 重建失败' }
  const health = await sqliteHealth(10_000)
  const counts = extractSqliteCounts(health as never)
  if (!counts || counts.states <= 0) return { ok: false, mode: 'failed', error: 'SQLite states 为空，无法修复写源' }
  await persistLearningWriteSource('sqlite')
  await persistSettingsWriteMode('sqlite').catch(() => undefined)
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('momo:settings-updated', { detail: { reason: 'repair-write-source' } }))
  } catch { /* ignore */ }
  return { ok: true, mode: 'repaired-current', counts }
}

/** 显式修复：不要求 plan 对齐；只要求 v2/integrity + states/settings 可读 */
export async function repairLearningWriteSource(): Promise<RecoverWriteSourceResult> {
  if (!isSqliteAvailable()) return { ok: false, mode: 'failed', error: 'SQLite 不可用' }
  return withDataWriteLock(async () => {
    try {
      const health = await sqliteHealth(10_000)
      if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) return { ok: false, mode: 'failed', error: `schema 不是 v${SQLITE_SCHEMA_VERSION}` }
      const integrity = await sqliteIntegrity(30_000)
      if (integrity.integrityOk === false) return { ok: false, mode: 'failed', error: 'SQLite integrity 失败' }
      const result = await finalizeRepair()
      await diag({ ok: result.ok, mode: result.mode, counts: result.counts, error: result.error })
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await diag({ ok: false, mode: 'failed', error: message })
      return { ok: false, mode: 'failed', error: message }
    }
  })
}

/** 启动自动恢复：只读 + 中断导入痕迹时，尝试最新 SQLite 备份→rebuild→写源 sqlite；失败退回当前 SQLite 修复 */
export async function recoverInterruptedWriteSource(): Promise<RecoverWriteSourceResult> {
  if (!isSqliteAvailable()) return { ok: false, mode: 'failed', error: 'SQLite 不可用' }
  if (getLearningWriteSource() !== 'readonly') return { ok: false, mode: 'skipped' }
  return withDataWriteLock(async () => {
    try {
      const stageRow = await getDb().meta.get('import.sqlite.stageNow')
      const timingRow = await getDb().meta.get('import.sqlite.factsOnlyTiming')
      const stageNow = stageRow?.value as { phase?: string; at?: number } | undefined
      const timing = timingRow?.value as { at?: number } | undefined
      const interrupted = Boolean(stageNow && stageNow.phase !== 'verify' && (!timing || (stageNow.at ?? 0) > (timing.at ?? 0)))
      if (interrupted) {
        const files = await listSqliteBackupFiles()
        for (const file of files.slice(0, 5)) {
          const manifest = await getSqliteBackupManifest(file.name)
          if (!manifest || manifest.integrityOk !== true) continue
          const restored = await restoreSqliteFactsBackup({ path: file.path, manifest }, { preBackup: async () => ({ ok: true }), skipWriteLock: true })
          if (!restored.ok) continue
          const result = await finalizeRepair()
          if (result.ok) {
            const out: RecoverWriteSourceResult = { ...result, mode: 'recovered-backup' }
            await diag({ ok: true, mode: out.mode, counts: out.counts, restoredFrom: file.name, epoch: await getDataEpoch() })
            return out
          }
        }
      }
      const repaired = await finalizeRepair()
      await diag({ ok: repaired.ok, mode: repaired.mode, counts: repaired.counts, error: repaired.error, interrupted })
      return repaired
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await diag({ ok: false, mode: 'failed', error: message })
      return { ok: false, mode: 'failed', error: message }
    }
  })
}

export async function getWriteSourceRecoveryDiagnostics(): Promise<unknown> {
  return (await getDb().meta.get('learningWriteRecovery.diag'))?.value ?? null
}
