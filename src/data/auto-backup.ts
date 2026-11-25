/**
 * 0.3.86（task-254）：每日自动备份 + 异常恢复（数据编排层）。
 * 原生桥由调用方注入（src/app/utils/auto-backup.ts 适配），Web/PWA 不静默写。
 */
import { localDateKey, type ImportReport } from '../core'
import { getDb } from './db'
import { getLearningWriteSource } from './learning-write-source'
import { isSqliteAvailable, sqliteHealth } from './native-sqlite'
import { extractSqliteCounts } from './sqlite-store'
import {
  createSqliteFactsBackup,
  deleteSqliteBackupFile,
  deleteSqliteBackupManifest,
  listSqliteBackupFiles,
  saveSqliteBackupManifest,
  SQLITE_BACKUP_PREFIX,
} from './sqlite-backup'
import { exportMigrationText, importMigration } from './import-export'
import { withDataWriteLock } from './write-lock'
import { flushStateCheckpoint } from './state-checkpoint'

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
export const AUTO_BACKUP_RUN_STATE_KEY = 'backup.lastRunState'

export type AutoBackupRunPhase = 'idle' | 'exporting' | 'stringifying' | 'saving' | 'done' | 'failed'

export interface AutoBackupRunStatus {
  status: 'idle' | 'running' | 'completed' | 'failed'
  phase?: AutoBackupRunPhase
  startedAt?: number
  finishedAt?: number
  bytes?: number
  chars?: number
  name?: string
  error?: string
  /** M5：SQLite facts 备份元数据 */
  kind?: 'migration' | 'sqlite'
  checksum?: string
  counts?: { states: number; plans: number; settings: number; reviewLogs: number }
}

/** 0.8.0：清理空备份与超额备份（含 pre-restore），避免恢复列表出现 0KB/11 份 */
export function cleanupAutoBackups(bridge: AutoBackupBridge, keep: number = AUTO_BACKUP_KEEP): number {
  let removed = 0
  const entries = bridge
    .list()
    .filter((entry) => entry.name.endsWith('.migration.json'))
    .sort((a, b) => b.mtime - a.mtime)
  for (const entry of entries) {
    if (entry.size > 0) continue
    if (bridge.delete(entry.name)) removed += 1
  }
  const alive = bridge
    .list()
    .filter((entry) => entry.name.endsWith('.migration.json') && entry.size > 0)
    .sort((a, b) => b.mtime - a.mtime)
  const cap = Math.max(1, Math.floor(keep))
  for (const entry of alive.slice(cap)) {
    if (bridge.delete(entry.name)) removed += 1
  }
  return removed
}

export interface AutoBackupEntry {
  name: string
  size: number
  mtime: number
  path: string
  kind?: 'migration' | 'sqlite'
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
  /** 0.4.0：导出/序列化/保存进度 */
  onProgress?: (progress: { phase: AutoBackupRunPhase; chars?: number }) => void
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
  // 0.10.0：时间戳文件名，避免覆盖唯一的好备份；prune 保留最近 N 份
  const time = new Date(now).toTimeString().slice(0, 8).replace(/:/g, '')
  return `auto-backup-${localDateKey(now)}-${time}.migration.json`
}

function partialBackupFileName(now: number): string {
  const time = new Date(now).toTimeString().slice(0, 8).replace(/:/g, '')
  return `auto-backup-${localDateKey(now)}-${time}.partial`
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

async function writeRunStatus(status: AutoBackupRunStatus): Promise<void> {
  await getDb().meta.put({ key: AUTO_BACKUP_RUN_STATE_KEY, value: status, updatedAt: Date.now() })
}

/** 读取自动备份最近一次运行状态（进度/失败持久可见） */
export async function getAutoBackupRunStatus(): Promise<AutoBackupRunStatus> {
  const row = await getDb().meta.get(AUTO_BACKUP_RUN_STATE_KEY)
  return (row?.value as AutoBackupRunStatus | undefined) ?? { status: 'idle' }
}

/** 0.7.6：备份/恢复互斥，避免并发 Dexie 事务导致 AbortError 清空数据 */
let autoBackupQueue: Promise<unknown> = Promise.resolve()
function withBackupLock<T>(task: () => Promise<T>): Promise<T> {
  const run = autoBackupQueue.then(task, task)
  autoBackupQueue = run.then(
    () => undefined,
    () => undefined,
  )
  return run
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
export function runAutoBackup(
  bridge: AutoBackupBridge,
  opts: AutoBackupRunOptions = {},
): Promise<AutoBackupRunResult> {
  return withBackupLock(() => runAutoBackupImpl(bridge, opts))
}

async function runAutoBackupSqlite(
  bridge: AutoBackupBridge,
  opts: AutoBackupRunOptions,
): Promise<AutoBackupRunResult> {
  const now = opts.now ?? Date.now()
  let counts: { states: number; plans: number; settings: number; reviewLogs: number }
  try {
    const health = await sqliteHealth(10_000)
    const extracted = extractSqliteCounts(health as never)
    if (!extracted) return { mode: 'error', learnedCount: 0, progressAnomaly: false, error: 'SQLite health 缺少 counts' }
    counts = extracted
  } catch (error) {
    return { mode: 'error', learnedCount: 0, progressAnomaly: false, error: `SQLite health 失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const learnedCount = counts.states
  const progressAnomaly = learnedCount === 0 && bridge.getFlag(AUTO_BACKUP_FLAG_HAD_PROGRESS) === '1'
  if (progressAnomaly) {
    bridge.appendDiagLog(`[backup] sqlite progressAnomaly learned=0 at ${new Date(now).toISOString()}`)
    return { mode: 'anomaly', learnedCount, progressAnomaly: true }
  }
  if (learnedCount === 0) return { mode: 'skipped', learnedCount, progressAnomaly: false }
  if (bridge.getFlag(AUTO_BACKUP_FLAG_HAD_PROGRESS) !== '1') bridge.setFlag(AUTO_BACKUP_FLAG_HAD_PROGRESS, '1')
  if (!bridge.isAvailable()) return { mode: 'unavailable', learnedCount, progressAnomaly: false }
  const startedAt = now
  const report = (phase: AutoBackupRunPhase) => {
    void writeRunStatus({ status: phase === 'done' ? 'completed' : phase === 'failed' ? 'failed' : 'running', phase, startedAt, kind: 'sqlite', counts })
    opts.onProgress?.({ phase })
  }
  try {
    report('exporting')
    const created = await createSqliteFactsBackup()
    if (!created.ok || !created.manifest) {
      const error = created.error ?? 'SQLite facts 备份失败'
      bridge.appendDiagLog(`[backup] sqlite failed: ${error}`)
      await writeRunStatus({ status: 'failed', phase: 'failed', startedAt, finishedAt: Date.now(), error, kind: 'sqlite', counts })
      return { mode: 'error', learnedCount, progressAnomaly: false, error }
    }
    const manifest = created.manifest
    await saveSqliteBackupManifest(manifest)
    report('saving')
    const files = await listSqliteBackupFiles()
    const keep = AUTO_BACKUP_KEEP
    // 自动备份列表同时包含 SQLite .db 与旧 migration JSON；按总份数保留 7，避免 UI 10+ 份。
    const legacy = bridge.list()
      .filter((entry) => /\.migration\.json(\.gz)?$/.test(entry.name) && entry.size > 0)
      .map((entry) => ({ name: entry.name, mtime: entry.mtime, kind: 'migration' as const }))
    const combined = [
      ...files.map((file) => ({ name: file.name, mtime: file.mtime, kind: 'sqlite' as const })),
      ...legacy,
    ].sort((a, b) => b.mtime - a.mtime)
    let pruned = 0
    for (const old of combined.slice(keep)) {
      if (old.kind === 'sqlite') {
        await deleteSqliteBackupFile(old.name)
        await deleteSqliteBackupManifest(old.name)
      } else {
        bridge.delete(old.name)
      }
      pruned += 1
    }
    bridge.setFlag(AUTO_BACKUP_FLAG_LAST_DATE, localDateKey(now))
    if (bridge.getFlag(AUTO_BACKUP_FLAG_ANOMALY) === '1') bridge.setFlag(AUTO_BACKUP_FLAG_ANOMALY, '0')
    bridge.appendDiagLog(`[backup] sqlite ok ${manifest.name} ${(manifest.bytes / 1024).toFixed(1)}KB`)
    await writeRunStatus({
      status: 'completed', phase: 'done', startedAt, finishedAt: Date.now(),
      bytes: manifest.bytes, name: manifest.name, kind: 'sqlite',
      ...(manifest.checksum ? { checksum: manifest.checksum } : {}), counts,
    })
    return {
      mode: 'backed-up', learnedCount, progressAnomaly: false,
      name: manifest.name, ...(manifest.path ? { path: manifest.path } : {}),
      pruned,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    bridge.appendDiagLog(`[backup] sqlite error: ${message}`)
    await writeRunStatus({ status: 'failed', phase: 'failed', startedAt, finishedAt: Date.now(), error: message, kind: 'sqlite', counts })
    return { mode: 'error', learnedCount, progressAnomaly: false, error: message }
  }
}

async function runAutoBackupImpl(
  bridge: AutoBackupBridge,
  opts: AutoBackupRunOptions = {},
): Promise<AutoBackupRunResult> {
  if (opts.enabled === false) return { mode: 'skipped', learnedCount: 0, progressAnomaly: false }
  // M5：学习事实在 SQLite 时，自动备份/异常检测以 SQLite 为源，不再导出 IDB。
  if (getLearningWriteSource() === 'sqlite' && isSqliteAvailable()) {
    return runAutoBackupSqlite(bridge, opts)
  }
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

  const startedAt = now
  const report = (phase: AutoBackupRunPhase, extra: Partial<AutoBackupRunStatus> = {}) => {
    void writeRunStatus({ status: phase === 'done' ? 'completed' : phase === 'failed' ? 'failed' : 'running', phase, startedAt, ...extra })
    opts.onProgress?.({ phase, ...(extra.chars != null ? { chars: extra.chars } : {}) })
  }
  try {
    report('exporting')
    const text = opts.exportText
      ? await opts.exportText()
      : await exportMigrationText({
          onProgress: (progress) => {
            if (progress.phase === 'build') report('exporting')
            else {
              report('stringifying', progress.chars != null ? { chars: progress.chars } : {})
            }
          },
        })
    const bytes = byteLength(text)
    report('stringifying', { bytes })
    const maxBytes = opts.maxBytes ?? AUTO_BACKUP_MAX_BYTES
    if (bytes > maxBytes) {
      const error = `备份体积 ${(bytes / 1024 / 1024).toFixed(1)}MB 超过 ${maxBytes / 1024 / 1024}MB 上限，跳过`
      bridge.appendDiagLog(`[backup] skipped: ${error}`)
      await writeRunStatus({ status: 'failed', phase: 'failed', startedAt, finishedAt: Date.now(), bytes, error })
      return { mode: 'error', learnedCount, progressAnomaly: false, error }
    }
    const name = backupFileName(now)
    const partial = partialBackupFileName(now)
    report('saving', { bytes })
    // 0.10.0：先写 .partial，读回校验 JSON/字节数，再覆盖正式文件；失败保留旧备份
    const partialSaved = await bridge.save(text, partial)
    if (!partialSaved.ok) {
      const error = partialSaved.error ?? '原生保存临时文件失败'
      bridge.appendDiagLog(`[backup] partial save failed: ${error} partialActual=${partialSaved.name ?? partial}`)
      await writeRunStatus({ status: 'failed', phase: 'failed', startedAt, finishedAt: Date.now(), bytes, name, error })
      return { mode: 'error', learnedCount, progressAnomaly: false, error }
    }
    const partialActual = partialSaved.name ?? partial
    const readBack = bridge.read(partialActual)
    let partialValid = false
    if (readBack && byteLength(readBack) === bytes) {
      try {
        JSON.parse(readBack)
        partialValid = true
      } catch {
        partialValid = false
      }
    }
    if (!partialValid) {
      bridge.delete(partialActual)
      const error = '备份临时文件校验失败（大小/JSON 不完整），已保留旧备份'
      bridge.appendDiagLog(`[backup] ${error} partialActual=${partialActual}`)
      await writeRunStatus({ status: 'failed', phase: 'failed', startedAt, finishedAt: Date.now(), bytes, name, error })
      return { mode: 'error', learnedCount, progressAnomaly: false, error }
    }
    const saved = await bridge.save(text, name)
    bridge.delete(partialActual)
    if (!saved.ok) {
      const error = saved.error ?? '原生保存失败'
      bridge.appendDiagLog(`[backup] save failed: ${error}`)
      await writeRunStatus({ status: 'failed', phase: 'failed', startedAt, finishedAt: Date.now(), bytes, name, error })
      return { mode: 'error', learnedCount, progressAnomaly: false, error }
    }
    bridge.setFlag(AUTO_BACKUP_FLAG_LAST_DATE, today)
    if (bridge.getFlag(AUTO_BACKUP_FLAG_ANOMALY) === '1') bridge.setFlag(AUTO_BACKUP_FLAG_ANOMALY, '0')
    const pruned = bridge.prune(AUTO_BACKUP_KEEP)
    const cleaned = cleanupAutoBackups(bridge, AUTO_BACKUP_KEEP)
    if (cleaned > 0) bridge.appendDiagLog(`[backup] cleanup removed ${cleaned}`)
    bridge.appendDiagLog(
      `[backup] ok ${name} ${(bytes / 1024).toFixed(1)}KB pruned=${pruned} at ${new Date(now).toISOString()}`,
    )
    await writeRunStatus({ status: 'completed', phase: 'done', startedAt, finishedAt: Date.now(), bytes, name: saved.name ?? name })
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
    await writeRunStatus({ status: 'failed', phase: 'failed', startedAt, finishedAt: Date.now(), error: message })
    return { mode: 'error', learnedCount, progressAnomaly: false, error: message }
  }
}

/** 自动备份列表（mtime 倒序；桥不可用时返回空） */
export function listAutoBackups(bridge: AutoBackupBridge): AutoBackupEntry[] {
  if (!bridge.isAvailable()) return []
  return [...bridge.list()].map((entry) => ({ ...entry, kind: entry.name.endsWith('.db') ? 'sqlite' as const : 'migration' as const })).sort((a, b) => b.mtime - a.mtime)
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
export function restoreAutoBackup(
  bridge: AutoBackupBridge,
  name: string,
  opts: {
    now?: number
    skipPreBackup?: boolean
    maxBytes?: number
    /** 0.7.2：import 超时（默认 120s）；超时置 failed，可重试 */
    timeoutMs?: number
    /** 测试注入 import 实现 */
    importImpl?: (text: string, options: Parameters<typeof importMigration>[1]) => ReturnType<typeof importMigration>
    onProgress?: (progress: { phase: AutoBackupRestorePhase; message?: string }) => void
  } = {},
): Promise<AutoBackupRestoreResult> {
  return withBackupLock(() => restoreAutoBackupImpl(bridge, name, opts))
}

async function restoreAutoBackupImpl(
  bridge: AutoBackupBridge,
  name: string,
  opts: {
    now?: number
    skipPreBackup?: boolean
    maxBytes?: number
    timeoutMs?: number
    importImpl?: (text: string, options: Parameters<typeof importMigration>[1]) => ReturnType<typeof importMigration>
    onProgress?: (progress: { phase: AutoBackupRestorePhase; message?: string }) => void
  } = {},
): Promise<AutoBackupRestoreResult> {
  return withDataWriteLock(() => restoreAutoBackupInner(bridge, name, opts))
}

async function restoreAutoBackupInner(
  bridge: AutoBackupBridge,
  name: string,
  opts: {
    now?: number
    skipPreBackup?: boolean
    maxBytes?: number
    timeoutMs?: number
    importImpl?: (text: string, options: Parameters<typeof importMigration>[1]) => ReturnType<typeof importMigration>
    onProgress?: (progress: { phase: AutoBackupRestorePhase; message?: string }) => void
  } = {},
): Promise<AutoBackupRestoreResult> {
  if (!bridge.isAvailable()) return { ok: false, name, error: '当前环境不支持自动备份恢复' }
  const now = opts.now ?? Date.now()
  let timedOut = false
  await writeRestoreStatus({ status: 'running', name, phase: 'read', startedAt: now })
  const reportProgress = (phase: AutoBackupRestorePhase) => {
    if (timedOut) return
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
      const current = await exportMigrationText()
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
  const timeoutMs = Math.max(1_000, Math.floor(opts.timeoutMs ?? 120_000))
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    reportProgress('parse')
    const importTask = (opts.importImpl ?? importMigration)(text, {
      strategy: 'merge',
      shouldAbort: () => timedOut,
      skipWriteLock: true,
      onProgress: (progress) => {
        // 0.10.0：超时后作为取消信号，阻止 import 后续阶段继续写
        if (timedOut) throw new Error('恢复已超时，已取消后续写入')
        const phase: AutoBackupRestorePhase =
          progress.phase === 'read' ? 'read' : progress.phase === 'parse' ? 'parse' : progress.phase === 'checksum' ? 'checksum' : progress.phase === 'validate' ? 'validate' : progress.phase === 'apply' ? 'apply' : 'done'
        reportProgress(phase)
      },
    })
    const report = await Promise.race([
      importTask,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          // 先置取消信号，再 reject；避免 late import 在 catch 前继续写
          timedOut = true
          reject(new Error(`恢复超时（>${Math.round(timeoutMs / 1000)}s）`))
        }, timeoutMs)
      }),
    ])
    if (timer) clearTimeout(timer)
    const firstError = report.issues.find((issue) => issue.level === 'error')
    bridge.appendDiagLog(
      `[restore] ${name} ok=${report.ok} pre=${preRestoreName ?? 'none'}${
        firstError ? ` issue=${firstError.code}:${firstError.message}` : ''
      }`,
    )
    if (report.ok) {
      await writeRestoreStatus({ status: 'completed', name, startedAt: now, finishedAt: Date.now(), ...(preRestoreName ? { preRestoreName } : {}) })
      // 0.10.0：恢复后立刻用新 states 覆盖检查点，避免回退到恢复前旧进度
      await flushStateCheckpoint(bridge).catch(() => undefined)
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
    if (timer) clearTimeout(timer)
    const raw = error instanceof Error ? error.message : String(error)
    const timeout = /恢复超时/.test(raw)
    if (timeout) timedOut = true
    const message = timeout
      ? `恢复超时/被中断（>${Math.round(timeoutMs / 1000)}s）：${raw}，可重试`
      : raw
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


/** 0.11.0 M5：自动备份以 SQLite facts 为主，manifest 存 bridge；旧 JSON 包仅 legacy 可读 */
export async function runSqliteFactsAutoBackup(
  bridge: AutoBackupBridge,
  opts: { now?: number; force?: boolean } = {},
): Promise<AutoBackupRunResult> {
  const now = opts.now ?? Date.now()
  if (!bridge.isAvailable()) return { mode: 'unavailable', learnedCount: 0, progressAnomaly: false }
  try {
    const backup = await createSqliteFactsBackup()
    if (!backup.ok || !backup.manifest) {
      const error = backup.error ?? 'SQLite facts 备份失败'
      bridge.appendDiagLog(`[backup-sqlite] failed: ${error}`)
      return { mode: 'error', learnedCount: 0, progressAnomaly: false, error }
    }
    const date = localDateKey(now)
    const manifestName = `${SQLITE_BACKUP_PREFIX.replace('sqlite-', 'auto-sqlite-')}${date}.manifest.json`
    const text = JSON.stringify({ ...backup.manifest, format: 'momo-sqlite-auto-backup-manifest', legacyJsonBackup: false })
    const saved = await bridge.save(text, manifestName)
    if (!saved.ok) return { mode: 'error', learnedCount: backup.manifest.counts.states, progressAnomaly: false, error: saved.error ?? 'manifest 保存失败' }
    return { mode: 'backed-up', learnedCount: backup.manifest.counts.states, name: manifestName, path: saved.path, progressAnomaly: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    bridge.appendDiagLog(`[backup-sqlite] exception: ${message}`)
    return { mode: 'error', learnedCount: 0, progressAnomaly: false, error: message }
  }
}
