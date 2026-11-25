/** 0.11.0 M5：SQLite facts 备份/清单/manifest（native VACUUM INTO 由 native 实现） */
import { getDataEpoch } from './data-epoch'
import { withDataWriteLock } from './write-lock'
import { sqliteCall, sqliteHealth, sqliteIntegrity } from './native-sqlite'
import { getDb } from './db'
import { extractSqliteCounts, SQLITE_SCHEMA_VERSION } from './sqlite-store'
import type { AutoBackupBridge, AutoBackupEntry } from './auto-backup'

export const SQLITE_BACKUP_PREFIX = 'sqlite-backup-'
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

/** 备份：先写 .partial 名 → native 返回 → integrity/bytes 校验 → 返回 manifest；失败不登记 */
export async function createSqliteFactsBackup(name?: string): Promise<CreateSqliteBackupResult> {
  const now = Date.now()
  const safeName = (name ?? `${SQLITE_BACKUP_PREFIX}${new Date(now).toISOString().replace(/[:.]/g, '-')}.db`).replace(/[^A-Za-z0-9._-]/g, '-')
  try {
    const health = await sqliteHealth(10_000)
    if (Number(health.userVersion ?? 0) !== SQLITE_SCHEMA_VERSION) return { ok: false, error: `schema 不是 v${SQLITE_SCHEMA_VERSION}` }
    if (health.readOnly === true) return { ok: false, error: 'SQLite 只读恢复模式，拒绝备份' }
    const response = await sqliteCall({ method: 'backup', payload: { name: safeName, expectIntegrity: true }, timeoutMs: 60_000 })
    const result = response as unknown as { name?: string; path?: string; bytes?: number; checksum?: string; at?: number; createdAt?: number; integrityOk?: boolean } | undefined
    const bytes = Number(result?.bytes ?? 0)
    if (bytes <= 0) return { ok: false, error: 'SQLite 备份 0KB，已拒绝登记' }
    const integrity = result?.integrityOk === true ? { integrityOk: true } : await sqliteIntegrity(30_000)
    if (integrity.integrityOk === false) return { ok: false, error: 'SQLite 备份 integrity 校验失败' }
    const counts = extractSqliteCounts(health as never)
    const manifest: SqliteBackupManifest = {
      format: 'momo-sqlite-backup-manifest',
      formatVersion: 1,
      name: result?.name ?? safeName,
      ...(result?.path ? { path: result.path } : {}),
      bytes,
      ...(result?.checksum ? { checksum: result.checksum } : {}),
      createdAt: Number(result?.createdAt ?? now),
      userVersion: Number(health.userVersion ?? 0),
      dataEpoch: await getDataEpoch(),
      counts: counts ?? { states: 0, plans: 0, settings: 0, reviewLogs: 0 },
      integrityOk: true,
    }
    await saveSqliteBackupManifest(manifest)
    return { ok: true, manifest }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** M5：native sqlite-backups 目录 + manifest 的异步有效列表（UI 用） */
export async function listValidSqliteBackupFiles(): Promise<Array<SqliteBackupFileEntry & { valid: boolean; reason?: string; manifest?: SqliteBackupManifest }>> {
  const files = await listSqliteBackupFiles()
  const out: Array<SqliteBackupFileEntry & { valid: boolean; reason?: string; manifest?: SqliteBackupManifest }> = []
  for (const file of files) {
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
export async function preflightSqliteRestore(manifest: SqliteBackupManifest): Promise<{ ok: boolean; error?: string }> {
  if (manifest.integrityOk !== true) return { ok: false, error: '备份 integrity 未通过' }
  if (manifest.userVersion != null && Number(manifest.userVersion) !== SQLITE_SCHEMA_VERSION) {
    return { ok: false, error: `备份 schema v${manifest.userVersion} 与当前 v${SQLITE_SCHEMA_VERSION} 不兼容` }
  }
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

export interface RestoreSqliteBackupResult {
  ok: boolean
  counts?: { states: number; plans: number; settings: number; reviewLogs: number }
  beforeCounts?: { states: number; plans: number; settings: number; reviewLogs: number }
  error?: string
}

/** M5：恢复 SQLite facts 备份（native restoreDb 由 arch 实现） */
export function restoreSqliteFactsBackup(
  input: { manifest?: SqliteBackupManifest; path?: string },
  opts: { preBackup?: () => Promise<void | { ok: boolean; error?: string }>; skipWriteLock?: boolean } = {},
): Promise<RestoreSqliteBackupResult> {
  if (opts.skipWriteLock) return restoreSqliteFactsBackupInner(input, opts)
  return withDataWriteLock(() => restoreSqliteFactsBackupInner(input, opts))
}

async function restoreSqliteFactsBackupInner(
  input: { manifest?: SqliteBackupManifest; path?: string },
  opts: { preBackup?: () => Promise<void | { ok: boolean; error?: string }> } = {},
): Promise<RestoreSqliteBackupResult> {
  if (!opts.preBackup) return { ok: false, error: '恢复前必须完成预备份' }
  const backup = await opts.preBackup()
  if (backup && backup.ok === false) return { ok: false, error: `预备份失败：${backup.error ?? '未知'}` }
  if (input.manifest) {
    const pre = await preflightSqliteRestore(input.manifest)
    if (!pre.ok) return { ok: false, error: pre.error }
  }
  const beforeHealth = await healthForRestore(10_000)
  const beforeCounts = extractSqliteCounts(beforeHealth as never) ?? undefined
  const path = input.path ?? input.manifest?.path
  if (!path) return { ok: false, error: '缺少备份路径', ...(beforeCounts ? { beforeCounts } : {}) }
  // P1-1：restoreDb 是整库替换；先做一份当前 SQLite 快照，恢复后校验失败可回滚
  let safety: Awaited<ReturnType<typeof createSqliteFactsBackup>> | null = null
  try { safety = await createSqliteFactsBackup() } catch { safety = null }
  const rollbackRestoredDb = async (): Promise<boolean> => {
    const safetyPath = safety?.ok ? safety.manifest?.path : undefined
    if (!safetyPath) return false
    try {
      const rolled = await callBackupBridge({ method: 'restoreDb' as never, payload: { path: safetyPath }, timeoutMs: 120_000 })
      return rolled.ok !== false
    } catch { return false }
  }
  let restored = false
  try {
    const response = await callBackupBridge({
      method: 'restoreDb' as never,
      payload: { path },
      timeoutMs: 120_000,
    })
    if (response.ok === false) return { ok: false, error: response.message ?? 'native restoreDb 失败', ...(beforeCounts ? { beforeCounts } : {}) }
    restored = true
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
      if (
        counts.states !== input.manifest.counts.states ||
        counts.plans !== input.manifest.counts.plans ||
        counts.settings !== input.manifest.counts.settings ||
        counts.reviewLogs !== input.manifest.counts.reviewLogs
      ) {
        const rolled = await rollbackRestoredDb()
        return { ok: false, error: `恢复后 counts 与 manifest 不一致${rolled ? '，已回滚' : '；回滚失败，请立即从备份恢复'}`, counts, ...(beforeCounts ? { beforeCounts } : {}) }
      }
    }
    // P0：恢复后 SQLite 已换库，IDB cache/epoch 必须失效，否则重启仍读旧 plan/state
    try {
      const { bumpDataEpoch } = await import('./data-epoch')
      await bumpDataEpoch('sqlite-facts-restored')
      const { markIdbCacheDirty } = await import('./idb-cache')
      await markIdbCacheDirty('sqlite-facts-restored')
      // P1-3：恢复旧 facts DB 可能丢失 v15 durable marker；不能再用旧 IDB mirror 假装内容已迁移
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
    const rolled = restored ? await rollbackRestoredDb() : false
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
    if (typeof text === 'string' && text.length > 0) return JSON.parse(text) as SqliteBackupManifest
  } catch {
    /* fallback IDB legacy */
  }
  const row = await getDb().meta.get(MANIFEST_KEY(name))
  return (row?.value as SqliteBackupManifest | undefined) ?? null
}

export async function deleteSqliteBackupManifest(name: string): Promise<void> {
  await deleteOldIdbManifest(name)
}
