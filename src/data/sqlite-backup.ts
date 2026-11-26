/** 0.11.0 M5：SQLite facts 备份/清单/manifest（native VACUUM INTO 由 native 实现） */
import { getDataEpoch } from './data-epoch'
import { withDataWriteLock } from './write-lock'
import { sqliteCall, sqliteHealth, sqliteIntegrity } from './native-sqlite'
import { getDb } from './db'
import { extractSqliteCounts, SQLITE_SCHEMA_VERSION } from './sqlite-store'
import type { AutoBackupBridge, AutoBackupEntry } from './auto-backup'

export const SQLITE_BACKUP_PREFIX = 'sqlite-backup-'
export const SQLITE_SAFETY_PREFIX = 'sqlite-safety-'
export const SQLITE_AUTO_BACKUP_PREFIX = 'sqlite-auto-backup-'
export const SQLITE_BACKUP_MANIFEST = 'sqlite-backup-manifest.json'

export interface SqliteBackupManifest {
  format: 'momo-sqlite-backup-manifest'
  formatVersion: 1
  name: string
  path?: string
  bytes: number
  checksum?: string
  createdAt: number
  userVersion: number
  dataEpoch: number
  counts: { states: number; plans: number; settings: number; reviewLogs: number }
  integrityOk: boolean
}

export interface CreateSqliteBackupResult {
  ok: boolean
  manifest?: SqliteBackupManifest
  error?: string
}

/** 内部安全快照：独立前缀，不进用户恢复候选；成功路径应清理 */
export async function createSafetySnapshot(): Promise<CreateSqliteBackupResult> {
  return createSqliteFactsBackup(`${SQLITE_SAFETY_PREFIX}${new Date().toISOString().replace(/[:.]/g, '-')}.db`)
}

/** 清理内部安全快照文件+manifest */
export async function deleteSafetySnapshot(manifest: SqliteBackupManifest | null | undefined): Promise<void> {
  if (!manifest?.name) return
  await deleteSqliteBackupFile(manifest.name).catch(() => undefined)
  await deleteSqliteBackupManifest(manifest.name).catch(() => undefined)
}

/** 统一可恢复判据：states>0 + integrity + bytes>0 */
export function isRestorableBackup(manifest: SqliteBackupManifest | null | undefined): boolean {
  return Boolean(manifest && manifest.integrityOk === true && Number(manifest.bytes ?? 0) > 0 && Number(manifest.counts?.states ?? 0) > 0)
}

/** 备份：先写 .partial 名 → native 返回 → integrity/bytes 校验 → 返回 manifest；失败不登记 */
export async function createSqliteFactsBackup(name?: string): Promise<CreateSqliteBackupResult> {
  const now = Date.now()
  const safeName = (name ?? `${SQLITE_BACKUP_PREFIX}${new Date(now).toISOString().replace(/[:.]/g, '-')}.db`).replace(/[^A-Za-z0-9._-]/g, '-')
  const writeDiag = async (value: unknown) => {
    try { const db = await import('./db'); await db.getDb().meta.put({ key: 'sqliteBackup.createDiag', value: { at: Date.now(), ...((value as object) ?? {}) }, updatedAt: Date.now() }) } catch { /* ignore */ }
  }
  const removeBroken = async (target: string) => {
    await sqliteCall({ method: 'deleteBackup' as never, payload: { name: target }, timeoutMs: 5_000 }).catch(() => undefined)
  }
  try {
    const health = await sqliteHealth(10_000)
    if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) return { ok: false, error: `schema 不是 v${SQLITE_SCHEMA_VERSION}` }
    if (health.readOnly === true) return { ok: false, error: 'SQLite 只读恢复模式，拒绝备份' }
    const healthCounts = extractSqliteCounts(health as never) ?? { states: 0, plans: 0, settings: 0, reviewLogs: 0 }
    let mismatch: string | undefined
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await sqliteCall({ method: 'backup', payload: { name: safeName, expectIntegrity: true }, timeoutMs: 60_000 })
      const result = response as unknown as { name?: string; path?: string; bytes?: number; checksum?: string; at?: number; createdAt?: number; integrityOk?: boolean; counts?: Record<string, unknown> } | undefined
      const actualName = result?.name ?? safeName
      const bytes = Number(result?.bytes ?? 0)
      if (bytes <= 0) { await removeBroken(actualName); return { ok: false, error: 'SQLite 备份 0KB，已拒绝登记' } }
      const integrity = result?.integrityOk === true ? { integrityOk: true } : await sqliteIntegrity(30_000)
      if (integrity.integrityOk === false) { await removeBroken(actualName); return { ok: false, error: 'SQLite 备份 integrity 校验失败' } }
      const nativeRaw = result?.counts
      const nativeCounts = nativeRaw ? {
        states: Number(nativeRaw.states ?? nativeRaw.state ?? 0),
        plans: Number(nativeRaw.plans ?? nativeRaw.plan ?? 0),
        settings: Number(nativeRaw.settings ?? nativeRaw.setting ?? 0),
        reviewLogs: Number(nativeRaw.reviewLogs ?? nativeRaw.review_logs ?? 0),
      } : null
      if (nativeCounts) {
        const differs = nativeCounts.states !== healthCounts.states || nativeCounts.plans !== healthCounts.plans || nativeCounts.settings !== healthCounts.settings || nativeCounts.reviewLogs !== healthCounts.reviewLogs
        if (differs) {
          mismatch = `native 备份 counts 与 live counts 不一致（native ${JSON.stringify(nativeCounts)} vs live ${JSON.stringify(healthCounts)}）`
          await writeDiag({ ok: false, attempt, mismatch, actualName, nativeCounts, healthCounts })
          await removeBroken(actualName)
          continue
        }
      } else {
        await writeDiag({ ok: true, warning: 'native backup 未返回 counts，回退 health counts', attempt, actualName, healthCounts })
      }
      const manifest: SqliteBackupManifest = {
        format: 'momo-sqlite-backup-manifest',
        formatVersion: 1,
        name: actualName,
        ...(result?.path ? { path: result.path } : {}),
        bytes,
        ...(result?.checksum ? { checksum: result.checksum } : {}),
        createdAt: Number(result?.createdAt ?? now),
        userVersion: Number(health.userVersion ?? 0),
        dataEpoch: await getDataEpoch(),
        counts: nativeCounts ?? healthCounts,
        integrityOk: true,
      }
      await saveSqliteBackupManifest(manifest)
      return { ok: true, manifest }
    }
    await writeDiag({ ok: false, finalMismatch: mismatch ?? 'counts 不一致' })
    return { ok: false, error: `${mismatch ?? 'SQLite 备份 counts 与 live counts 不一致'}，已删除不一致备份，拒绝登记` }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** M5：native sqlite-backups 目录 + manifest 的异步有效列表（UI 用） */
export async function listValidSqliteBackupFiles(): Promise<Array<SqliteBackupFileEntry & { valid: boolean; reason?: string; manifest?: SqliteBackupManifest }>> {
  const files = await listSqliteBackupFiles()
  const out: Array<SqliteBackupFileEntry & { valid: boolean; reason?: string; manifest?: SqliteBackupManifest }> = []
  for (const file of files) {
    // 内部 safety 快照/自动备份不进用户恢复候选；自动备份仅用于 prune/诊断
    if (file.name.startsWith(SQLITE_SAFETY_PREFIX) || !file.name.startsWith(SQLITE_BACKUP_PREFIX)) continue
    if (file.size <= 0) {
      out.push({ ...file, valid: false, reason: '0KB' })
      continue
    }
    const manifest = await getSqliteBackupManifest(file.name)
    if (!manifest) {
      out.push({ ...file, valid: false, reason: '缺少 manifest' })
      continue
    }
    if (manifest.integrityOk !== true) {
      out.push({ ...file, valid: false, reason: 'manifest integrity 未通过', manifest })
      continue
    }
    if (manifest.bytes <= 0 || manifest.bytes !== file.size) {
      out.push({ ...file, valid: false, reason: '大小与 manifest 不一致', manifest })
      continue
    }
    if (!isRestorableBackup(manifest)) { out.push({ ...file, valid: false, reason: '空库备份（states=0）', manifest }); continue }
    out.push({ ...file, valid: true, manifest })
  }
  return out
}

/** 旧同步 API（仅测试/兼容 auto bridge 目录；UI 应使用 listValidSqliteBackupFiles） */
export function listValidSqliteBackups(bridge: AutoBackupBridge): Array<AutoBackupEntry & { valid: boolean; reason?: string }> {
  const entries = bridge.list().filter((entry) => entry.name.startsWith(SQLITE_BACKUP_PREFIX) && !entry.name.endsWith('.partial'))
  return entries.map((entry) => {
    if (entry.size <= 0) return { ...entry, valid: false, reason: '0KB' }
    return { ...entry, valid: true }
  })
}

/** 恢复前校验 manifest 与当前 SQLite counts 是否可恢复；只读/不一致拒绝 */
export async function preflightSqliteRestore(manifest: SqliteBackupManifest, opts: { allowEmpty?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  if (manifest.integrityOk !== true) return { ok: false, error: '备份 integrity 未通过' }
  if (manifest.userVersion != null && Number(manifest.userVersion) !== SQLITE_SCHEMA_VERSION) {
    return { ok: false, error: `备份 schema v${manifest.userVersion} 与当前 v${SQLITE_SCHEMA_VERSION} 不兼容` }
  }
  if (opts.allowEmpty !== true && Number(manifest.counts?.states ?? 0) === 0) return { ok: false, error: '该备份 states=0（空库备份，可能是清空后/启动时产生），不是有效进度备份，已拒绝恢复' }
  if (!manifest.bytes || manifest.bytes <= 0) return { ok: false, error: '备份 0KB' }
  const health = await sqliteHealth(10_000)
  if (health.readOnly === true) return { ok: false, error: 'SQLite 只读恢复模式，拒绝恢复' }
  if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) return { ok: false, error: 'schema 版本不一致' }
  return { ok: true }
}

/** 读取当前 SQLite facts manifest（用于自动备份/诊断） */
export async function getSqliteFactsManifest(): Promise<SqliteBackupManifest | null> {
  try {
    const health = await sqliteHealth(5_000)
    const counts = extractSqliteCounts(health as never)
    if (!counts) return null
    return {
      format: 'momo-sqlite-backup-manifest',
      formatVersion: 1,
      name: 'current',
      bytes: Number(health.sizeBytes ?? 0),
      createdAt: Date.now(),
      userVersion: Number(health.userVersion ?? 0),
      dataEpoch: await getDataEpoch(),
      counts,
      integrityOk: health.integrityOk !== false,
    }
  } catch {
    return null
  }
}

import { sqliteCall as callBackupBridge } from './native-sqlite'
import { sqliteHealth as healthForRestore, sqliteIntegrity as integrityForRestore } from './native-sqlite'

async function writeRestoreDiag(patch: Record<string, unknown>): Promise<void> {
  try {
    const { getDb } = await import('./db')
    await getDb().meta.put({ key: 'restore.diag', value: { at: Date.now(), ...patch }, updatedAt: Date.now() })
  } catch { /* ignore */ }
}

export interface RestoreSqliteBackupResult {
  ok: boolean
  counts?: { states: number; plans: number; settings: number; reviewLogs: number }
  beforeCounts?: { states: number; plans: number; settings: number; reviewLogs: number }
  error?: string
  blockedBy?: string
}

/** M5：恢复 SQLite facts 备份（native restoreDb 由 arch 实现） */
export async function restoreSqliteFactsBackup(
  input: { manifest?: SqliteBackupManifest; path?: string },
  opts: { preBackup?: () => Promise<void | { ok: boolean; error?: string }>; skipWriteLock?: boolean; skipPostRestoreCacheRebuild?: boolean; allowEmptySafety?: boolean; allowEmptyCurrent?: boolean; quiescentTimeoutMs?: number } = {},
): Promise<RestoreSqliteBackupResult> {
  // R4 关键：必须先等内容迁移静止，再获取 DataWriteLock。
  // 若在 withDataWriteLock 内等待，v15 持锁时 restore 等锁、v15 等 restore 静止 → 死锁（真机 >60s 卡死）。
  const quiescent = await (await import('./content-migration-plan')).waitForContentMigrationQuiescent({ timeoutMs: opts.quiescentTimeoutMs })
  if (!quiescent.ok) {
    await writeRestoreDiag({ quiescentState: quiescent.state, error: quiescent.error, blockedBy: 'content-migration' })
    return { ok: false, error: quiescent.error ?? '内容迁移未静止', blockedBy: 'content-migration' }
  }
  if (opts.skipWriteLock) return restoreSqliteFactsBackupInner(input, opts)
  return withDataWriteLock(() => restoreSqliteFactsBackupInner(input, opts))
}

async function restoreSqliteFactsBackupInner(
  input: { manifest?: SqliteBackupManifest; path?: string },
  opts: { preBackup?: () => Promise<void | { ok: boolean; error?: string }>; skipPostRestoreCacheRebuild?: boolean; allowEmptySafety?: boolean; allowEmptyCurrent?: boolean } = {},
): Promise<RestoreSqliteBackupResult> {
  const quiescent = { ok: true, state: 'done' }
  if (!opts.preBackup) return { ok: false, error: '恢复前必须完成预备份' }
  const backup = await opts.preBackup()
  if (backup && backup.ok === false) return { ok: false, error: `预备份失败：${backup.error ?? '未知'}` }
  if (input.manifest) {
    const pre = await preflightSqliteRestore(input.manifest, { allowEmpty: opts.allowEmptySafety === true })
    if (!pre.ok) { await writeRestoreDiag({ quiescentState: quiescent.state, targetManifestCounts: input.manifest.counts, error: pre.error }); return { ok: false, error: pre.error } }
  }
  const beforeHealth = await healthForRestore(10_000)
  const beforeCounts = extractSqliteCounts(beforeHealth as never) ?? undefined
  const path = input.path ?? input.manifest?.path
  if (!path) return { ok: false, error: '缺少备份路径', ...(beforeCounts ? { beforeCounts } : {}) }
  // P1-1/P0-2：restoreDb 是整库替换；安全快照失败必须拒绝 restore，否则失败时无法回滚。
  let safety: Awaited<ReturnType<typeof createSqliteFactsBackup>> | null = null
  try { safety = await createSafetySnapshot() } catch { safety = null }
  if (!safety?.ok || !safety.manifest?.path) {
    await writeRestoreDiag({ quiescentState: quiescent.state, safetyCounts: safety?.manifest?.counts, preBackupMode: 'ok', error: '无法创建恢复前安全快照，已拒绝恢复' })
    return { ok: false, error: '无法创建恢复前安全快照，已拒绝恢复', ...(beforeCounts ? { beforeCounts } : {}) }
  }
  // 清空后首次恢复：当前库本来就是空的，空 safety 是正确回滚点（回滚=回到清空态），应允许；
  // 只有“当前库非空却建出空快照”才视为异常并拒绝。
  const currentIsEmpty = Number(beforeCounts?.states ?? -1) === 0
  if (opts.allowEmptySafety !== true && !currentIsEmpty && Number(safety.manifest.counts?.states ?? 0) === 0) {
    // 拒绝恢复时必须删除刚创建的空安全快照，否则它会被 UI 当成“最新有效备份”，
    // 挤掉/掩盖真正的有效备份。
    await deleteSqliteBackupFile(safety.manifest.name).catch(() => undefined)
    await deleteSqliteBackupManifest(safety.manifest.name).catch(() => undefined)
    await writeRestoreDiag({ quiescentState: quiescent.state, safetyCounts: safety.manifest.counts, preBackupMode: 'ok', error: '当前 SQLite 为空，无法创建恢复前安全快照（回滚会回到空库），已拒绝恢复' })
    return { ok: false, error: '当前 SQLite 为空，无法创建恢复前安全快照（回滚会回到空库），已拒绝恢复', ...(beforeCounts ? { beforeCounts } : {}) }
  }
  const rollbackRestoredDb = async (): Promise<boolean> => {
    const safetyPath = safety?.ok ? safety.manifest?.path : undefined
    if (!safetyPath) return false
    try {
      const rolled = await callBackupBridge({ method: 'restoreDb' as never, payload: { path: safetyPath }, timeoutMs: 120_000 })
      return rolled.ok !== false
    } catch { return false }
  }
  let restoreAttempted = false
  try {
    restoreAttempted = true
    const response = await callBackupBridge({
      method: 'restoreDb' as never,
      payload: { path },
      timeoutMs: 120_000,
    })
    if (response.ok === false) {
      const rolled = await rollbackRestoredDb()
      return { ok: false, error: `native restoreDb 失败${rolled ? '（已回滚）' : '；回滚失败，请立即从备份恢复'}`, ...(beforeCounts ? { beforeCounts } : {}) }
    }
    const health = await healthForRestore(10_000)
    const counts = extractSqliteCounts(health as never)
    if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) {
      const rolled = await rollbackRestoredDb()
      return { ok: false, error: `恢复后 schema 版本不一致${rolled ? '，已回滚' : '；回滚失败，请立即从备份恢复'}`, ...(beforeCounts ? { beforeCounts } : {}) }
    }
    const integrity = await integrityForRestore(30_000)
    if (integrity.integrityOk === false) {
      const rolled = await rollbackRestoredDb()
      return { ok: false, error: `恢复后 integrity 失败${rolled ? '，已回滚' : '；回滚失败，请立即从备份恢复'}`, ...(beforeCounts ? { beforeCounts } : {}) }
    }
    if (input.manifest && counts) {
      // 设备本地 settings（token/apiKey/autoBackup 等）可能比备份多，不能因此判定恢复失败；
      // facts 三类必须精确相等，settings 允许实际 >= 备份。
      if (
        counts.states !== input.manifest.counts.states ||
        counts.reviewLogs !== input.manifest.counts.reviewLogs
      ) {
        const rolled = await rollbackRestoredDb()
        await writeRestoreDiag({ targetManifestCounts: input.manifest.counts, actualCounts: counts, beforeCounts, rolled })
        return { ok: false, error: `恢复后 facts counts 与 manifest 不一致${rolled ? '，已回滚' : '；回滚失败，请立即从备份恢复'}（manifest states=${input.manifest.counts.states}/logs=${input.manifest.counts.reviewLogs}，实际 states=${counts.states}/logs=${counts.reviewLogs}；plans 为日期派生、settings 为设备本地，均不参与严格校验）`, counts, ...(beforeCounts ? { beforeCounts } : {}) }
      }
      if (counts.plans !== input.manifest.counts.plans) {
        await writeRestoreDiag({ targetManifestCounts: input.manifest.counts, actualCounts: counts, beforeCounts, plansDiff: counts.plans - input.manifest.counts.plans, note: 'plans 差异不阻断恢复' })
      }
    }
    // R3：先让旧 cache 失效（epoch + dirty），再重建；避免重建成功后被标脏
    try {
      const { bumpDataEpoch } = await import('./data-epoch')
      await bumpDataEpoch('sqlite-facts-restored')
      const { markIdbCacheDirty } = await import('./idb-cache')
      await markIdbCacheDirty('sqlite-facts-restored')
    } catch { /* 继续重建 */ }
    if (!opts.skipPostRestoreCacheRebuild) try {
      const { rebuildIdbCacheFromSqlite } = await import('./cache-rebuild')
      const rebuilt = await rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true, force: true, preBackup: async () => ({ ok: true }) })
      if (!rebuilt.ok) {
        return { ok: false, error: `恢复后 cache 重建失败：${rebuilt.error ?? rebuilt.conflict ?? '未知'}`, ...(counts ? { counts } : {}), ...(beforeCounts ? { beforeCounts } : {}) }
      }
      const { persistLearningWriteSource } = await import('./learning-write-source')
      await persistLearningWriteSource('sqlite').catch(() => undefined)
      const { persistSettingsWriteMode } = await import('./settings.repo')
      await persistSettingsWriteMode('sqlite').catch(() => undefined)
      // 重建成功即 clean（显式写回，防止并发标脏）
      const { writeIdbCacheMeta } = await import('./idb-cache')
      const { getDataEpoch } = await import('./data-epoch')
      await writeIdbCacheMeta({ generation: await getDataEpoch(), sqliteUserVersion: SQLITE_SCHEMA_VERSION, rebuiltAt: Date.now(), dirty: false, reason: 'restore-rebuilt' }).catch(() => undefined)
    } catch (error) {
      return { ok: false, error: `恢复后写源/cache 修复失败：${error instanceof Error ? error.message : String(error)}`, ...(counts ? { counts } : {}), ...(beforeCounts ? { beforeCounts } : {}) }
    }
    // 恢复旧 facts DB 可能丢失 v15 durable marker；不能再用旧 IDB mirror 假装内容已迁移
    try {
      const { hasDurableContentMigrationV15Marker, invalidateContentMigrationV15Cache, CONTENT_MIGRATION_V15_KEY } = await import('./content-write-source')
      if (!(await hasDurableContentMigrationV15Marker())) {
        await (await import('./db')).getDb().meta.delete(CONTENT_MIGRATION_V15_KEY).catch(() => undefined)
        invalidateContentMigrationV15Cache()
        const { persistContentWriteSource } = await import('./content-write-source')
        await persistContentWriteSource('idb').catch(() => undefined)
      }
    } catch { /* 恢复本身已成功，cache 失效失败由下次启动对账兜底 */ }
    return { ok: true, ...(counts ? { counts } : {}), ...(beforeCounts ? { beforeCounts } : {}) }
  } catch (error) {
    const rolled = restoreAttempted ? await rollbackRestoredDb() : false
    return { ok: false, error: `${error instanceof Error ? error.message : String(error)}${rolled ? '（已回滚）' : ''}`, ...(beforeCounts ? { beforeCounts } : {}) }
  }
}


/** M5：native sqlite-backups 目录文件列表（自动备份用） */
export interface SqliteBackupFileEntry {
  name: string
  path: string
  size: number
  mtime: number
  kind: 'sqlite'
  hasManifest?: boolean
}

const MANIFEST_KEY = (name: string) => `sqliteBackup.manifest:${name}`

export async function listSqliteBackupFiles(): Promise<SqliteBackupFileEntry[]> {
  try {
    const response = await sqliteCall({ method: 'listBackups' as never, timeoutMs: 10_000 })
    const rows = (response as unknown as { backups?: Array<Record<string, unknown>> }).backups ?? []
    return rows
      .map((row) => ({
        name: String(row.name ?? ''),
        path: String(row.path ?? ''),
        size: Number(row.size ?? 0),
        mtime: Number(row.mtime ?? 0),
        kind: 'sqlite' as const,
        hasManifest: row.manifest === true,
      }))
      .filter((entry) => entry.name.length > 0 && entry.size > 0 && entry.name.endsWith('.db') && !entry.name.endsWith('.partial'))
      .sort((a, b) => b.mtime - a.mtime)
  } catch {
    return []
  }
}

export async function deleteSqliteBackupFile(name: string): Promise<boolean> {
  try {
    const response = await sqliteCall({ method: 'deleteBackup' as never, payload: { name }, timeoutMs: 5_000 })
    return response.ok !== false
  } catch {
    return false
  }
}

export async function saveSqliteBackupManifest(manifest: SqliteBackupManifest): Promise<void> {
  const text = JSON.stringify(manifest)
  try {
    const response = await sqliteCall({ method: 'writeBackupManifest' as never, payload: { name: manifest.name, manifest: text }, timeoutMs: 10_000 })
    if (response.ok !== false) {
      // 兼容清理旧 IDB meta
      await deleteOldIdbManifest(manifest.name)
      return
    }
  } catch {
    /* fallback */
  }
  await getDb().meta.put({ key: MANIFEST_KEY(manifest.name), value: manifest, updatedAt: Date.now() })
}

async function deleteOldIdbManifest(name: string): Promise<void> {
  try { await getDb().meta.delete(MANIFEST_KEY(name)) } catch { /* ignore */ }
}

export async function getSqliteBackupManifest(name: string): Promise<SqliteBackupManifest | null> {
  try {
    const response = await sqliteCall({ method: 'readBackupManifest' as never, payload: { name }, timeoutMs: 5_000 })
    const text = (response as unknown as { manifest?: string }).manifest
    if (typeof text === 'string') {
      // native 可读但 manifest 为空：表示无 sidecar，不得回退陈旧 IDB manifest
      return text.length > 0 ? JSON.parse(text) as SqliteBackupManifest : null
    }
  } catch {
    /* native 不可用才回退 IDB legacy */
  }
  const row = await getDb().meta.get(MANIFEST_KEY(name))
  return (row?.value as SqliteBackupManifest | undefined) ?? null
}

export async function deleteSqliteBackupManifest(name: string): Promise<void> {
  await deleteOldIdbManifest(name)
}
