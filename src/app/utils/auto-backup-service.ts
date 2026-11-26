/** 0.3.86 task-254：自动备份 app 层适配（原生桥 → data 编排；Web 降级） */
import {
  getSettings,
  scheduleStateCheckpoint,
  flushStateCheckpoint,
  restoreStateCheckpointIfEmpty,
  getStateCheckpointStatus,
  type StateCheckpointStatus,
  gatherDataSafetyDiagnostics,
  serializeSafetyDiagnostics,
  migrationChecksumPayload,
  verifyChecksum,
  listSqliteBackupFiles,
  getSqliteBackupManifest,
  restoreSqliteFactsBackup,
  getDb,
  getSettingsWriteMode,
  getStartupTiming,
} from '../../data'
import {
  listAutoBackups as dataListAutoBackups,
  restoreAutoBackup as dataRestoreAutoBackup,
  runAutoBackup,
  type AutoBackupBridge,
  type AutoBackupEntry,
  type AutoBackupRestoreResult,
  type AutoBackupRunResult,
} from '../../data'
import {
  appendDiagLog,
  deleteAutoBackup,
  getAutoBackupFlag,
  isAutoBackupAvailable,
  listAutoBackups,
  pruneAutoBackups,
  readAutoBackup,
  saveAutoBackup,
  setAutoBackupFlag,
} from './auto-backup'

export function createAutoBackupBridge(): AutoBackupBridge {
  return {
    isAvailable: () => isAutoBackupAvailable(),
    save: (text, fileName) => saveAutoBackup(text, fileName),
    list: () => listAutoBackups(),
    read: (name) => readAutoBackup(name),
    delete: (name) => deleteAutoBackup(name),
    prune: (keep) => pruneAutoBackups(keep),
    getFlag: (key) => getAutoBackupFlag(key),
    setFlag: (key, value) => setAutoBackupFlag(key, value),
    appendDiagLog: (text) => {
      appendDiagLog(text)
    },
  }
}

/** 申请持久化存储（WebView/浏览器支持时；失败静默） */
export async function requestAutoBackupPersist(): Promise<boolean> {
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (!storage?.persist) return false
    return await storage.persist()
  } catch {
    return false
  }
}

/** 启动自动备份；设置关闭/非 APK 时安全返回（Web 只返回 unavailable，不静默写） */
export async function startupAutoBackup(opts: { now?: number; force?: boolean } = {}): Promise<AutoBackupRunResult | { mode: 'disabled' }> {
  try {
    const settings = await getSettings()
    if (settings['data.autoBackupEnabled'] !== true) return { mode: 'disabled' }
    void requestAutoBackupPersist().catch(() => undefined)
    const bridge = createAutoBackupBridge()
    return await runAutoBackup(bridge, opts)
  } catch (error) {
    appendDiagLog(`[backup] startup error: ${error instanceof Error ? error.message : String(error)}`)
    return { mode: 'error', learnedCount: 0, progressAnomaly: false, error: String(error) }
  }
}

/** 0.10.0：评分后 2s debounce 写检查点 */
export function scheduleProgressCheckpoint(): void {
  scheduleStateCheckpoint(createAutoBackupBridge())
}

/** 0.10.0：页面隐藏/退出学习立即 flush */
export async function flushProgressCheckpoint(): Promise<StateCheckpointStatus> {
  await flushStateCheckpoint(createAutoBackupBridge())
  return getStateCheckpointStatus()
}

/** 0.10.0：启动时空库自动恢复 */
export async function restoreProgressCheckpointIfEmpty(): Promise<StateCheckpointStatus> {
  return restoreStateCheckpointIfEmpty(createAutoBackupBridge())
}

/** 0.10.0：MePage 读取检查点状态 */
export async function getProgressCheckpointStatus(): Promise<StateCheckpointStatus> {
  return getStateCheckpointStatus()
}

/** 0.10.0：申请持久化存储（native/浏览器均尽力而为） */
export async function ensurePersistentStorage(): Promise<boolean> {
  return requestAutoBackupPersist()
}

/** 0.10.0：危险操作前的完整预备份；不可用/失败时返回 failed 供调用方中止 */
/** 0.10.0：导出安全诊断包文本（只读 gather；文件保存由 UI 层） */
export async function buildSafetyDiagnosticsText(): Promise<string> {
  const pkg = await gatherDataSafetyDiagnostics({ bridge: createAutoBackupBridge() })
  const serialized = JSON.parse(serializeSafetyDiagnostics(pkg)) as Record<string, unknown>
  serialized.startupTiming = getStartupTiming()
  return JSON.stringify(serialized, null, 2)
}

/** 0.10.0：清空数据前删除本地检查点，避免重启自动恢复已清空数据 */
export async function clearProgressCheckpoints(): Promise<{
  ok: boolean
  removed: number
  remaining: number
  error?: string
}> {
  const bridge = createAutoBackupBridge()
  if (!bridge.isAvailable()) return { ok: true, removed: 0, remaining: 0 }
  try {
    let removed = 0
    for (const entry of bridge.list()) {
      if (/^(auto-backup-)?checkpoint-(latest|\d+)\.state\.json(\.gz)?$/.test(entry.name)) {
        if (bridge.delete(entry.name)) removed += 1
      }
    }
    const remaining = bridge.list().filter((entry) => /^(auto-backup-)?checkpoint-(latest|\d+)\.state\.json(\.gz)?$/.test(entry.name)).length
    return { ok: remaining === 0, removed, remaining, ...(remaining > 0 ? { error: `仍有 ${remaining} 个检查点未删除` } : {}) }
  } catch (error) {
    return { ok: false, removed: 0, remaining: -1, error: error instanceof Error ? error.message : String(error) }
  }
}

/** 0.11.0 M4b-1：当前 settings 写源 + settingsWrite.diag */
export async function getSettingsWriteDiagnostics(): Promise<{
  mode: 'idb' | 'sqlite'
  diag: unknown
}> {
  try {
    const row = await getDb().meta.get('settingsWrite.diag')
    return { mode: getSettingsWriteMode(), diag: row?.value ?? null }
  } catch {
    return { mode: getSettingsWriteMode(), diag: null }
  }
}

export async function createPreBackup(): Promise<{ ok: boolean; error?: string; skipped?: 'web-no-auto-backup' }> {
  const bridge = createAutoBackupBridge()
  if (!bridge.isAvailable()) {
    // Web/PWA 没有自动备份桥：数据在 IndexedDB；危险操作由 UI 做二次确认，不能直接卡死导入/删除
    try {
      const { isNativeContentSqliteRuntime } = await import('../../data/content-write-source')
      if (!isNativeContentSqliteRuntime()) return { ok: true, skipped: 'web-no-auto-backup' }
    } catch { /* fallthrough */ }
    return { ok: false, error: '当前环境无法自动备份，请先手动导出学习进度' }
  }
  try {
    const result = await runAutoBackup(bridge, { force: true })
    if ('mode' in result) {
      // 0.16 D-P0：清空后恢复/空库危险操作时没有可备份的进度，
      // anomaly(learned=0 + hadProgress flag) 不应阻断恢复；仅真正 error/unavailable 阻断。
      const learnedCount = 'learnedCount' in result ? Number(result.learnedCount ?? 0) : -1
      if (result.mode === 'anomaly' && learnedCount === 0) {
        return { ok: true }
      }
      if (result.mode === 'error' || result.mode === 'anomaly' || result.mode === 'unavailable') {
        return { ok: false, error: result.error ?? `预备份失败（${result.mode}）` }
      }
    }
    if ('error' in result && result.error) return { ok: false, error: String(result.error) }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

export function listAutoBackupsForUi(): AutoBackupEntry[] {
  return dataListAutoBackups(createAutoBackupBridge())
    .filter((entry) => entry.size > 0 && /\.migration\.json(\.gz)?$/.test(entry.name))
    .sort((a, b) => b.mtime - a.mtime)
}

/** 0.10.0：恢复列表轻量校验（format/version/JSON/checksum 字段），坏包不显示 */
const validatedBackupCache = new Map<string, boolean>()

export async function listValidatedAutoBackupsForUi(): Promise<AutoBackupEntry[]> {
  const candidates = listAutoBackupsForUi()
  const bridge = createAutoBackupBridge()
  const out: AutoBackupEntry[] = []
  for (const entry of candidates) {
    const cacheKey = `${entry.name}:${entry.mtime}:${entry.size}`
    if (validatedBackupCache.has(cacheKey)) {
      if (validatedBackupCache.get(cacheKey)) out.push(entry)
      continue
    }
    try {
      const text = bridge.read(entry.name)
      if (!text) continue
      const parsed = JSON.parse(text) as Record<string, unknown>
      if (parsed.format !== 'momo-migration') continue
      if (Number(parsed.formatVersion) !== 1 || Number(parsed.dataVersion) !== 1) continue
      if (typeof parsed.checksum !== 'string' || !parsed.checksum) continue
      const checksumPayload = migrationChecksumPayload({
        format: String(parsed.format ?? ''),
        formatVersion: Number(parsed.formatVersion ?? 0),
        dataVersion: Number(parsed.dataVersion ?? 0),
        data: parsed.data,
      })
      const checksum = await verifyChecksum(checksumPayload, parsed.checksum)
      validatedBackupCache.set(cacheKey, checksum.ok)
      if (!checksum.ok) continue
      out.push(entry)
    } catch {
      validatedBackupCache.set(cacheKey, false)
      /* 坏包跳过 */
    }
  }
  // M5：SQLite facts 备份（.db + manifest）与旧 JSON 合并；只显示 manifest 有效、size>0 的包。
  try {
    const sqliteFiles = await listSqliteBackupFiles()
    for (const file of sqliteFiles) {
      if (file.size <= 0) continue
      const manifest = await getSqliteBackupManifest(file.name)
      if (!manifest || manifest.integrityOk !== true || manifest.bytes <= 0) continue
      // 空库快照不是有效进度备份，不能出现在恢复候选里（会遮蔽/挤掉有效备份）
      if (Number(manifest.counts?.states ?? 0) <= 0) continue
      out.push({ name: file.name, size: file.size, mtime: file.mtime, path: file.path, kind: 'sqlite' })
    }
  } catch {
    /* SQLite 列表失败不影响旧 JSON */
  }
  out.sort((a, b) => b.mtime - a.mtime)
  return out
}

/** 0.16：恢复“最新备份”时跳过空库自动备份（清空后启动可能产生），优先有 states 的 SQLite 备份 */
export async function findLatestRestorableAutoBackupForUi(): Promise<AutoBackupEntry | undefined> {
  const entries = await listValidatedAutoBackupsForUi()
  for (const entry of entries) {
    if (entry.kind === 'sqlite') {
      const manifest = await getSqliteBackupManifest(entry.name)
      if (manifest && manifest.integrityOk === true && Number(manifest.counts?.states ?? 0) > 0) return entry
      continue
    }
    return entry
  }
  return entries[0]
}

export function restoreAutoBackupForUi(name: string, opts: { now?: number } = {}): Promise<AutoBackupRestoreResult> {
  if (name.endsWith('.db')) {
    return (async (): Promise<AutoBackupRestoreResult> => {
      const files = await listSqliteBackupFiles()
      const file = files.find((entry) => entry.name === name)
      if (!file) return { ok: false, name, error: 'SQLite 备份文件不存在' }
      const manifest = await getSqliteBackupManifest(name)
      const restored = await restoreSqliteFactsBackup(
        { path: file.path, ...(manifest ? { manifest } : {}) },
        { preBackup: () => createPreBackup(), allowEmptyCurrent: true },
      )
      return restored.ok ? { ok: true, name } : { ok: false, name, error: restored.error ?? 'SQLite 恢复失败' }
    })()
  }
  return dataRestoreAutoBackup(createAutoBackupBridge(), name, opts)
}
