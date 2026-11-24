/** 0.11.0 M6：0.9/0.10 IDB → SQLite 自动迁移门禁（SQLite 全0、IDB 有事实时） */
import { getDb } from './db'
import { getDataEpoch } from './data-epoch'
import { getIdbFactCounts } from './sqlite-store'
import { isSqliteAvailable, sqliteHealth, sqliteQuery } from './native-sqlite'
import { extractSqliteCounts } from './sqlite-store'
import { migrateIdbToSqlite } from './migration-sqlite'
import { rebuildIdbCacheFromSqlite } from './cache-rebuild'
import { persistLearningWriteSource } from './learning-write-source'
import { withDataWriteLock } from './write-lock'

export const LEGACY_UPGRADE_DIAG_KEY = 'upgrade.legacyMigration'

export interface LegacyUpgradeResult {
  mode: 'skipped' | 'migrated' | 'failed' | 'unsupported'
  counts?: { states: number; plans: number; settings: number; reviewLogs: number }
  error?: string
}

async function writeDiag(value: unknown): Promise<void> {
  await getDb().meta.put({ key: LEGACY_UPGRADE_DIAG_KEY, value, updatedAt: Date.now() }).catch(() => undefined)
}

/** 启动门禁：SQLite facts 全0且 IDB>0 → 自动迁移，成功切 SQLite 写源；失败保持 IDB，不 readonly */
export async function ensureLegacyIdbMigratedToSqlite(opts: {
  preBackup?: () => Promise<void | { ok: boolean; error?: string }>
  timeoutMs?: number
} = {}): Promise<LegacyUpgradeResult> {
  if (!isSqliteAvailable()) return { mode: 'unsupported' }
  return withDataWriteLock(async () => {
    try {
      const health = await sqliteHealth(5_000)
      const counts = extractSqliteCounts(health as never)
      const sqliteEmpty = !counts || (counts.states === 0 && counts.plans === 0 && counts.settings === 0 && counts.reviewLogs === 0)
      if (!sqliteEmpty) {
        const idb = await getIdbFactCounts()
        let migrationDone = false
        try {
          const response = await sqliteQuery({ table: 'migration_state', where: { step: 'legacy-idb' }, limit: 1 }, 5_000)
          migrationDone = ((response.rows as Array<Record<string, unknown>> | undefined) ?? [])[0]?.status === 'done'
        } catch {
          migrationDone = false
        }
        const same = Boolean(counts && counts.states === idb.states && counts.plans === idb.plans && counts.settings === idb.settings && counts.reviewLogs === idb.reviewLogs)
        if (migrationDone && same) {
          // M6：上次超时后台已完成/手动 M3 后 SQLite 非空，但写源未收尾 → 自动补写 sqlite
          await persistLearningWriteSource('sqlite').catch(() => undefined)
          const { persistSettingsWriteMode } = await import('./settings.repo')
          await persistSettingsWriteMode('sqlite').catch(() => undefined)
          await writeDiag({ at: Date.now(), ok: true, mode: 'recovered-sqlite-source', counts, idb, epoch: await getDataEpoch() })
          return { mode: 'migrated', ...(counts ? { counts } : {}) }
        }
        await writeDiag({ at: Date.now(), ok: false, mode: 'skipped-sqlite-nonempty', counts, idb, migrationDone, same })
        return { mode: 'skipped', ...(counts ? { counts } : {}) }
      }
      const idb = await getIdbFactCounts()
      const idbHasFacts = idb.states > 0 || idb.plans > 0 || idb.settings > 0 || idb.reviewLogs > 0
      if (!idbHasFacts) return { mode: 'skipped', counts: idb }
      if (!opts.preBackup) {
        await writeDiag({ at: Date.now(), ok: false, error: '缺少自动预备份回调，拒绝迁移' })
        return { mode: 'failed', counts: idb, error: '缺少自动预备份' }
      }
      // C7：不丢掉后台迁移。持锁等待迁移/重建/写源全部完成后才释放；UI 显示迁移中。
      const migration = await migrateIdbToSqlite({ dryRun: false, preBackup: opts.preBackup, batchSize: 200, skipWriteLock: true })
      if (!migration.ok || migration.skipped) {
        if (migration.skipped) return { mode: 'skipped', counts: idb }
        await writeDiag({ at: Date.now(), ok: false, error: migration.error ?? '迁移失败', counts: idb })
        return { mode: 'failed', counts: idb, error: migration.error ?? '迁移失败' }
      }
      const cache = await rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true })
      if (!cache.ok) {
        await writeDiag({ at: Date.now(), ok: false, error: cache.error ?? cache.conflict ?? 'cache 重建失败', counts: idb })
        return { mode: 'failed', counts: idb, error: cache.error ?? 'cache 重建失败' }
      }
      const after = await sqliteHealth(5_000)
      const afterCounts = extractSqliteCounts(after as never)
      if (
        !afterCounts ||
        afterCounts.states !== idb.states ||
        afterCounts.plans !== idb.plans ||
        afterCounts.settings !== idb.settings ||
        afterCounts.reviewLogs !== idb.reviewLogs
      ) {
        await writeDiag({ at: Date.now(), ok: false, error: '迁移后 counts 不一致', idb, afterCounts })
        return { mode: 'failed', counts: idb, error: '迁移后 counts 不一致' }
      }
      await persistLearningWriteSource('sqlite')
      const { persistSettingsWriteMode } = await import('./settings.repo')
      await persistSettingsWriteMode('sqlite').catch(() => undefined)
      await writeDiag({ at: Date.now(), ok: true, mode: 'migrated', counts: idb, epoch: await getDataEpoch() })
      return { mode: 'migrated', counts: idb }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await writeDiag({ at: Date.now(), ok: false, error: message })
      return { mode: 'failed', error: message }
    }
  })
}

export async function getLegacyUpgradeDiagnostics(): Promise<unknown> {
  return (await getDb().meta.get(LEGACY_UPGRADE_DIAG_KEY))?.value ?? null
}
