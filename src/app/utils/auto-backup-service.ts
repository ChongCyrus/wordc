/** 0.3.86 task-254：自动备份 app 层适配（原生桥 → data 编排；Web 降级） */
import { getSettings } from '../../data'
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

export function listAutoBackupsForUi(): AutoBackupEntry[] {
  return dataListAutoBackups(createAutoBackupBridge())
}

export function restoreAutoBackupForUi(name: string, opts: { now?: number } = {}): Promise<AutoBackupRestoreResult> {
  return dataRestoreAutoBackup(createAutoBackupBridge(), name, opts)
}
