/**
 * 0.3.86（task-254）：每日自动备份 + 异常恢复（数据编排层）。
 * 原生桥由调用方注入（src/app/utils/auto-backup.ts 适配），Web/PWA 不静默写。
 */
import { localDateKey, type ImportReport } from '../core'
import { getDb } from './db'
import { exportMigration, importMigration } from './import-export'

export const AUTO_BACKUP_KEEP = 7
/**
 * 0.3.94 热修：20MB 曾按「未压缩迁移 JSON」判断，但实际落盘由原生 gzip，
 * 正常 47MB IndexedDB 的迁移 JSON 可能 >20MB 却压缩后仅几 MB，导致每次误跳过。
 * 上限改为与 UI「7 份且总量≤100MB」一致；仍防极端超大文本。
 */
export const AUTO_BACKUP_MAX_BYTES = 100 * 1024 * 1024
export const AUTO_BACKUP_FLAG_LAST_DATE = 'lastBackupDate'
export const AUTO_BACKUP_FLAG_HAD_PROGRESS = 'hadProgress'
export const AUTO_BACKUP_FLAG_ANOMALY = 'progressAnomaly'
export const AUTO_BACKUP_RESTORE_STATE_KEY = 'backup.restoreState'

export interface AutoBackupEntry {
  name: string
  size: number
  mtime: number
  path: string
}

export interface AutoBackupSaveResult {
  ok: boolean
  mode: 'native' | 'unavailable'
  name?: string
  path?: string
  error?: string
}

/** 与 src/app/utils/auto-backup.ts 对齐的可注入桥；测试用 fake */
export interface AutoBackupBridge {
  isAvailable(): boolean
  save(text: string, fileName: string): Promise<AutoBackupSaveResult> | AutoBackupSaveResult
  list(): AutoBackupEntry[]
  read(name: string): string | null
  delete(name: string): boolean
  prune(keep: number): number
  getFlag(key: string): string
  setFlag(key: string, value: string): boolean
  appendDiagLog(text: string): void
}

export type AutoBackupRunMode = 'backed-up' | 'skipped' | 'unavailable' | 'error' | 'anomaly'

export interface AutoBackupRunOptions {
  now?: number
  /** 已由调用方读取设置；false 时不执行（测试/服务层用） */
  enabled?: boolean
  /** 兼容旧调用：不再按天跳过，每次启动都备份 */
  force?: boolean
  /** 测试注入导出文本 */
  exportText?: () => Promise<string>
  /** 覆盖安全上限（默认 AUTO_BACKUP_MAX_BYTES） */
  maxBytes?: number
}

export interface AutoBackupRunResult {
  mode: AutoBackupRunMode
  learnedCount: number
  /** 本轮/上次写盘的文件名 */
  name?: string
  path?: string
  /** 是否检测到进度异常（DB 为空但曾经有进度） */
  progressAnomaly: boolean
  error?: string
  pruned?: number
}

export type AutoBackupRestorePhase = 'read' | 'pre-backup' | 'parse' | 'checksum' | 'validate' | 'apply' | 'done'

export interface AutoBackupRestoreStatus {
  status: 'idle' | 'running' | 'completed' | 'failed'
  name?: string
  phase?: AutoBackupRestorePhase
  startedAt?: number
  finishedAt?: number
  error?: string
  preRestoreName?: string
  /** 中断阈值（running 超过该时长视为上次恢复被系统打断） */
  interrupted?: boolean
}

export interface AutoBackupRestoreResult {
  ok: boolean
  name: string
  /** 恢复前当前数据的临时备份文件名 */
  preRestoreName?: string
  report?: ImportReport
  error?: string
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function backupFileName(now: number): string {
  // 0.3.86/task-257：同一天固定同名覆盖，跨天新文件
  return `auto-backup-${localDateKey(now)}.migration.json`
}

/** 异常检测：DB 无学习状态但 flag 表明曾有过进度 */
export async function checkProgressAnomaly(bridge: AutoBackupBridge): Promise<boolean> {
  const learned = await getDb().states.count()
  if (learned > 0) return false
  const had = bridge.getFlag(AUTO_BACKUP_FLAG_HAD_PROGRESS) === '1'
  if (!had) return false
  if (bridge.getFlag(AUTO_BACKUP_FLAG_ANOMALY) !== '1') bridge.setFlag(AUTO_BACKUP_FLAG_ANOMALY, '1')
  return true
}

/**
 * 启动自动备份（task-257：每次启动都备份）：
 * - enabled=false 直接跳过；
 * - learnedCount>0 才写；
 * - 文件名固定 `auto-backup-YYYY-MM-DD.migration.json`（同日覆盖，跨天新文件）；
 * - 先检查异常（DB 空 + hadProgress flag）；
 * - 轻量 exportMigration → bridge.save → setFlag(lastBackupDate) → prune(7)；
 * - 超过上限或桥失败只写 diag，不抛（避免阻塞启动）。
 */
export async function runAutoBackup(
  bridge: AutoBackupBridge,
  opts: AutoBackupRunOptions = {},
): Promise<AutoBackupRunResult> {
  if (opts.enabled === false) return { mode: 'skipped', learnedCount: 0, progressAnomaly: false }
  const now = opts.now ?? Date.now()
  const learnedCount = await getDb().states.count()
  const today = localDateKey(now)
  const progressAnomaly = await checkProgressAnomaly(bridge)

  if (progressAnomaly) {
    bridge.appendDiagLog(`[backup] progressAnomaly detected learned=0 at ${new Date(now).toISOString()}`)
    return { mode: 'anomaly', learnedCount, progressAnomaly: true }
  }
  if (learnedCount === 0) return { mode: 'skipped', learnedCount, progressAnomaly: false }
  if (bridge.getFlag(AUTO_BACKUP_FLAG_HAD_PROGRESS) !== '1') {
    bridge.setFlag(AUTO_BACKUP_FLAG_HAD_PROGRESS, '1')
  }
  if (!bridge.isAvailable()) return { mode: 'unavailable', learnedCount, progressAnomaly: false }

  try {
    const text = opts.exportText
      ? await opts.exportText()
      : await (await exportMigration()).text()
    const bytes = byteLength(text)
    const maxBytes = opts.maxBytes ?? AUTO_BACKUP_MAX_BYTES
    if (bytes > maxBytes) {
      const error = `备份体积 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 ${maxBytes / 1024 / 1024}MB 上限，跳过`
      bridge.appendDiagLog(`[backup] skipped: ${error}`)
      return { mode: 'error', learnedCount, progressAnomaly: false, error }
    }
    const name = backupFileName(now)
    const saved = await bridge.save(text, name)
    if (!saved.ok) {
      const error = saved.error ?? '原生保存失败'
      bridge.appendDiagLog(`[backup] save failed: ${error}`)
      return { mode: 'error', learnedCount, progressAnomaly: false, error }
    }
    bridge.setFlag(AUTO_BACKUP_FLAG_LAST_DATE, today)
    if (bridge.getFlag(AUTO_BACKUP_FLAG_ANOMALY) === '1') bridge.setFlag(AUTO_BACKUP_FLAG_ANOMALY, '0')
    const pruned = bridge.prune(AUTO_BACKUP_KEEP)
    bridge.appendDiagLog(
      `[backup] ok ${name} ${(bytes / 1024).toFixed(1)}KB pruned=${pruned} at ${new Date(now).toISOString()}`,
    )
    return {
      mode: 'backed-up',
      learnedCount,
      progressAnomaly: false,
      name: saved.name ?? name,
      ...(saved.path ? { path: saved.path } : {}),
      pruned,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    bridge.appendDiagLog(`[backup] error: ${message}`)
    return { mode: 'error', learnedCount, progressAnomaly: false, error: message }
  }
}

/** 自动备份列表（mtime 倒序；桥不可用时返回空） */
export function listAutoBackups(bridge: AutoBackupBridge): AutoBackupEntry[] {
  if (!bridge.isAvailable()) return []
  return [...bridge.list()].sort((a, b) => b.mtime - a.mtime)
}

async function writeRestoreStatus(status: AutoBackupRestoreStatus): Promise<void> {
  await getDb().meta.put({ key: AUTO_BACKUP_RESTORE_STATE_KEY, value: status, updatedAt: Date.now() })
}

/** 读取恢复状态；running 超过 5 分钟视为被系统中断（页面重载/WebView 回收） */
export async function getAutoBackupRestoreStatus(now = Date.now()): Promise<AutoBackupRestoreStatus> {
  const row = await getDb().meta.get(AUTO_BACKUP_RESTORE_STATE_KEY)
  const value = row?.value as AutoBackupRestoreStatus | undefined
  if (!value) return { status: 'idle' }
  if (value.status === 'running' && value.startedAt != null && now - value.startedAt > 5 * 60_000) {
    const interrupted: AutoBackupRestoreStatus = {
      ...value,
      status: 'failed',
      interrupted: true,
      error: '上次恢复超时/被系统中断；请重试（原始备份未被修改）',
      finishedAt: now,
    }
    await writeRestoreStatus(interrupted)
    return interrupted
  }
  return value
}

/**
 * 恢复指定 auto 备份：
 * 1) 先把当前数据导出并写入 auto（pre-restore）；
 * 2) importMigration(merge)；
 * 3) 返回导入报告；任何失败都不做部分写入。
 */
export async function restoreAutoBackup(
  bridge: AutoBackupBridge,
  name: string,
  opts: {
    now?: number
    skipPreBackup?: boolean
    maxBytes?: number
    onProgress?: (progress: { phase: AutoBackupRestorePhase; message?: string }) => void
  } = {},
): Promise<AutoBackupRestoreResult> {
  if (!bridge.isAvailable()) return { ok: false, name, error: '当前环境不支持自动备份恢复' }
  const now = opts.now ?? Date.now()
  await writeRestoreStatus({ status: 'running', name, phase: 'read', startedAt: now })
  const reportProgress = (phase: AutoBackupRestorePhase) => {
    void writeRestoreStatus({ status: 'running', name, phase, startedAt: now })
    opts.onProgress?.({ phase })
  }
  const text = bridge.read(name)
  if (!text) {
    const error = `读取备份失败：${name}`
    await writeRestoreStatus({ status: 'failed', name, startedAt: now, finishedAt: Date.now(), error })
    return { ok: false, name, error }
  }
  // 先做格式校验：auto 文件必须是迁移 JSON；避免把 gzip 乱码/空文件当迁移解析后给出模糊 ok=false
  try {
    const parsed = JSON.parse(text) as { format?: unknown; formatVersion?: unknown }
    if (!parsed || typeof parsed !== 'object' || typeof parsed.format !== 'string') {
      bridge.appendDiagLog(`[restore] invalid json shape: ${name}`)
      const error = `备份内容不是有效迁移 JSON：${name}`
      await writeRestoreStatus({ status: 'failed', name, startedAt: now, finishedAt: Date.now(), error })
      return { ok: false, name, error }
    }
  } catch (error) {
    bridge.appendDiagLog(`[restore] parse failed: ${name} ${error instanceof Error ? error.message : String(error)}`)
    const message = `备份内容解析失败（可能不是 JSON/解压错误）：${name}`
    await writeRestoreStatus({ status: 'failed', name, startedAt: now, finishedAt: Date.now(), error: message })
    return { ok: false, name, error: message }
  }
  let preRestoreName: string | undefined
  if (!opts.skipPreBackup) {
    reportProgress('pre-backup')
    try {
      const current = await (await exportMigration()).text()
      const maxBytes = opts.maxBytes ?? AUTO_BACKUP_MAX_BYTES
      if (byteLength(current) > maxBytes) {
        const error = `当前数据超过 ${(maxBytes / 1024 / 1024).toFixed(0)}MB，已取消恢复（避免无法回滚）`
        await writeRestoreStatus({ status: 'failed', name, startedAt: now, finishedAt: Date.now(), error })
        return { ok: false, name, error }
      }
      preRestoreName = `pre-restore-${localDateKey(now)}-${String(now % 100000).padStart(5, '0')}.migration.json`
      const saved = await bridge.save(current, preRestoreName)
      if (!saved.ok) {
        bridge.appendDiagLog(`[restore] pre-backup failed: ${saved.error ?? 'unknown'}`)
        const error = `恢复前备份当前数据失败：${saved.error ?? '未知错误'}`
        await writeRestoreStatus({ status: 'failed', name, startedAt: now, finishedAt: Date.now(), error })
        return { ok: false, name, error }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      bridge.appendDiagLog(`[restore] pre-backup error: ${message}`)
      await writeRestoreStatus({ status: 'failed', name, startedAt: now, finishedAt: Date.now(), error: `恢复前备份失败：${message}` })
      return { ok: false, name, error: `恢复前备份失败：${message}` }
    }
  }
  try {
    reportProgress('parse')
    const report = await importMigration(text, {
      strategy: 'merge',
      onProgress: (progress) => {
        const phase: AutoBackupRestorePhase =
          progress.phase === 'read' ? 'read' : progress.phase === 'parse' ? 'parse' : progress.phase === 'checksum' ? 'checksum' : progress.phase === 'validate' ? 'validate' : progress.phase === 'apply' ? 'apply' : 'done'
        reportProgress(phase)
      },
    })
    const firstError = report.issues.find((issue) => issue.level === 'error')
    bridge.appendDiagLog(
      `[restore] ${name} ok=${report.ok} pre=${preRestoreName ?? 'none'}${
        firstError ? ` issue=${firstError.code}:${firstError.message}` : ''
      }`,
    )
    if (report.ok) {
      await writeRestoreStatus({ status: 'completed', name, startedAt: now, finishedAt: Date.now(), ...(preRestoreName ? { preRestoreName } : {}) })
    } else {
      const error = firstError?.message ?? '导入失败'
      await writeRestoreStatus({ status: 'failed', name, startedAt: now, finishedAt: Date.now(), error, ...(preRestoreName ? { preRestoreName } : {}) })
    }
    return {
      ok: report.ok,
      name,
      ...(preRestoreName ? { preRestoreName } : {}),
      report,
      ...(report.ok ? {} : { error: firstError?.message ?? '导入失败' }),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    bridge.appendDiagLog(`[restore] import error: ${message}`)
    await writeRestoreStatus({ status: 'failed', name, startedAt: now, finishedAt: Date.now(), error: message, ...(preRestoreName ? { preRestoreName } : {}) })
    return { ok: false, name, ...(preRestoreName ? { preRestoreName } : {}), error: message }
  }
}

/** 删除某 auto 备份 */
export function deleteAutoBackup(bridge: AutoBackupBridge, name: string): boolean {
  if (!bridge.isAvailable()) return false
  return bridge.delete(name)
}
