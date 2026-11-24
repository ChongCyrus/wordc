import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ImportReport } from '../../core'
import {
  exportAllDerivationMaps,
  exportMigration,
  FULL_BACKUP_MAX_BYTES,
  applyCoreSenseMnemonicImportParsed,
  buildCoreSenseMnemonicExport,
  coreSenseMnemonicFileName,
  exportCoreSenseMnemonicJson,
  getAutoBackupRestoreStatus,
  getAutoBackupRunStatus,
  exportRootEtymologyBundleText,
  importRootEtymologyBundle,
  isRootEtymologyBundle,
  importDerivationBundle,
  importMigration,
  previewCoreSenseMnemonicImport,
  parseDerivationBundle,
  isSqliteAvailable,
  sqliteCall,
  sqliteHealth,
  sqliteQuery,
  enableSettingsSqliteWrite,
  persistSettingsWriteMode,
  getIdbFactCounts,
  getSettingsWriteMode,
  migrateIdbToSqlite,
  createFactsPreBackup,
  rebuildIdbCacheFromSqlite,
  repairMigratedPlans,
  reconcileTodayPlanToSqlite,
  getRawPlanDiagnostics,
  getRawSettingDiagnostics,
  getLegacyUpgradeDiagnostics,
  getImportStageDiagnostics,
  getStartupTiming,
  getLearningWriteSource,
  enableLearningSqliteWrite,
  revertLearningWriteSourceToIdb,
  repairLearningWriteSource,
  getTodayPlan,
  createSqliteFactsBackup,
  getSqliteFactsManifest,
  listSqliteBackupFiles,
  getSqliteBackupManifest,
  restoreSqliteFactsBackup,
  getSqliteCheckpointStatus,
  flushSqliteFactsCheckpointAuto,
  buildIdbRollbackCache,
  buildRollbackMigrationText,
  detectIdbDeltaSinceSqlite,
  getDataEpoch,
} from '../../data'
import { useStatsOverview } from '../../app/hooks/useStats'
import { useTheme } from '../../app/theme'
import './me.css'
import { useToast } from '../../app/toast'
import { useSettings } from '../../app/hooks/useSettings'
import { useGeneratedSeedStatus } from '../../app/hooks/useGeneratedSeedStatus'
import {
  ensurePersistentStorage,
  flushProgressCheckpoint,
  getProgressCheckpointStatus,
  restoreProgressCheckpointIfEmpty,
  buildSafetyDiagnosticsText,
  createAutoBackupBridge,
  createPreBackup,
  getSettingsWriteDiagnostics,
  listAutoBackupsForUi,
  listValidatedAutoBackupsForUi,
  restoreAutoBackupForUi,
  startupAutoBackup,
} from '../../app/utils/auto-backup-service'
import type { AutoBackupRestoreStatus, StateCheckpointStatus } from '../../data'
import {
  exportBackupToDownloads,
  isAutoBackupAvailable,
  readDiagnosticFile,
  type AutoBackupEntry,
} from '../../app/utils/auto-backup'
import {
  datedFileName,
  pickTextFile,
  readFileAsText,
  saveBlobFile,
  saveResultMessage,
} from '../../app/utils/files'
import { APP_VERSION } from '../../app/version'
import { BRAND } from '../../app/brand'
import { PageShell } from '../components/PageShell'
import { SearchFilterBar } from '../components/SearchFilterBar'
import { SectionBand, Card } from '../components/SectionBand'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { SettingRow } from '../components/SettingRow'
import { Switch } from '../components/Switch'
import { OwlIcon } from '../components/icons'
import { BatchDerivationPanel } from './BatchDerivationPanel'
import { countCoreSenseExportStats } from './core-io-stats'

/**
 * 我的（SPEC §8.3 / 03-ui §4.7）：
 * 头像/词汇量/打卡 + 学习数据入口 + 数据管理 + 设置/关于 + 深色模式快捷开关。
 */
export default function MePage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const toast = useToast()
  const { resolved, setMode } = useTheme()
  const { overview } = useStatsOverview()
  const { settings, update: patch } = useSettings()
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [pendingForce, setPendingForce] = useState<string | null>(null)
  const [bundleExporting, setBundleExporting] = useState(false)
  const [bundleImporting, setBundleImporting] = useState(false)
  const [batchOpen, setBatchOpen] = useState(false)
  const [confirmCompleteExport, setConfirmCompleteExport] = useState(false)
  const [coreExportOpen, setCoreExportOpen] = useState(false)
  const [coreExportScope, setCoreExportScope] = useState<'all' | 'deck'>('all')
  const [coreExportStats, setCoreExportStats] = useState<{
    words: number
    senses: number
    withMnemonic: number
    pending: number
  } | null>(null)
  const [coreExportBusy, setCoreExportBusy] = useState(false)
  const [coreImportPreview, setCoreImportPreview] = useState<null | {
    text: string
    report: Awaited<ReturnType<typeof previewCoreSenseMnemonicImport>>
  }>(null)
  const [coreImportBusy, setCoreImportBusy] = useState(false)
  const [coreImportPhase, setCoreImportPhase] = useState<string | null>(null)
  const [coreImportProgress, setCoreImportProgress] = useState<{
    phase: string
    done: number
    total: number
  } | null>(null)
  const [coreOverwrite, setCoreOverwrite] = useState(false)
  const [coreOverwriteConfirmed, setCoreOverwriteConfirmed] = useState(false)
  const [coreImportDone, setCoreImportDone] = useState(false)
  const [autoBackups, setAutoBackups] = useState<AutoBackupEntry[]>([])
  const [autoBusy, setAutoBusy] = useState(false)
  const [autoRunLabel, setAutoRunLabel] = useState<string | null>(null)
  const [autoRestoreOpen, setAutoRestoreOpen] = useState(false)
  const [autoRestoreList, setAutoRestoreList] = useState<AutoBackupEntry[] | null>(null)
  const [autoRestoreListLoading, setAutoRestoreListLoading] = useState(false)
  const [autoRestoreTarget, setAutoRestoreTarget] = useState<AutoBackupEntry | null>(null)
  const [autoRestoreBusy, setAutoRestoreBusy] = useState(false)
  const [autoRestoreStatus, setAutoRestoreStatus] = useState<{
    phase: 'running' | 'success' | 'error'
    name: string
    elapsedSec: number
    error?: string
    report?: { words: number; states: number }
    preRestoreName?: string
  } | null>(null)
  const [restorePersisted, setRestorePersisted] = useState<AutoBackupRestoreStatus | null>(null)
  const [rootExportOpen, setRootExportOpen] = useState(false)
  const [rootExportBusy, setRootExportBusy] = useState(false)
  const [rootImportBusy, setRootImportBusy] = useState(false)
  const [rootImportReport, setRootImportReport] = useState<null | {
    ok: boolean
    updated: number
    skippedManual: number
    skippedMissing: number
    failed: number
    issues: string[]
  }>(null)
  const [sqliteDiagOpen, setSqliteDiagOpen] = useState(false)
  const [sqliteDiagBusy, setSqliteDiagBusy] = useState(false)
  const [sqliteDiagText, setSqliteDiagText] = useState('')
  const [migrationDiagOpen, setMigrationDiagOpen] = useState(false)
  const [migrationDiagBusy, setMigrationDiagBusy] = useState(false)
  const [migrationDiagText, setMigrationDiagText] = useState('')
  const [diagnosticOpen, setDiagnosticOpen] = useState(false)
  const [diagnosticText, setDiagnosticText] = useState('')
  const [exportBackupOpen, setExportBackupOpen] = useState(false)
  const [exportBackupBusy, setExportBackupBusy] = useState(false)
  const { status: generatedStatus, importing: generatedImporting, importNow: importGeneratedNow } =
    useGeneratedSeedStatus(1200)
  const [persistState, setPersistState] = useState<
    'unsupported' | 'granted' | 'prompt' | 'failed'
  >('prompt')
  const [checkpointStatus, setCheckpointStatus] = useState<StateCheckpointStatus | null>(null)
  const [settingsWriteInfo, setSettingsWriteInfo] = useState<{ mode: 'idb' | 'sqlite'; diag: unknown }>({ mode: 'idb', diag: null })
  const [learningWriteSource, setLearningWriteSource] = useState<'idb' | 'sqlite' | 'readonly'>('idb')
  const [sqliteManifest, setSqliteManifest] = useState<Awaited<ReturnType<typeof getSqliteFactsManifest>>>(null)
  const [sqliteBackups, setSqliteBackups] = useState<Array<{ name: string; path: string; size: number; mtime: number; manifest?: Record<string, unknown> }>>([])
  const [sqliteBackupBusy, setSqliteBackupBusy] = useState(false)
  const [sqliteRestoreOpen, setSqliteRestoreOpen] = useState(false)
  const [sqliteCheckpointStatus, setSqliteCheckpointStatus] = useState<Awaited<ReturnType<typeof getSqliteCheckpointStatus>> | null>(null)
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [rollbackBusy, setRollbackBusy] = useState(false)
  const [rollbackInfo, setRollbackInfo] = useState<null | {
    counts?: { states: number; plans: number; settings: number; reviewLogs: number }
    version?: string
    epoch?: number
    delta?: { hasDelta: boolean; states: number; plans: number; reviewLogs: number }
    file?: string
    error?: string
  }>(null)
  const [checkpointRestoreBusy, setCheckpointRestoreBusy] = useState(false)
  const [checkpointRestoreFailed, setCheckpointRestoreFailed] = useState(false)
  const currentDeckId = settings?.['data.selectedDeckId'] ?? ''
  const autoBackupAvailable = isAutoBackupAvailable()

  useEffect(() => {
    let alive = true
    const refresh = () => {
      void getProgressCheckpointStatus()
        .then((status) => {
          if (alive) setCheckpointStatus(status)
        })
        .catch(() => undefined)
    }
    const timer = window.setTimeout(refresh, 300)
    window.addEventListener('momo:progress-checkpoint-updated', refresh)
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.clearTimeout(timer)
      window.removeEventListener('momo:progress-checkpoint-updated', refresh)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.storage?.persisted) {
      setPersistState('unsupported')
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      void navigator.storage
        .persisted()
        .then((granted) => {
          if (alive) setPersistState(granted ? 'granted' : 'prompt')
        })
        .catch(() => {
          if (alive) setPersistState('prompt')
        })
    }, 500)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    const refresh = () => setLearningWriteSource(getLearningWriteSource())
    const timer = window.setInterval(refresh, 1500)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', refresh)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      void getSettingsWriteDiagnostics().then((info) => {
        if (alive) setSettingsWriteInfo(info)
      })
      if (alive) setLearningWriteSource(getLearningWriteSource())
      void getSqliteFactsManifest().then((manifest) => {
        if (alive) setSqliteManifest(manifest)
      })
      void getSqliteCheckpointStatus(createAutoBackupBridge()).then((status) => {
        if (alive) setSqliteCheckpointStatus(status)
      })
      void listSqliteBackupFiles()
        .then(async (files) => {
          const valid: Array<{ name: string; path: string; size: number; mtime: number; manifest?: Record<string, unknown> }> = []
          for (const file of files) {
            if (file.size <= 0) continue
            const manifest = await getSqliteBackupManifest(file.name).catch(() => null)
            if (!manifest || manifest.integrityOk !== true || manifest.bytes <= 0 || manifest.bytes !== file.size) continue
            valid.push({ name: file.name, path: file.path, size: file.size, mtime: file.mtime, manifest: manifest as unknown as Record<string, unknown> })
          }
          if (alive) setSqliteBackups(valid)
        })
        .catch((error) => {
          if (alive) toast.error(`读取 SQLite 备份失败：${error instanceof Error ? error.message : '未知错误'}`)
        })
    }, 400)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [])

  // 打开恢复对话框时才校验备份内容（避免 mount 读 25MB 备份阻塞首屏）
  useEffect(() => {
    if (!autoRestoreOpen) return
    let alive = true
    setAutoRestoreListLoading(true)
    const run = () => {
      void listValidatedAutoBackupsForUi()
        .then((list) => {
          if (!alive) return
          setAutoRestoreList(list)
        })
        .catch(() => {
          if (alive) setAutoRestoreList([])
        })
        .finally(() => {
          if (alive) setAutoRestoreListLoading(false)
        })
    }
    const timer = window.setTimeout(run, 0)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [autoRestoreOpen])

  useEffect(() => {
    if (searchParams.get('restoreCheckpoint') !== '1') return
    navigate('/me', { replace: true })
    void (async () => {
      const backup = await createPreBackup()
      if (!backup.ok) {
        toast.error(`预备份失败，已中止恢复：${backup.error ?? '未知错误'}`)
        return
      }
      const status = await restoreProgressCheckpointIfEmpty().catch((error: unknown) => ({
        state: 'failed' as const,
        error: error instanceof Error ? error.message : String(error),
      }))
      setCheckpointStatus(status)
      if (status.state === 'restored') {
        toast.success(`已恢复 ${status.restored?.states ?? 0} 条学习状态`)
        window.location.reload()
        return
      }
      if (status.state === 'failed') {
        setCheckpointRestoreFailed(true)
        toast.error(`恢复失败：${status.error ?? '未知错误'}`)
        return
      }
      toast.success('当前已有学习状态，检查点恢复仅在空库时自动执行')
    })()
  }, [searchParams, navigate, toast])

  useEffect(() => {
    if (!autoBackupAvailable) return
    const refreshAutoBackups = () => {
      try {
        setAutoBackups(listAutoBackupsForUi())
      } catch {
        /* 忽略列表刷新失败 */
      }
    }
    window.addEventListener('momo:auto-backup-updated', refreshAutoBackups)
    return () => window.removeEventListener('momo:auto-backup-updated', refreshAutoBackups)
  }, [autoBackupAvailable])

  useEffect(() => {
    if (!autoBackupAvailable) return
    let alive = true
    const poll = async () => {
      try {
        const next = await getAutoBackupRestoreStatus()
        if (!alive) return
        setRestorePersisted(next)
        if (next.status === 'running') {
          setAutoRestoreStatus((prev) =>
            prev && prev.phase === 'running'
              ? prev
              : {
                  phase: 'running',
                  name: next.name ?? '备份',
                  elapsedSec: next.startedAt ? Math.max(0, Math.floor((Date.now() - next.startedAt) / 1000)) : 0,
                },
          )
        } else if (next.status === 'failed') {
          setAutoRestoreStatus((prev) =>
            prev && prev.phase === 'running'
              ? {
                  phase: 'error',
                  name: next.name ?? '备份',
                  elapsedSec: 0,
                  error: next.interrupted ? '上次恢复被系统中断' : (next.error ?? '恢复失败'),
                }
              : prev,
          )
        } else if (next.status === 'completed') {
          setAutoRestoreStatus((prev) =>
            prev && prev.phase === 'running'
              ? {
                  phase: 'success',
                  name: next.name ?? '备份',
                  elapsedSec: 0,
                  ...(next.preRestoreName ? { preRestoreName: next.preRestoreName } : {}),
                }
              : prev,
          )
        }
      } catch {
        /* 状态轮询失败忽略 */
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 1200)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoBackupAvailable])

  useEffect(() => {
    let alive = true
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (!storage?.persisted) {
      setPersistState('unsupported')
    } else {
      void storage
        .persisted()
        .then((granted) => {
          if (!alive) return
          setPersistState(granted ? 'granted' : 'prompt')
        })
        .catch(() => alive && setPersistState('failed'))
    }
    if (autoBackupAvailable) {
      // 首帧只读目录元数据，不 read/parse 备份内容；校验延后并缓存（大备份可达 25MB）
      try {
        setAutoBackups(listAutoBackupsForUi())
      } catch {
        setAutoBackups([])
      }
      const timer = window.setTimeout(() => {
        if (!alive) return
        void listValidatedAutoBackupsForUi()
          .then((validated) => alive && setAutoBackups(validated))
          .catch(() => undefined)
      }, 1500)
      return () => {
        alive = false
        window.clearTimeout(timer)
      }
    }
    return () => {
      alive = false
    }
  }, [autoBackupAvailable])

  useEffect(() => {
    if (autoRestoreStatus?.phase !== 'running') return
    const timer = window.setInterval(() => {
      setAutoRestoreStatus((prev) =>
        prev && prev.phase === 'running' ? { ...prev, elapsedSec: prev.elapsedSec + 1 } : prev,
      )
    }, 1000)
    return () => window.clearInterval(timer)
  }, [autoRestoreStatus?.phase])

  useEffect(() => {
    if (!autoBusy) return
    const phaseLabels: Record<string, string> = {
      exporting: '导出中…',
      stringifying: '压缩中…',
      saving: '保存中…',
      done: '完成',
      failed: '失败',
    }
    const poll = async () => {
      try {
        const status = (await getAutoBackupRunStatus()) as { phase?: string } | null
        const phase = status?.phase
        if (phase) setAutoRunLabel(phaseLabels[phase] ?? `${phase}…`)
      } catch {
        /* 忽略状态读取失败 */
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 300)
    return () => window.clearInterval(timer)
  }, [autoBusy])

  const requestPersist = () => {
    void ensurePersistentStorage().then((granted) => setPersistState(granted ? 'granted' : 'failed'))
  }

  const handleAutoBackupNow = async () => {
    setAutoBusy(true)
    setAutoRunLabel('准备中…')
    try {
      const result = await startupAutoBackup({ force: true })
      if ('mode' in result && result.mode === 'disabled') {
        toast.error('自动备份已关闭，请先开启开关')
      } else if ('error' in result && result.error) {
        toast.error(`备份失败：${result.error}（若容量不足请清理旧备份）`)
      } else if ('mode' in result && result.mode === 'unavailable') {
        toast.error('当前环境不支持自动备份，请手动导出')
      } else {
        toast.success(result && 'name' in result && result.name ? `已创建自动备份：${result.name}` : '已创建自动备份')
      }
      if (autoBackupAvailable) setAutoBackups(listAutoBackupsForUi())
      else setAutoBackups([])
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '自动备份失败')
    } finally {
      setAutoBusy(false)
      setAutoRunLabel(null)
    }
  }

  const handleRestoreAutoBackup = async () => {
    if (!autoRestoreTarget) return
    const target = autoRestoreTarget
    setAutoRestoreTarget(null)
    setAutoRestoreBusy(true)
    setAutoRestoreStatus({ phase: 'running', name: target.name, elapsedSec: 0 })
    try {
      const result = await restoreAutoBackupForUi(target.name)
      if (result.ok) {
        await flushProgressCheckpoint().catch(() => undefined)
        setAutoRestoreStatus({
          phase: 'success',
          name: target.name,
          elapsedSec: 0,
          report: {
            words: result.report?.counts?.words ?? 0,
            states: result.report?.counts?.states ?? 0,
          },
          ...(result.preRestoreName ? { preRestoreName: result.preRestoreName } : {}),
        })
        toast.success(
          `恢复完成：${result.report?.counts?.words ?? 0} 词 / ${result.report?.counts?.states ?? 0} 条状态`,
        )
        setAutoBackups(listAutoBackupsForUi())
      } else {
        const message =
          result.error ??
          result.report?.issues?.find((issue) => issue.level === 'error')?.message ??
          '恢复失败'
        setAutoRestoreStatus({ phase: 'error', name: target.name, elapsedSec: 0, error: message })
        toast.error(message)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '恢复失败'
      setAutoRestoreStatus({ phase: 'error', name: target.name, elapsedSec: 0, error: message })
      toast.error(message)
    } finally {
      setAutoRestoreBusy(false)
    }
  }

  const handleRootExport = async (scope: 'all' | 'deck') => {
    setRootExportBusy(true)
    try {
      const text = await exportRootEtymologyBundleText(
        scope === 'deck' && currentDeckId ? { deckId: currentDeckId } : {},
      )
      const blob = new Blob([text], { type: 'application/json' })
      const result = await saveBlobFile(
        blob,
        datedFileName(`${BRAND.shortName}-词根缀源`, 'root-etymology.json'),
        'application/json',
      )
      const info = saveResultMessage(result)
      if (info.ok) toast.success(info.message)
      else toast.error(info.message)
      setRootExportOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出词根缀源失败')
    } finally {
      setRootExportBusy(false)
    }
  }

  const handleRootImport = async () => {
    setRootImportBusy(true)
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      const text = await readFileAsText(file)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        toast.error('JSON 解析失败，不是有效的词根缀源 bundle')
        return
      }
      if (!isRootEtymologyBundle(parsed)) {
        toast.error('不是有效的词根缀源 bundle')
        return
      }
      const report = await importRootEtymologyBundle(parsed, { preserveManual: true })
      setRootImportReport({
        ok: report.ok,
        updated: report.updated,
        skippedManual: report.skippedManual,
        skippedMissing: report.skippedMissing,
        failed: report.failed.length,
        issues: report.issues.map((issue) => issue.message),
      })
      if (report.ok) toast.success(`导入完成：更新 ${report.updated}，跳过手改 ${report.skippedManual}`)
      else toast.error('导入存在错误，请查看报告')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入词根缀源失败')
    } finally {
      setRootImportBusy(false)
    }
  }

  const darkMode = resolved === 'dark'

  const describeReport = (report: ImportReport): string => {
    if (report.ok) {
      return `导入完成：${report.counts.decks} 词库 / ${report.counts.words} 词 / ${report.counts.states} 条状态`
    }
    const issue = report.issues.find((item) => item.level === 'error')
    return issue ? `导入失败：${issue.message}` : '导入失败'
  }

  const handleImportMigration = async (text: string, force = false) => {
    setImporting(true)
    try {
      const report = await importMigration(text, {
        strategy: 'merge',
        preBackup: async () => {
          const r = await createFactsPreBackup(createAutoBackupBridge())
          return { ok: r.ok, ...(r.error ? { error: r.error } : {}) }
        },
        ...(force ? { force: true } : {}),
      })
      if (report.ok) {
        setPendingForce(null)
        toast.success(describeReport(report))
        return
      }
      const checksumIssue = report.issues.find((item) => item.code === 'E_CHECKSUM')
      if (checksumIssue && !force) {
        setPendingForce(text)
        return
      }
      toast.error(describeReport(report))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  const handleExportMigration = async (complete = false) => {
    setExporting(true)
    try {
      const blob = await exportMigration(
        complete
          ? { includeDerivationMaps: true, includeContentPacks: true, maxBytes: FULL_BACKUP_MAX_BYTES }
          : undefined,
      )
      const result = await saveBlobFile(
        blob,
        datedFileName(
          `${BRAND.shortName}-${complete ? '完整备份' : '学习进度'}`,
          'migration.json',
        ),
        'application/json',
      )
      const info = saveResultMessage(result)
      if (info.ok)
        toast.success(
          `${info.message}（${complete ? '含引申图/内容包，' : ''}含记忆状态，不含 Token）`,
        )
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setExporting(false)
    }
  }

  const handleExportDerivationBundle = async () => {
    setBundleExporting(true)
    try {
      const bundle = await exportAllDerivationMaps()
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const result = await saveBlobFile(
        blob,
        datedFileName(`${BRAND.shortName}-引申图`, 'derivation-bundle.json'),
        'application/json',
      )
      const info = saveResultMessage(result)
      if (info.ok) toast.success(`已导出 ${bundle.items?.length ?? 0} 条引申图`)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出引申图失败')
    } finally {
      setBundleExporting(false)
    }
  }

  const handlePickDerivationBundleImport = async () => {
    setBundleImporting(true)
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      const text = await readFileAsText(file)
      const parsed = parseDerivationBundle(text)
      if (!parsed.ok) {
        toast.error(`引申图文件无效：${parsed.errors[0] ?? '格式错误'}`)
        return
      }
      const result = await importDerivationBundle(text, { mode: 'merge' })
      toast.success(
        `导入引申图：成功 ${result.imported} / 跳过 ${result.skipped} / 失败 ${result.failed}`,
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入引申图失败')
    } finally {
      setBundleImporting(false)
    }
  }

  const loadCoreExportStats = async (scope: 'all' | 'deck') => {
    setCoreExportStats(null)
    try {
      const file = await buildCoreSenseMnemonicExport(
        scope === 'deck' && currentDeckId ? { deckId: currentDeckId } : {},
      )
      setCoreExportStats(countCoreSenseExportStats(file))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '统计本义助记失败')
    }
  }

  const openCoreExport = () => {
    const scope = currentDeckId ? 'all' : 'all'
    setCoreExportScope(scope)
    setCoreExportOpen(true)
    void loadCoreExportStats(scope)
  }

  const handleCoreExport = async () => {
    setCoreExportBusy(true)
    try {
      const deckId = coreExportScope === 'deck' && currentDeckId ? currentDeckId : undefined
      const blob = await exportCoreSenseMnemonicJson(deckId ? { deckId } : {})
      const result = await saveBlobFile(blob, coreSenseMnemonicFileName(), 'application/json')
      const info = saveResultMessage(result)
      if (!info.ok) {
        toast.error(info.message)
        return
      }
      const stats = coreExportStats
      toast.success(
        stats
          ? `${info.message}（词 ${stats.words} / 本义 ${stats.senses} / 已有助记 ${stats.withMnemonic} / 待生成 ${stats.pending}）`
          : info.message,
      )
      setCoreExportOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出本义助记失败')
    } finally {
      setCoreExportBusy(false)
    }
  }

  const handlePickCoreMnemonicImport = async () => {
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      setCoreImportBusy(true)
      setCoreImportPhase('读取/校验中…')
      const text = await readFileAsText(file)
      setCoreImportProgress({ phase: 'resolve', done: 0, total: 0 })
      const report = await previewCoreSenseMnemonicImport(text, {
        onProgress: (progress) => {
          setCoreImportProgress(progress)
          setCoreImportPhase(
            progress.phase === 'resolve'
              ? `读取/校验中… ${progress.done}/${progress.total || '?'}`
              : `导入中… ${progress.done}/${progress.total || '?'}`,
          )
        },
      })
      if (!report.ok) {
        const issue = report.issues.find((item) => item.level === 'error')
        toast.error(issue?.message ?? '本义助记文件校验失败')
        return
      }
      setCoreOverwrite(false)
      setCoreImportDone(false)
      setCoreImportPreview({ text, report })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取文件失败')
    } finally {
      setCoreImportBusy(false)
      setCoreImportPhase(null)
      setCoreImportProgress(null)
    }
  }

  const handleApplyCoreImport = async () => {
    if (!coreImportPreview) return
    if (coreOverwrite) {
      // 覆盖需二次确认：确认框由按钮文案/警告承担
    }
    setCoreImportBusy(true)
    setCoreImportPhase('导入中…')
    try {
      setCoreImportProgress({ phase: 'apply', done: 0, total: 0 })
      const report = await applyCoreSenseMnemonicImportParsed(coreImportPreview.report, {
        overwrite: coreOverwrite,
        onProgress: (progress) => {
          setCoreImportProgress(progress)
          setCoreImportPhase(`导入中… ${progress.done}/${progress.total || '?'}`)
        },
      })
      setCoreImportPreview({ ...coreImportPreview, report })
      setCoreImportDone(true)
      if (report.ok) {
        toast.success(
          `导入完成：本义助记 ${report.counts.sensesImported} 条 · 串联 ${report.counts.overviewsImported} 条 · 跳过 ${report.counts.skippedExisting + report.counts.skippedManual} · stale ${report.counts.stale}`,
        )
      } else {
        const issue = report.issues.find((item) => item.level === 'error')
        toast.error(issue?.message ?? '导入失败，已有数据未清空')
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败，已有数据未清空')
    } finally {
      setCoreImportBusy(false)
      setCoreImportPhase(null)
      setCoreImportProgress(null)
    }
  }

  const handlePickMigrationImport = async () => {
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      const text = await readFileAsText(file)
      await handleImportMigration(text)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '读取文件失败')
    }
  }

  const restorePhaseLabel = (phase?: string): string => {
    switch (phase) {
      case 'read':
        return '读取备份'
      case 'pre-backup':
        return '恢复前备份'
      case 'parse':
        return '解析'
      case 'checksum':
        return '校验'
      case 'validate':
        return '校验数据'
      case 'apply':
        return '写入数据'
      case 'done':
        return '完成'
      default:
        return '处理中'
    }
  }

  const openRestoreStatus = () => {
    if (!restorePersisted || restorePersisted.status === 'idle') return
    if (restorePersisted.status === 'running') {
      setAutoRestoreStatus({
        phase: 'running',
        name: restorePersisted.name ?? '备份',
        elapsedSec: restorePersisted.startedAt
          ? Math.max(0, Math.floor((Date.now() - restorePersisted.startedAt) / 1000))
          : 0,
      })
    } else if (restorePersisted.status === 'failed') {
      setAutoRestoreStatus({
        phase: 'error',
        name: restorePersisted.name ?? '备份',
        elapsedSec: 0,
        error: restorePersisted.interrupted
          ? '上次恢复被系统中断'
          : (restorePersisted.error ?? '恢复失败'),
      })
    } else {
      setAutoRestoreStatus({
        phase: 'success',
        name: restorePersisted.name ?? '备份',
        elapsedSec: 0,
        ...(restorePersisted.preRestoreName ? { preRestoreName: restorePersisted.preRestoreName } : {}),
      })
    }
  }

  const openDiagnostic = () => {
    setDiagnosticText(readDiagnosticFile() ?? '')
    setDiagnosticOpen(true)
  }

  const copyDiagnostic = async () => {
    if (!diagnosticText) {
      toast.error('没有可复制的诊断内容')
      return
    }
    try {
      await navigator.clipboard.writeText(diagnosticText)
      toast.success('诊断内容已复制')
    } catch {
      toast.error('复制失败，请长按选择文本')
    }
  }

  const shareDiagnostic = async () => {
    if (!diagnosticText) {
      toast.error('没有可分享的诊断内容')
      return
    }
    const share = typeof navigator !== 'undefined' ? navigator.share : undefined
    if (!share) {
      await copyDiagnostic()
      return
    }
    try {
      await share.call(navigator, { title: '存储诊断', text: diagnosticText })
    } catch {
      // 用户取消分享忽略
    }
  }

  const exportBackup = (backup: AutoBackupEntry) => {
    void (async () => {
      setExportBackupBusy(true)
      try {
        const result = exportBackupToDownloads(backup.name)
        if (result.ok) {
          toast.success(result.path ? `已导出到下载：${result.path}` : '已导出到下载目录')
          setExportBackupOpen(false)
        } else {
          toast.error(result.error ?? '导出备份失败')
        }
      } finally {
        setExportBackupBusy(false)
      }
    })()
  }

  const handleRestoreCheckpoint = async () => {
    if (checkpointRestoreBusy) return
    if (!window.confirm('从本地检查点恢复学习进度？恢复前会自动备份当前数据。')) return
    setCheckpointRestoreBusy(true)
    setCheckpointRestoreFailed(false)
    try {
      const backup = await createPreBackup()
      if (!backup.ok) {
        setCheckpointRestoreFailed(true)
        toast.error(`预备份失败，已中止恢复：${backup.error ?? '未知错误'}`)
        return
      }
      const status = await Promise.race([
        restoreProgressCheckpointIfEmpty(),
        new Promise<StateCheckpointStatus>((resolve) =>
          window.setTimeout(() => resolve({ state: 'failed', error: '恢复超时（120 秒），可重试' }), 120_000),
        ),
      ])
      setCheckpointStatus(status)
      if (status.state === 'restored') {
        toast.success(`已恢复 ${status.restored?.states ?? 0} 条学习状态`)
        window.location.reload()
        return
      }
      if (status.state === 'failed') {
        setCheckpointRestoreFailed(true)
        toast.error(`恢复失败：${status.error ?? '未知错误'}`)
        return
      }
      toast.success('当前已有学习状态，检查点恢复仅在空库时自动执行')
    } catch (error) {
      setCheckpointRestoreFailed(true)
      toast.error(error instanceof Error ? error.message : '恢复检查点失败')
    } finally {
      setCheckpointRestoreBusy(false)
    }
  }

  const runSqliteSelfTest = async () => {
    setSqliteDiagBusy(true)
    setSqliteDiagOpen(true)
    setSqliteDiagText('自检中…')
    try {
      if (!isSqliteAvailable()) throw new Error('当前环境不支持原生 SQLite（需内部 M1 APK）')
      const health = await sqliteCall({ method: 'health', timeoutMs: 10_000 })
      const integrity = await sqliteCall({ method: 'integrity', timeoutMs: 20_000 }).catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
      const rawPlans = await getRawPlanDiagnostics().catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
      const legacyUpgrade = await getLegacyUpgradeDiagnostics().catch(() => null)
      const importStage = await getImportStageDiagnostics().catch(() => null)
      const rawSettings = await getRawSettingDiagnostics(['data.selectedDeckId', 'study.dailyGoal']).catch((error) => ({
        error: error instanceof Error ? error.message : String(error),
      }))
      const selfTest = await sqliteCall({ method: 'selfTest', timeoutMs: 20_000 }).catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
      const selfTestChecks = 'checks' in selfTest ? selfTest.checks : null
      setSqliteDiagText(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            health,
            integrity,
            rawPlans,
            rawSettings,
            legacyUpgrade,
            importStage,
            startup: getStartupTiming(),
            selfTest,
            checks: selfTestChecks,
          },
          null,
          2,
        ),
      )
    } catch (error) {
      setSqliteDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    } finally {
      setSqliteDiagBusy(false)
    }
  }

  const runMigrationDryRun = async () => {
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('迁移演练中…')
    try {
      if (!isSqliteAvailable()) throw new Error('当前环境不支持原生 SQLite（需内部 M3 APK）')
      const result = await migrateIdbToSqlite({ dryRun: true, batchSize: 200 })
      const health = await sqliteHealth().catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
      setMigrationDiagText(
        JSON.stringify(
          {
            idbCounts: result.counts,
            sqliteHealth: health,
            batches: result.batches,
            ok: result.ok,
            dryRun: result.dryRun,
            ...(result.error ? { error: result.error } : {}),
          },
          null,
          2,
        ),
      )
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const runMigrationExecute = async () => {
    if (!window.confirm('执行真实 M3 迁移？会先完整备份，再把 241 状态等合并写入 SQLite；IDB 数据保留不删除。')) return
    if (!window.confirm('再次确认：迁移期间请勿退出 App；失败会保留 IDB 并显示错误。继续？')) return
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('真实迁移中…')
    try {
      if (!isSqliteAvailable()) throw new Error('当前环境不支持原生 SQLite（需内部 M3 APK）')
      const dryRun = await migrateIdbToSqlite({ dryRun: true, batchSize: 200 })
      if (!dryRun.ok) throw new Error(dryRun.error ?? 'dryRun 不可迁移，已中止')
      const backup = await createFactsPreBackup(createAutoBackupBridge())
      if (!backup.ok) throw new Error(`轻量预备份失败，已中止迁移：${backup.error ?? '未知错误'}`)
      const epochBefore = await getDataEpoch().catch(() => null)
      const result = await Promise.race([
        migrateIdbToSqlite({
          dryRun: false,
          batchSize: 200,
          preBackup: async () => ({ ok: true }),
        }),
        new Promise<never>((_, reject) =>
          window.setTimeout(() => reject(new Error('迁移超时（60 秒），可再次点击重试')), 60_000),
        ),
      ])
      const health = await sqliteHealth().catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
      const migrationState = await sqliteQuery({ table: 'migration_state', limit: 1 }).catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
      const epochAfter = await getDataEpoch().catch(() => null)
      setMigrationDiagText(
        JSON.stringify(
          {
            dryRunCounts: dryRun.counts,
            batches: dryRun.batches,
            result,
            migrationState,
            beforeEpoch: epochBefore,
            afterEpoch: epochAfter,
            afterHealth: health,
            idbCountsStill: result.counts,
            note: 'IDB 数据保留不删除；成功请重启验证 SQLite 只读'
          },
          null,
          2,
        ),
      )
      toast.success(result.ok ? 'M3 真实迁移完成，请重启验证' : `迁移失败：${result.error ?? '未知错误'}`)
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : 'M3 迁移失败')
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const runCacheRebuildDryRun = async () => {
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('M4a cache 重建演练中…')
    try {
      if (!isSqliteAvailable()) throw new Error('当前环境不支持原生 SQLite（需内部 M4a APK）')
      const result = await rebuildIdbCacheFromSqlite({ dryRun: true, batchSize: 500 })
      const epoch = await getDataEpoch().catch(() => null)
      const health = await sqliteHealth().catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
      setMigrationDiagText(JSON.stringify({ result, epoch, health }, null, 2))
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const runCacheRebuildExecute = async () => {
    if (!window.confirm('执行 M4a cache 重建？会先完整备份，再 delta 同步并重建 IDB cache；冲突时拒绝且保留数据。')) return
    if (!window.confirm('再次确认：重建期间请勿退出 App；失败会保留 IDB/SQLite 并显示错误。继续？')) return
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('M4a cache 重建中…')
    try {
      if (!isSqliteAvailable()) throw new Error('当前环境不支持原生 SQLite（需内部 M4a APK）')
      const dryRun = await rebuildIdbCacheFromSqlite({ dryRun: true, batchSize: 500 })
      if (!dryRun.ok) throw new Error(dryRun.error ?? dryRun.conflict ?? 'dryRun 不可重建，已中止')
      const backup = await createPreBackup()
      if (!backup.ok) throw new Error(`预备份失败，已中止重建：${backup.error ?? '未知错误'}`)
      const epochBefore = await getDataEpoch().catch(() => null)
      const result = await rebuildIdbCacheFromSqlite({
        dryRun: false,
        batchSize: 500,
        preBackup: async () => ({ ok: true }),
      })
      const epochAfter = await getDataEpoch().catch(() => null)
      const health = await sqliteHealth().catch((error) => ({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      }))
      setMigrationDiagText(
        JSON.stringify(
          { dryRun, result, beforeEpoch: epochBefore, afterEpoch: epochAfter, health, note: '成功请重启验证 cache' },
          null,
          2,
        ),
      )
      toast.success(result.ok ? 'M4a cache 重建完成，请重启验证' : `重建失败：${result.error ?? result.conflict ?? '未知错误'}`)
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : 'M4a cache 重建失败')
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const runPlanRepairDryRun = async () => {
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('plan 修复演练中…')
    try {
      const result = await repairMigratedPlans({ dryRun: true })
      setMigrationDiagText(
        JSON.stringify(
          {
            ok: result.ok,
            scanned: result.scanned,
            wouldChange: result.changes.length,
            changes: result.changes,
            ...(result.error ? { error: result.error } : {}),
            note: '重启后首页应恢复 172/700 进度',
          },
          null,
          2,
        ),
      )
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const runPlanRepairExecute = async () => {
    if (!window.confirm('执行 plan 修复？会先完整备份，再修复 completed_at=0→null、idx clamp、空 wordIds；失败保留原数据。')) return
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('plan 修复中…')
    try {
      const dryRun = await repairMigratedPlans({ dryRun: true })
      if (!dryRun.ok) throw new Error(dryRun.error ?? 'dryRun 失败，已中止')
      const backup = await createPreBackup()
      if (!backup.ok) throw new Error(`预备份失败，已中止修复：${backup.error ?? '未知错误'}`)
      const result = await repairMigratedPlans({
        dryRun: false,
        preBackup: async () => ({ ok: true }),
      })
      setMigrationDiagText(
        JSON.stringify(
          {
            dryRun,
            result,
            applied: result.applied,
            changes: result.changes,
            ...(result.error ? { error: result.error } : {}),
            note: '修复成功后重启，首页应恢复 172/700；失败保留原数据',
          },
          null,
          2,
        ),
      )
      toast.success(result.ok ? `plan 修复完成（${result.applied} 个），请重启验证` : `修复失败：${result.error ?? '未知错误'}`)
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : 'plan 修复失败')
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const enableM4bSettingsWrite = async () => {
    if (!window.confirm('启用 M4b-1 settings SQLite 写？会先完整备份并校验 counts；失败保持 IDB 写。')) return
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('启用 settings SQLite 写…')
    try {
      const backup = await createPreBackup()
      if (!backup.ok) throw new Error(`预备份失败，已中止：${backup.error ?? '未知错误'}`)
      const counts = await getIdbFactCounts()
      const expectedCounts = {
        states: counts.states,
        plans: counts.plans,
        settings: counts.settings,
        reviewLogs: counts.reviewLogs,
      }
      const result = await enableSettingsSqliteWrite({
        preBackup: async () => ({ ok: true }),
        expectedCounts,
      })
      setMigrationDiagText(
        JSON.stringify(
          { counts: expectedCounts, result, mode: getSettingsWriteMode() },
          null,
          2,
        ),
      )
      setSettingsWriteInfo(await getSettingsWriteDiagnostics())
      toast.success(result.ok ? '已启用 settings SQLite 写' : `启用失败：${result.error ?? '未知错误'}`)
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : '启用 settings SQLite 写失败')
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const restoreM4bSettingsWrite = async () => {
    if (!window.confirm('恢复 settings IDB 写？会切回 IDB 写路径，不回滚已写入 SQLite 的数据。')) return
    try {
      // 持久化回退，否则重启会按 data.writeSource 恢复成 sqlite
      await persistSettingsWriteMode('idb')
      setSettingsWriteInfo(await getSettingsWriteDiagnostics())
      setMigrationDiagText(JSON.stringify({ mode: getSettingsWriteMode(), note: '已恢复 IDB 写（持久化）' }, null, 2))
      setMigrationDiagOpen(true)
      toast.success('已恢复 settings IDB 写')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复 IDB 写失败')
    }
  }

  const runPlanReconcileDryRun = async () => {
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('M4b2 plan 对齐演练中…')
    try {
      const result = await reconcileTodayPlanToSqlite({ dryRun: true })
      const epoch = await getDataEpoch().catch(() => null)
      setMigrationDiagText(JSON.stringify({ result, epoch }, null, 2))
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const runPlanReconcileExecute = async () => {
    if (!window.confirm('执行 M4b2 plan 对齐？会把 IDB 当前今日 plan 写入 SQLite；会先完整备份，失败保留数据。')) return
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('M4b2 plan 对齐中…')
    try {
      const dryRun = await reconcileTodayPlanToSqlite({ dryRun: true })
      if (!dryRun.ok) throw new Error(dryRun.error ?? 'dryRun 失败，已中止')
      const backup = await createPreBackup()
      if (!backup.ok) throw new Error(`预备份失败，已中止对齐：${backup.error ?? '未知错误'}`)
      const epochBefore = await getDataEpoch().catch(() => null)
      const result = await reconcileTodayPlanToSqlite({
        dryRun: false,
        preBackup: async () => ({ ok: true }),
      })
      const after = await reconcileTodayPlanToSqlite({ dryRun: true }).catch(() => null)
      const epochAfter = await getDataEpoch().catch(() => null)
      setMigrationDiagText(
        JSON.stringify(
          { before: dryRun, result, after, epochBefore, epochAfter, note: 'SQLite plan 应与 IDB 一致（172 词），首页应 172/0' },
          null,
          2,
        ),
      )
      toast.success(result.ok ? 'M4b2 plan 对齐完成，请重启验证' : `对齐失败：${result.error ?? '未知错误'}`)
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : 'M4b2 plan 对齐失败')
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const enableLearningWrite = async () => {
    if (!window.confirm('启用学习 SQLite 写（M4b-2）？会先完整备份并校验当前 plan 与 SQLite 一致。')) return
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('启用学习 SQLite 写…')
    try {
      const backup = await createPreBackup()
      if (!backup.ok) throw new Error(`预备份失败，已中止：${backup.error ?? '未知错误'}`)
      let planWordIdsLength: number | undefined
      try {
        const plan = await getTodayPlan({
          deckId: currentDeckId,
          dailyGoal: settings?.['study.dailyGoal'] ?? 20,
        })
        planWordIdsLength = plan.wordIds.length
      } catch {
        planWordIdsLength = undefined
      }
      const result = await enableLearningSqliteWrite({
        preBackup: async () => ({ ok: true }),
        ...(planWordIdsLength != null ? { expectedPlanWordIds: planWordIdsLength } : {}),
      })
      setLearningWriteSource(getLearningWriteSource())
      setMigrationDiagText(
        JSON.stringify(
          { planWordIdsLength, result, learningWriteSource: getLearningWriteSource() },
          null,
          2,
        ),
      )
      toast.success(result.ok ? '已启用学习 SQLite 写' : `启用失败：${result.error ?? '未知错误'}`)
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : '启用学习 SQLite 写失败')
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const revertLearningWrite = async () => {
    if (!window.confirm('回退学习写源到 IDB？会先按 SQLite 完整重建 IDB cache 并校验一致，失败则拒绝回退。')) return
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    setMigrationDiagText('回退学习写源…')
    try {
      const backup = await createPreBackup()
      if (!backup.ok) throw new Error(`预备份失败，已中止：${backup.error ?? '未知错误'}`)
      const result = await revertLearningWriteSourceToIdb({ preBackup: async () => ({ ok: true }) })
      setLearningWriteSource(getLearningWriteSource())
      setMigrationDiagText(JSON.stringify({ result, learningWriteSource: getLearningWriteSource() }, null, 2))
      toast.success(result.ok ? '已回退学习写源到 IDB' : `回退失败：${result.error ?? '未知错误'}`)
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : '回退学习写源失败')
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const sqliteCheckpointHint = sqliteCheckpointStatus?.available
    ? `SQLite 检查点 ${sqliteCheckpointStatus.latestAt ? new Date(sqliteCheckpointStatus.latestAt).toLocaleString() : ''}（${sqliteCheckpointStatus.counts?.states ?? 0} 状态 / ${sqliteCheckpointStatus.counts?.plans ?? 0} 计划）`
    : sqliteCheckpointStatus?.error
      ? `SQLite 检查点：${sqliteCheckpointStatus.error}`
      : 'SQLite 检查点读取中…'

  const generateRollbackPackage = async () => {
    if (!window.confirm('生成 0.10 回退包？会先按 SQLite 重建 IDB 回退缓存（完整备份并校验 counts），再导出 JSON。')) return
    setRollbackBusy(true)
    setRollbackOpen(true)
    setRollbackInfo(null)
    try {
      const backup = await createPreBackup()
      if (!backup.ok) throw new Error(`预备份失败，已中止：${backup.error ?? '未知错误'}`)
      const built = await buildIdbRollbackCache({
        preBackup: async () => ({ ok: true }),
        appVersion: APP_VERSION,
      })
      if (!built.ok || !built.manifest) throw new Error(built.error ?? 'IDB 回退缓存构建失败')
      const text = await buildRollbackMigrationText()
      const saved = await saveBlobFile(
        new Blob([text], { type: 'application/json' }),
        datedFileName('0.10回退包', 'momo-0.10-rollback.json'),
        'application/json',
      )
      const info = saveResultMessage(saved)
      if (!info.ok) throw new Error(info.message)
      const delta = await detectIdbDeltaSinceSqlite().catch(() => undefined)
      setRollbackInfo({
        counts: built.manifest.counts,
        version: built.manifest.appVersion,
        epoch: built.manifest.dataEpoch,
        ...(delta ? { delta } : {}),
        file: info.message,
      })
      toast.success(`0.10 回退包已生成：${info.message}`)
    } catch (error) {
      setRollbackInfo({ error: error instanceof Error ? error.message : String(error) })
      toast.error(error instanceof Error ? error.message : '生成回退包失败')
    } finally {
      setRollbackBusy(false)
    }
  }

  const repairWriteSource = async () => {
    if (!window.confirm('修复学习写源？会校验 SQLite schema/integrity 并重建 cache，必要时从最近 SQLite 备份恢复写源。')) return
    setMigrationDiagBusy(true)
    setMigrationDiagOpen(true)
    const before = getLearningWriteSource()
    setMigrationDiagText('修复学习写源中…')
    try {
      const result = await repairLearningWriteSource()
      const after = getLearningWriteSource()
      setLearningWriteSource(after)
      setMigrationDiagText(JSON.stringify({ before, after, result }, null, 2))
      if (result.ok) toast.success('学习写源已修复')
      else toast.error(`修复失败：${result.error ?? '未知错误'}`)
    } catch (error) {
      setMigrationDiagText(JSON.stringify({ before, failed: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : '修复学习写源失败')
    } finally {
      setMigrationDiagBusy(false)
    }
  }

  const checkpointHint = checkpointStatus
    ? checkpointStatus.state === 'saved'
      ? `检查点已保存${checkpointStatus.at ? ` · ${new Date(checkpointStatus.at).toLocaleString()}` : ''}（${checkpointStatus.counts?.states ?? 0} 状态 / ${checkpointStatus.counts?.plans ?? 0} 计划）`
      : checkpointStatus.state === 'restored'
        ? `已从检查点恢复 ${checkpointStatus.restored?.states ?? 0} 状态 / ${checkpointStatus.restored?.plans ?? 0} 计划`
        : checkpointStatus.state === 'failed'
          ? `检查点保存失败：${checkpointStatus.error ?? '未知错误'}`
          : '暂无检查点'
    : '正在读取检查点状态…'

  const generatedRootHint = generatedStatus
    ? (() => {
        const state = generatedStatus.rootEtymologyState
        if (!state) return generatedStatus.supported ? '；词根缀源状态读取中…' : ''
        const count = generatedStatus.rootEtymologyImported ?? 0
        const total = generatedStatus.rootEtymologyTotal
        const version = generatedStatus.rootEtymologyVersion
        const countText = total != null && total > 0 ? `${count}/${total} 条` : `${count} 条`
        if (state === 'failed') return `；词根缀源失败：${generatedStatus.rootEtymologyError ?? '未知错误'}（下次重试）`
        if (state === 'running') return `；词根缀源导入中 ${countText}`
        return `；词根缀源 ${countText}${version ? ` · v${version}` : ''}`
      })()
    : ''

  const generatedHint =
    generatedStatus == null
      ? '读取中…'
      : !generatedStatus.supported
        ? '浏览器版不含预装数据'
        : generatedStatus.state === 'running'
          ? `导入中 ${Math.round(((generatedStatus.done || 0) / Math.max(1, generatedStatus.total || 0)) * 100)}%（可继续使用）${generatedRootHint}`
          : generatedStatus.state === 'completed'
            ? `已完成：本义助记 ${generatedStatus.senseImported ?? 0} 条 / 引申图 ${generatedStatus.derivationImported ?? 0} 词${generatedRootHint}${generatedStatus.completedAt ? ` · ${new Date(generatedStatus.completedAt).toLocaleString()}` : ''}`
            : generatedStatus.state === 'failed'
              ? `导入失败：${generatedStatus.error ?? '未知错误'}（下次启动重试）${generatedRootHint}`
              : generatedStatus.state === 'skipped-existing'
                ? `已存在内容，跳过导入${generatedRootHint}`
                : `未开始（启动后自动导入）${generatedRootHint}`

  return (
    <PageShell title="我的" hero>
      <SearchFilterBar placeholder="搜索我的设置" />
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div className="mm-avatar">
            <OwlIcon size={40} />
          </div>
          <div style={{ flex: '1 1 auto', minWidth: 0 }}>
            <div className="mm-row-title">学习者</div>
            <div className="mm-row-sub">
              词汇量 {overview?.totalLearned ?? 0} · 连续打卡 {overview?.streakDays ?? 0} 天
            </div>
          </div>
          <button
            type="button"
            className={`mm-switch${darkMode ? ' is-on' : ''}`}
            role="switch"
            aria-checked={darkMode}
            aria-label="深色模式"
            onClick={() => setMode(darkMode ? 'light' : 'dark')}
          >
            <span className="mm-switch-knob" />
          </button>
        </div>
      </Card>

      <SectionBand title="学习数据" />
      <div className="mm-list">
        <SettingRow
          label="学习统计"
          hint="连续打卡 / 学习量 / 不熟悉度"
          chevron
          onClick={() => navigate('/stats')}
        />
        <SettingRow
          label="今日概览"
          hint={`今日已学 ${overview?.todayReviewed ?? 0} 个 · 累计 ${overview?.totalLearned ?? 0} 个`}
          chevron
          onClick={() => navigate('/')}
        />
      </div>

      <SectionBand title="使用说明" />
      <Card>
        <details>
          <summary className="mm-row-title" style={{ cursor: 'pointer' }}>
            怎么练：推荐主流程（点开展开）
          </summary>
          <div className="mm-caption" style={{ lineHeight: 1.8, paddingTop: 8 }}>
            <p style={{ margin: '0 0 8px' }}>
              <strong>记忆 → 回忆 → 标记不认识的 → 加权记忆 → 回忆 → 标记不认识的 → 加权记忆 …</strong>
              循环，直到所有（主要）含义映射都能回忆起来。
            </p>
            <p
              className="mm-caption usage-guide-note"
              style={{
                display: 'block',
                margin: '0 0 8px',
                whiteSpace: 'normal',
                overflow: 'visible',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
                WebkitLineClamp: 'unset',
                lineHeight: 1.7,
              }}
            >
              每次回忆时，建议从尽可能单个、最共性的本义出发，再按使用场景、作用对象、词性逐个引申出各个实际含义。记忆时同理：先找最共性的、底层的、尽可能统一的「生成元」（本义），再按场景/作用对象/词性引申得到各实际含义。
            </p>
            <p
              className="mm-caption usage-guide-note"
              style={{
                display: 'block', margin: '0 0 8px', whiteSpace: 'normal', overflow: 'visible',
                overflowWrap: 'anywhere', wordBreak: 'break-word', WebkitLineClamp: 'unset', lineHeight: 1.7,
              }}
            >
              平时，如果生成元忘记了，我们也可以通过先根据相关记忆、它的已知道的一些含义来回忆起其生成元，进而再通过生成元来引申、回忆其它各实际含义。
            </p>
            <p
              className="mm-caption usage-guide-note"
              style={{
                display: 'block', margin: '0 0 8px', whiteSpace: 'normal', overflow: 'visible',
                overflowWrap: 'anywhere', wordBreak: 'break-word', WebkitLineClamp: 'unset', lineHeight: 1.7,
              }}
            >
              推荐工作流：记忆单词到生成元的映射 → 理解生成元如何引申各个实际含义 → 代入生成元到各个含义的例句，看看是否可以理解各个含义的例句中该生成元的真实指代，找出那些不容易理解出真实指代的含义（记为 nc） → 记忆「通过生成元来得到各个实际含义（可只考虑那些 nc）」的关系网络（或者说使得可以仅通过生成元回忆起那些含义/nc）。
            </p>

            <p style={{ margin: '0 0 8px' }}><strong>词根词缀法记忆流程：</strong></p>
            <ol style={{ margin: '0 0 8px', paddingLeft: 20, listStyle: 'decimal outside' }}>
              <li style={{ margin: '0 0 6px' }}>
                记忆 <strong>“词根缀源 → 词根缀源的含义”</strong>，及整体拼接后的含义/意象。
              </li>
              <li style={{ margin: '0 0 6px' }}>
                在“加权记忆”模块里，用 词根缀源 理解、联系、<strong>推导</strong> 出 <strong>各个含义/本义</strong>（一些难导出的可试图构造逻辑，实在不行则直接接纳式地记忆）。
                <details className="usage-guide-note">
                  <summary>具体而言</summary>
                  具体而言，可根据实际场景、词性、作用对象等推出、联系或理解 “词根缀源 → 各实际含义”，从而实现记忆。
                </details>
              </li>
              <li style={{ margin: '0 0 6px' }}>
                之后白板页复习也是根据 词根缀源 来推导、回忆含义/本义，通过 “加权记忆”模块来针对未能想到的映射或含义/本义针对性记忆、加强巩固。
              </li>
            </ol>
            <p className="mm-caption usage-guide-note" style={{ margin: '0 0 8px' }}>
              <strong>总而言之</strong>，本质原理就是建立记忆映射/实现映射的算法，从而转化为记忆这类算法。这样的好处是不易忘，“词 → 词根缀源” 是可以直接根据词本身构成得到的，于是通过 “词根缀源” 作为联想点/过渡来联想、推导得到 词义/本义 或确定 词义/本义的大方向 ，这样基本上不用刻意记或很容易记忆。
            </p>
            <p className="mm-caption usage-guide-note" style={{ margin: '0 0 8px' }}>
              另一个好处是，即使忘记了词根词缀词源的含义，也可以尝试通过其它具有该词根词缀词源的单词来找共性、快速回忆起该词根词缀词源的含义。
            </p>
            <p
              className="mm-caption usage-guide-note"
              style={{
                display: 'block',
                margin: '0 0 8px',
                whiteSpace: 'normal',
                overflow: 'visible',
                overflowWrap: 'anywhere',
                wordBreak: 'break-word',
                WebkitLineClamp: 'unset',
                lineHeight: 1.7,
              }}
            >
              注意：实际安排单词时建议使用字典序，这样可以一次性连续记忆同一或相近词根、词源的词，利于记忆、加深对词根印象。
            </p>
            <p style={{ margin: '0 0 4px' }}>· 白板面：只看单词/词性/英文例句，先回忆中文含义。</p>
            <p style={{ margin: '0 0 4px' }}>· 注释面：看中文含义/例句/助记；点「记忆」练「单词→含义」，「加权记忆」对不熟悉的含义多练。</p>
            <p style={{ margin: '0 0 4px' }}>· 三键：认识 / 模糊 / 不认识；模糊/不认识会当天回炉。</p>
            <p style={{ margin: '0 0 4px' }}>· 今日单词：查看今天复习/新学分别学了哪些。</p>
            <p style={{ margin: '0 0 4px' }}>· 统计：看累计学习量、评分分布与不熟悉度最高的含义。</p>
            <p style={{ margin: 0 }}>· 设置：调学习量、记忆次数、加权记忆、新词顺序、字号/主题等。</p>
          </div>
        </details>
      </Card>

      <SectionBand title="原理" />
      <Card>
        <details>
          <summary className="mm-row-title" style={{ cursor: 'pointer' }}>
            原理（点开展开）
          </summary>
          <div className="mm-caption" style={{ lineHeight: 1.8, paddingTop: 8 }}>
            <p style={{ margin: '0 0 6px' }}>原理：</p>
            <ul
              className="principle-list"
              style={{ margin: '0 0 6px', paddingLeft: 20, listStyle: 'disc outside' }}
            >
              <li style={{ margin: '0 0 4px' }}>
                大多或很多情形下，通过把核心义/词源代入实际语境或例句中就可以自然地理解出它的具体指代含义。
              </li>
              <li style={{ margin: '0 0 4px' }}>
                可以很容易地通过核心义/词源来引申得到其各种实际含义。
              </li>
            </ul>
            <p style={{ margin: 0 }}>
              所以，一般只需记忆这个核心义/词源即可。而且，由于这个核心义/词源是各实际含义的共性，因此当忘记时也很容易通过所记住的几个实际含义来回忆起这个核心义/词源。
            </p>
          </div>
        </details>
      </Card>

      <SectionBand title="数据" />
      <div className="mm-list">
        <SettingRow
          label="立即保存进度"
          hint={checkpointHint}
          chevron
          onClick={() => {
            void Promise.all([flushProgressCheckpoint(), flushSqliteFactsCheckpointAuto()])
              .then(async ([status]) => {
                setCheckpointStatus(status)
                if (status.state === 'saved') toast.success('已保存进度检查点')
                else toast.error(`保存失败：${status.error ?? '未知错误'}，可再次点击重试`)
              })
              .catch(() => toast.error('保存进度失败，可再次点击重试'))
          }}
        />
        <SettingRow
          label="从检查点恢复"
          hint={
            checkpointRestoreBusy
              ? '恢复中…（最多 120 秒）'
              : checkpointRestoreFailed
                ? '上次恢复失败，可再次点击重试'
                : '仅空库自动恢复（合并检查点）；恢复前会强制备份现有数据'
          }
          value={checkpointRestoreBusy ? '恢复中…' : checkpointRestoreFailed ? '重试' : undefined}
          chevron={!checkpointRestoreBusy}
          onClick={() => {
            if (!checkpointRestoreBusy) void handleRestoreCheckpoint()
          }}
        />
        <SettingRow
          label="预装内容"
          hint={generatedHint}
          value={
            generatedStatus?.supported && generatedStatus.state !== 'running' && generatedStatus.state !== 'completed'
              ? generatedImporting
                ? '导入中…'
                : '立即导入'
              : undefined
          }
          chevron={
            generatedStatus?.supported === true &&
            generatedStatus.state !== 'running' &&
            generatedStatus.state !== 'completed'
          }
          onClick={() => {
            if (
              generatedStatus?.supported &&
              generatedStatus.state !== 'running' &&
              generatedStatus.state !== 'completed' &&
              !generatedImporting
            ) {
              void importGeneratedNow()
            }
          }}
        />
        {restorePersisted && restorePersisted.status !== 'idle' ? (
          <SettingRow
            label="最近恢复"
            hint={
              restorePersisted.status === 'running'
                ? `恢复中：${restorePhaseLabel(restorePersisted.phase)}${restorePersisted.name ? ` · ${restorePersisted.name}` : ''}`
                : restorePersisted.status === 'completed'
                  ? `恢复完成${restorePersisted.finishedAt ? ` · ${new Date(restorePersisted.finishedAt).toLocaleString()}` : ''}`
                  : `${restorePersisted.interrupted ? '恢复被中断' : '恢复失败'}${restorePersisted.error ? `：${restorePersisted.error}` : ''}`
            }
            chevron
            onClick={openRestoreStatus}
          />
        ) : null}
        {false ? (
          <>
        <SettingRow
          label="自动备份"
          hint={
            autoBackupAvailable
              ? `旧 JSON 自动备份（legacy）：存 App 内部（清 WebView 数据不丢）；最近 ${autoBackups[0] ? new Date(autoBackups[0]!.mtime).toLocaleString() : '暂无'} · ${autoBackups.length} 份（gzip，保留 7 份且 ≤100MB），不会静默删除，可导出到下载`
              : '自动备份存 App 内部（清 WebView 数据不丢），浏览器版请手动导出'
          }
          value={autoBackupAvailable && autoBackups.length > 0 ? `${autoBackups.length} 份（legacy）` : undefined}
        />
        <SettingRow
          label="自动备份（每次启动）"
          hint="每次启动学习时自动备份到本机内部存储（清除 WebView 数据也不会丢；同日覆盖，保留最近 7 份）"
          control={
            autoBackupAvailable ? (
              <Switch
                label="自动备份（每次启动）"
                checked={settings?.['data.autoBackupEnabled'] !== false}
                onChange={(checked) => void patch({ 'data.autoBackupEnabled': checked })}
              />
            ) : (
              <span className="mm-caption">不可用</span>
            )
          }
        />
        <SettingRow
          label="立即备份"
          hint={
            autoBackupAvailable
              ? autoBusy
                ? `正在备份：${autoRunLabel ?? '处理中…'}（首次导出 26MB 可能较慢，请稍候）`
                : '手动创建一份自动备份'
              : '当前环境不支持，请手动导出'
          }
          value={autoBusy ? autoRunLabel ?? '备份中…' : undefined}
          chevron={autoBackupAvailable}
          onClick={() => {
            if (autoBackupAvailable && !autoBusy) void handleAutoBackupNow()
          }}
        />
        <SettingRow
          label="从自动备份恢复"
          hint={
            autoBackupAvailable
              ? autoBackups.length > 0
                ? '恢复前会先备份当前数据；合并、不清空'
                : '暂无自动备份'
              : '浏览器版请手动导入'
          }
          chevron={autoBackupAvailable && autoBackups.length > 0}
          onClick={() => {
            if (autoBackupAvailable && autoBackups.length > 0) setAutoRestoreOpen(true)
          }}
        />
        <SettingRow
          label="导出备份到下载"
          hint={autoBackupAvailable ? '把内部备份解压后导出到 Download 目录' : '当前环境不支持，请手动导出'}
          chevron={autoBackupAvailable && autoBackups.length > 0}
          onClick={() => {
            if (autoBackupAvailable && autoBackups.length > 0) setExportBackupOpen(true)
          }}
        />
        <SettingRow
          label="导出安全诊断包"
          hint="导出 JSON（epoch/计数/检查点/备份/最近删除日志/storage）到 Download/DSH-Go"
          chevron
          onClick={() => {
            void buildSafetyDiagnosticsText()
              .then((text) =>
                saveBlobFile(
                  new Blob([text], { type: 'application/json' }),
                  datedFileName('数据安全诊断', 'data-safety-diagnostics.json'),
                  'application/json',
                ),
              )
              .then((result) => {
                const info = saveResultMessage(result)
                if (info.ok) toast.success(`诊断包已导出：${info.message}`)
                else toast.error(info.message)
              })
              .catch(() => toast.error('导出诊断包失败'))
          }}
        />
        <SettingRow
          label="调试"
          hint="SQLite/迁移/写源/诊断等内部工具（默认隐藏）"
          chevron
          onClick={() => navigate('/me/debug')}
        />
          </>
        ) : null}
        {false ? (
          <>
        <SettingRow
          label="SQLite M3 迁移演练（dryRun）"
          hint="仅演练：显示 IDB/SQLite counts、批次数、是否可迁移与错误；不写 SQLite"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void runMigrationDryRun()
          }}
        />
        <SettingRow
          label="执行 M3 真实迁移"
          hint="危险：二次确认 + 完整备份后把 IDB 状态合并写入 SQLite；IDB 保留；失败中止"
          value="执行"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void runMigrationExecute()
          }}
        />
        <SettingRow
          label="M4a cache 重建演练（dryRun）"
          hint="仅演练：显示 IDB/SQLite counts、delta、冲突、可重建、generation/epoch"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void runCacheRebuildDryRun()
          }}
        />
        <SettingRow
          label="执行 M4a 重建"
          hint="危险：二次确认 + 完整备份后 delta 同步并重建 IDB cache；冲突/失败保留数据"
          value="执行"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void runCacheRebuildExecute()
          }}
        />
        <SettingRow
          label="M4a plan 修复演练（dryRun）"
          hint="显示将修复的 plan 数、completed_at 0→null、idx clamp、空 wordIds"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void runPlanRepairDryRun()
          }}
        />
        <SettingRow
          label="执行 plan 修复"
          hint="危险：完整备份后修复迁移 plan；成功重启应恢复 172/700，失败保留原数据"
          value="执行"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void runPlanRepairExecute()
          }}
        />
        <SettingRow
          label="启用 M4b-1 settings SQLite 写"
          hint={`当前写源 ${settingsWriteInfo.mode}；备份+counts 门禁通过后切 SQLite，失败保持 IDB`}
          value="启用"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void enableM4bSettingsWrite()
          }}
        />
        <SettingRow
          label="恢复 settings IDB 写"
          hint={settingsWriteInfo.diag ? `当前 ${settingsWriteInfo.mode}，最近 diag：${JSON.stringify(settingsWriteInfo.diag)}` : `当前 ${settingsWriteInfo.mode}；回退 IDB 并持久化（不回滚 SQLite 数据）`}
          chevron
          onClick={() => void restoreM4bSettingsWrite()}
        />
        <SettingRow
          label="M4b2 plan 对齐演练（dryRun）"
          hint="显示 IDB/SQLite plan 长度、index、completedAt、changed、将写内容"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void runPlanReconcileDryRun()
          }}
        />
        <SettingRow
          label="执行 M4b2 plan 对齐"
          hint="危险：完整备份后把 IDB 今日 plan 写入 SQLite；成功后首页应 172/0"
          value="执行"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void runPlanReconcileExecute()
          }}
        />
        <SettingRow
          label="启用学习 SQLite 写（M4b-2）"
          hint={
            learningWriteSource === 'readonly'
              ? '当前学习写源 readOnly：请先到诊断/恢复处理异常，不要反复重试写操作'
              : `当前学习写源 ${learningWriteSource}；备份+plan 一致性门禁后切换 SQLite`
          }
          value={learningWriteSource === 'readonly' ? '只读' : undefined}
          chevron={learningWriteSource !== 'readonly'}
          onClick={() => {
            if (learningWriteSource !== 'readonly' && !migrationDiagBusy) void enableLearningWrite()
          }}
        />
        <SettingRow
          label="回退学习写源到 IDB"
          hint="先按 SQLite 完整重建 cache 并校验，再确认回退；失败拒绝，不静默切写源"
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void revertLearningWrite()
          }}
        />
        <SettingRow
          label="SQLite facts 备份"
          hint={
            sqliteManifest
              ? `仅进度 facts，不含词库/内容包/引申图；states ${sqliteManifest?.counts.states ?? 0} / plans ${sqliteManifest?.counts.plans ?? 0} / settings ${sqliteManifest?.counts.settings ?? 0} · epoch ${sqliteManifest?.dataEpoch ?? 0} · v${sqliteManifest?.userVersion ?? 0} · ${new Date(sqliteManifest?.createdAt ?? Date.now()).toLocaleString()} · ${((sqliteManifest?.bytes ?? 0) / 1024 / 1024).toFixed(1)}MB · ${sqliteManifest?.checksum ? `sum ${sqliteManifest?.checksum?.slice(0, 8)}…` : '无 checksum'}`
              : '只备份进度 facts；内容请手动完整导出。尚未读取 SQLite facts manifest'
          }
          value={sqliteBackupBusy ? '备份中…' : '立即备份'}
          chevron={!sqliteBackupBusy}
          onClick={() => {
            if (sqliteBackupBusy) return
            setSqliteBackupBusy(true)
            void createSqliteFactsBackup()
              .then(async (result) => {
                if (!result.ok) {
                  toast.error(`SQLite 备份失败：${result.error ?? '未知错误'}`)
                  return
                }
                toast.success(`SQLite facts 备份完成：${result.manifest?.name ?? ''}`)
                setSqliteManifest(await getSqliteFactsManifest())
              })
              .catch(() => toast.error('SQLite 备份失败'))
              .finally(() => setSqliteBackupBusy(false))
          }}
        />
        <SettingRow
          label="SQLite facts 恢复"
          hint={`SQLite facts 备份 ${sqliteBackups.length} 份（保留 7 份）· 旧 JSON 备份仍独立保留；${sqliteCheckpointHint}`}
          value={sqliteBackups.length > 0 ? `${sqliteBackups.length} 份（保留 7）` : undefined}
          chevron
          onClick={() => setSqliteRestoreOpen(true)}
        />
        <SettingRow
          label="生成 0.10 回退包"
          hint="SQLite→IDB 回退缓存门禁 + 完整备份后导出 0.10 可导入 JSON"
          value={rollbackBusy ? '生成中…' : undefined}
          chevron={!rollbackBusy}
          onClick={() => {
            if (!rollbackBusy) void generateRollbackPackage()
          }}
        />
        <SettingRow
          label="修复学习写源"
          hint={
            learningWriteSource === 'readonly'
              ? '当前只读：校验 SQLite schema/integrity+重建 cache，失败真实提示'
              : `当前写源 ${learningWriteSource}；仅在异常/只读后使用，会校验并修复`
          }
          value={learningWriteSource === 'readonly' ? '修复' : undefined}
          chevron
          onClick={() => {
            if (!migrationDiagBusy) void repairWriteSource()
          }}
        />
        <SettingRow
          label="SQLite M1 自检"
          hint="仅调试：调用原生 sqliteCall health/integrity，显示 JSON 并支持复制/导出"
          chevron
          onClick={() => {
            if (!sqliteDiagBusy) void runSqliteSelfTest()
          }}
        />
        <SettingRow
          label="存储诊断"
          hint="读取内部 diag-storage.json，可复制/分享给开发者"
          chevron={autoBackupAvailable}
          onClick={() => {
            if (autoBackupAvailable) openDiagnostic()
          }}
        />
        <SettingRow
          label="持久化存储"
          hint={
            persistState === 'unsupported'
              ? '当前浏览器不支持持久化'
              : persistState === 'granted'
                ? '已持久化，降低被系统清理风险；低存储仍可能清数据'
                : persistState === 'failed'
                  ? '持久化申请失败（不影响备份）'
                  : '可申请持久化，避免存储被系统清理'
          }
          value={persistState === 'prompt' ? '申请' : undefined}
          chevron={persistState === 'prompt'}
          onClick={() => {
            if (persistState === 'prompt') requestPersist()
          }}
        />
          </>
        ) : null}
        {false ? (
          <>
        <SettingRow label="词库管理" hint="新建 / 导入 / 导出 / 从墨墨导入" chevron onClick={() => navigate('/decks')} />
        <SettingRow
          label="从墨墨导入学习进度"
          hint="APK 内置直连；浏览器/PWA 需本机代理（详见弹层说明）"
          chevron
          onClick={() => navigate('/decks?maimemo=1')}
        />
          </>
        ) : null}
        <SettingRow
          label="导入与导出"
          hint="学习进度、完整备份、自动备份、内容包导入导出"
          chevron
          onClick={() => navigate('/me/import-export')}
        />
        <SettingRow
          label="迁移与修复"
          hint="SQLite 迁移/修复/备份/回退与调试工具"
          chevron
          onClick={() => navigate('/me/debug')}
        />
        {false ? (
          <>
        <SettingRow
          label="导出学习进度"
          hint="学习进度备份（不含引申图/内容包）；引申图/内容包可分别用对应导出"
          value={exporting ? '导出中…' : undefined}
          chevron
          onClick={() => void handleExportMigration(false)}
        />
        <SettingRow
          label="完整备份（含引申图/内容包，体积大）"
          hint="点击后确认；体积可能很大、导出较慢，建议存储充足时使用"
          value={exporting ? '导出中…' : undefined}
          chevron
          onClick={() => setConfirmCompleteExport(true)}
        />
        <SettingRow
          label="导入学习进度"
          hint={importing ? '正在导入…' : '兼容轻量/完整包；轻量包不会清空本机引申图/内容包'}
          chevron
          onClick={() => void handlePickMigrationImport()}
        />
        <SettingRow
          label="AI 生成任务"
          hint="查看/重命名/删除/续跑批量生成任务（例句/助记/词源/不常考等）"
          chevron
          onClick={() => navigate('/me/jobs')}
        />
        <SettingRow
          label="导出词根缀源"
          hint="导出全部/当前词库的词根词缀词源与检查状态 JSON"
          chevron
          onClick={() => setRootExportOpen(true)}
        />
        <SettingRow
          label="导入词根缀源"
          hint={rootImportBusy ? '导入中…' : '选择 JSON，手改优先；缺词跳过；显示合并报告'}
          chevron
          onClick={() => {
            if (!rootImportBusy) void handleRootImport()
          }}
        />
        <SettingRow
          label="导出本义助记"
          hint="单独导出全部/当前词库的本义助记 JSON（含待生成候选，便于外部批量生成）"
          value={coreExportBusy ? '导出中…' : undefined}
          chevron
          onClick={openCoreExport}
        />
        <SettingRow
          label="导入本义助记"
          hint="导入 JSON：先预览校验，默认合并不覆盖手改；覆盖需确认"
          value={coreImportPhase ?? (coreImportBusy ? '导入中…' : undefined)}
          chevron
          onClick={() => {
            if (!coreImportBusy) void handlePickCoreMnemonicImport()
          }}
        />
        <SettingRow
          label="导出全部引申图"
          hint="当前所有已保存的生成元→含义引申图（bundle v1）"
          value={bundleExporting ? '导出中…' : undefined}
          chevron
          onClick={() => void handleExportDerivationBundle()}
        />
        <SettingRow
          label="导入引申图"
          hint={bundleImporting ? '正在导入…' : '默认 merge；缺失词跳过，不覆盖 nc/用户内容/进度'}
          chevron
          onClick={() => void handlePickDerivationBundleImport()}
        />
          </>
        ) : null}
        <SettingRow
          label="批量生成引申图"
          hint="词库/今日要学选词；排除已生成；并发/进度/停止/失败重试（上限 200）"
          chevron
          onClick={() => setBatchOpen(true)}
        />
      </div>

      <Dialog
        open={exportBackupOpen}
        title="导出备份到下载"
        onClose={() => {
          if (!exportBackupBusy) setExportBackupOpen(false)
        }}
        dismissable={!exportBackupBusy}
        actions={
          <button type="button" className="mm-btn" disabled={exportBackupBusy} onClick={() => setExportBackupOpen(false)}>
            关闭
          </button>
        }
      >
        <div className="core-io-dialog">
          <div className="mm-caption">自动备份存 App 内部（清 WebView 数据不丢）；导出会解压并写入 Download 目录。</div>
          {autoBackups.map((backup) => (
            <div className="mm-row" key={`export-${backup.name}`}>
              <span className="mm-row-main">
                <span className="mm-row-title">{new Date(backup.mtime).toLocaleString()}</span>
                <span className="mm-row-sub">
                  {backup.size >= 1024 * 1024 ? `${(backup.size / 1024 / 1024).toFixed(1)} MB` : `${(backup.size / 1024).toFixed(0)} KB`}
                </span>
              </span>
              <button
                type="button"
                className="mm-btn mm-btn--sm"
                disabled={exportBackupBusy}
                onClick={() => exportBackup(backup)}
              >
                导出到下载
              </button>
            </div>
          ))}
        </div>
      </Dialog>

      <Dialog
        open={diagnosticOpen}
        title="存储诊断"
        overlayClassName="mm-mask--storage-diagnostic"
        onClose={() => setDiagnosticOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setDiagnosticOpen(false)}>
              关闭
            </button>
            <button type="button" className="mm-btn" onClick={() => void copyDiagnostic()}>
              复制
            </button>
            <button type="button" className="mm-btn mm-btn--primary" onClick={() => void shareDiagnostic()}>
              分享
            </button>
          </>
        }
      >
        {diagnosticText ? (
          <pre className="storage-diagnostic-text">{diagnosticText}</pre>
        ) : (
          <div className="mm-caption">当前环境不支持读取内部诊断，或诊断文件尚未生成。</div>
        )}
      </Dialog>

      <Dialog
        open={autoRestoreOpen}
        title="从自动备份恢复"
        onClose={() => {
          if (!autoRestoreBusy) setAutoRestoreOpen(false)
        }}
        dismissable={!autoRestoreBusy}
        actions={
          <button
            type="button"
            className="mm-btn"
            disabled={autoRestoreBusy}
            onClick={() => setAutoRestoreOpen(false)}
          >
            关闭
          </button>
        }
      >
        <div className="core-io-dialog">
          <div className="mm-caption">旧 JSON 备份包（兼容显示，标注旧）；选择一份恢复，恢复前会自动备份当前数据，采用合并且不清空现有数据。</div>
          {autoRestoreListLoading ? <div className="mm-caption">正在校验备份完整性…</div> : null}
          {!autoRestoreListLoading && autoRestoreList != null && autoRestoreList.length === 0 ? (
            <div className="mm-caption">没有通过完整性校验的备份（0KB/坏包已隐藏）。</div>
          ) : null}
          {(autoRestoreList ?? []).map((backup) => (
            <div className="mm-row" key={backup.name}>
              <span className="mm-row-main">
                <span className="mm-row-title">{new Date(backup.mtime).toLocaleString()}</span>
                <span className="mm-row-sub">{backup.size >= 1024 * 1024 ? `${(backup.size / 1024 / 1024).toFixed(1)} MB` : `${(backup.size / 1024).toFixed(0)} KB`}</span>
              </span>
              <button
                type="button"
                className="mm-btn mm-btn--sm"
                disabled={autoRestoreBusy}
                onClick={() => setAutoRestoreTarget(backup)}
              >
                选择
              </button>
            </div>
          ))}
        </div>
      </Dialog>

      <ConfirmDialog
        open={autoRestoreTarget != null}
        title="从备份恢复？"
        body={
          autoRestoreTarget
            ? `将用 ${new Date(autoRestoreTarget.mtime).toLocaleString()} 的备份恢复学习进度（合并，不清空现有数据；恢复前会先备份当前数据）。`
            : ''
        }
        confirmLabel={autoRestoreBusy ? '恢复中…' : '恢复'}
        busy={autoRestoreBusy}
        onCancel={() => {
          if (!autoRestoreBusy) setAutoRestoreTarget(null)
        }}
        onConfirm={() => void handleRestoreAutoBackup()}
      />

      <Dialog
        open={autoRestoreStatus != null}
        title={
          autoRestoreStatus?.phase === 'running'
            ? '正在从备份恢复'
            : autoRestoreStatus?.phase === 'success'
              ? '恢复完成'
              : '恢复失败'
        }
        dismissable={autoRestoreStatus?.phase !== 'running'}
        onClose={() => {
          if (autoRestoreStatus?.phase !== 'running') setAutoRestoreStatus(null)
        }}
        actions={
          autoRestoreStatus?.phase === 'running' ? (
            <span className="mm-caption">恢复中…</span>
          ) : (
            <>
              {autoRestoreStatus?.phase === 'error' ? (
                <button
                  type="button"
                  className="mm-btn"
                  onClick={() => {
                    const name = autoRestoreStatus.name
                    setAutoRestoreStatus(null)
                    void (async () => {
                      const result = await restoreAutoBackupForUi(name)
                      if (result.ok) {
                        setAutoRestoreStatus({
                          phase: 'success',
                          name,
                          elapsedSec: 0,
                          report: {
                            words: result.report?.counts?.words ?? 0,
                            states: result.report?.counts?.states ?? 0,
                          },
                        })
                        setAutoBackups(listAutoBackupsForUi())
                      } else {
                        setAutoRestoreStatus({
                          phase: 'error',
                          name,
                          elapsedSec: 0,
                          error: result.error ?? '恢复失败',
                        })
                      }
                    })()
                  }}
                >
                  重试
                </button>
              ) : null}
              <button type="button" className="mm-btn mm-btn--primary" onClick={() => setAutoRestoreStatus(null)}>
                关闭
              </button>
            </>
          )
        }
      >
        {autoRestoreStatus?.phase === 'running' ? (
          <div className="auto-restore-status">
            <div className="mm-caption">
              正在恢复 {autoRestoreStatus.name} · {restorePhaseLabel(restorePersisted?.phase)} · 已等待{' '}
              {autoRestoreStatus.elapsedSec}s
            </div>
            <div className="mm-progress">
              <div className="mm-progress-fill auto-restore-progress" />
            </div>
            <div className="mm-caption">数据较大时可能需要 1–2 分钟，请勿离开页面或切到后台。</div>
          </div>
        ) : autoRestoreStatus?.phase === 'success' ? (
          <div className="mm-list">
            <div className="mm-caption">
              已恢复 {autoRestoreStatus.report?.words ?? 0} 词 / {autoRestoreStatus.report?.states ?? 0} 条学习状态。
            </div>
            {autoRestoreStatus.preRestoreName ? (
              <div className="mm-caption">恢复前已自动备份：{autoRestoreStatus.preRestoreName}</div>
            ) : null}
            <div className="mm-caption">可返回列表继续使用；如数据异常可再次从备份恢复。</div>
          </div>
        ) : autoRestoreStatus?.phase === 'error' ? (
          <div className="mm-list">
            <div className="mm-caption">恢复失败，错误信息已保留：</div>
            <div className="auto-restore-error">{autoRestoreStatus.error ?? '未知错误'}</div>
            <div className="mm-caption">请检查存储空间/备份完整性后重试。</div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={rootExportOpen}
        title="导出词根缀源"
        onClose={() => setRootExportOpen(false)}
        actions={
          <button type="button" className="mm-btn" disabled={rootExportBusy} onClick={() => setRootExportOpen(false)}>
            取消
          </button>
        }
      >
        <div className="mm-list">
          <button type="button" className="mm-row" disabled={rootExportBusy} onClick={() => void handleRootExport('all')}>
            全部词库
          </button>
          <button
            type="button"
            className="mm-row"
            disabled={rootExportBusy || !currentDeckId}
            onClick={() => void handleRootExport('deck')}
          >
            当前词库{currentDeckId ? '' : '（未选择）'}
          </button>
        </div>
      </Dialog>

      <Dialog
        open={rootImportReport != null}
        title="词根缀源导入报告"
        onClose={() => setRootImportReport(null)}
        actions={
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => setRootImportReport(null)}>
            关闭
          </button>
        }
      >
        {rootImportReport ? (
          <div className="mm-list">
            <div className="mm-caption">
              {rootImportReport.ok ? '导入完成' : '导入失败/部分失败'} · 更新 {rootImportReport.updated} · 跳过手改{' '}
              {rootImportReport.skippedManual} · 缺词 {rootImportReport.skippedMissing} · 失败 {rootImportReport.failed}
            </div>
            {rootImportReport.issues.map((issue) => (
              <div className="mm-caption" key={issue}>{issue}</div>
            ))}
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={coreExportOpen}
        title="导出本义助记"
        onClose={() => {
          if (!coreExportBusy) setCoreExportOpen(false)
        }}
        dismissable={!coreExportBusy}
        actions={
          <>
            <button
              type="button"
              className="mm-btn"
              disabled={coreExportBusy}
              onClick={() => setCoreExportOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--primary"
              disabled={coreExportBusy || !coreExportStats}
              onClick={() => void handleCoreExport()}
            >
              {coreExportBusy ? '导出中…' : '导出 JSON'}
            </button>
          </>
        }
      >
        <div className="core-io-dialog">
          <div className="mm-caption">选择范围</div>
          <div className="mm-btn-row">
            <button
              type="button"
              className={`mm-btn${coreExportScope === 'all' ? ' mm-btn--primary' : ''}`}
              onClick={() => {
                setCoreExportScope('all')
                void loadCoreExportStats('all')
              }}
              disabled={coreExportBusy}
            >
              全部词库
            </button>
            <button
              type="button"
              className={`mm-btn${coreExportScope === 'deck' ? ' mm-btn--primary' : ''}`}
              onClick={() => {
                if (!currentDeckId) return
                setCoreExportScope('deck')
                void loadCoreExportStats('deck')
              }}
              disabled={coreExportBusy || !currentDeckId}
              title={currentDeckId ? undefined : '请先选择当前词库'}
            >
              当前词库
            </button>
          </div>
          {!currentDeckId ? (
            <div className="mm-caption">未选择当前词库，只能导出全部；请先在首页选择词库。</div>
          ) : null}
          {coreExportStats ? (
            <div className="mm-caption core-io-counts">
              词数 {coreExportStats.words} · 本义 {coreExportStats.senses} · 已有助记{' '}
              {coreExportStats.withMnemonic} · 待生成 {coreExportStats.pending}
            </div>
          ) : (
            <div className="mm-caption">正在统计…</div>
          )}
        </div>
      </Dialog>

      <Dialog
        open={coreImportPreview != null}
        title={coreImportDone ? '导入结果' : '导入本义助记'}
        onClose={() => {
          if (!coreImportBusy) setCoreImportPreview(null)
        }}
        dismissable={!coreImportBusy}
        actions={
          coreImportDone ? (
            <button type="button" className="mm-btn" onClick={() => setCoreImportPreview(null)}>
              关闭
            </button>
          ) : (
            <>
              <button
                type="button"
                className="mm-btn"
                disabled={coreImportBusy}
                onClick={() => setCoreImportPreview(null)}
              >
                取消
              </button>
              <button
                type="button"
                className={`mm-btn mm-btn--primary${coreOverwrite ? ' mm-btn--danger' : ''}`}
                disabled={coreImportBusy || (coreOverwrite && !coreOverwriteConfirmed)}
                onClick={() => void handleApplyCoreImport()}
              >
                {coreImportPhase ?? (coreImportBusy ? '导入中…' : coreOverwrite ? '确认覆盖导入' : '确认导入（合并）')}
              </button>
            </>
          )
        }
      >
        {coreImportPreview ? (
          <div className="core-io-dialog">
            {coreImportBusy ? (
              <div
                className={`mm-progress${coreImportProgress && coreImportProgress.total > 0 ? '' : ' mm-progress--indeterminate'}`}
                aria-label="导入进度"
              >
                <div
                  className="mm-progress-fill"
                  style={
                    coreImportProgress && coreImportProgress.total > 0
                      ? { width: `${Math.round((coreImportProgress.done / coreImportProgress.total) * 100)}%` }
                      : undefined
                  }
                />
              </div>
            ) : null}
            <div className="mm-caption core-io-counts">
              本义助记 {coreImportPreview.report.counts.sensesImported} 条 · 串联{' '}
              {coreImportPreview.report.counts.overviewsImported} 条 · 匹配词{' '}
              {coreImportPreview.report.counts.wordsMatched}/{coreImportPreview.report.counts.words}
            </div>
            {!coreImportDone ? (
              <>
                <div className="mm-caption">
                  默认合并：不覆盖已有 AI/手改；stale{' '}
                  {coreImportPreview.report.counts.stale} 条、跳过{' '}
                  {coreImportPreview.report.counts.skippedExisting +
                    coreImportPreview.report.counts.skippedManual}{' '}
                  条。
                </div>
                <label className="core-io-strategy">
                  <input
                    type="radio"
                    name="core-import-strategy"
                    checked={!coreOverwrite}
                    onChange={() => setCoreOverwrite(false)}
                  />
                  <span>合并（默认，不覆盖已有手动/AI 助记）</span>
                </label>
                <label className="core-io-strategy">
                  <input
                    type="radio"
                    name="core-import-strategy"
                    checked={coreOverwrite}
                    onChange={() => {
                      setCoreOverwrite(true)
                      setCoreOverwriteConfirmed(false)
                    }}
                  />
                  <span>覆盖（会覆盖已有 AI/手动助记）</span>
                </label>
                {coreOverwrite ? (
                  <label className="core-io-strategy core-io-warning">
                    <input
                      type="checkbox"
                      checked={coreOverwriteConfirmed}
                      onChange={(event) => setCoreOverwriteConfirmed(event.target.checked)}
                    />
                    <span>我确认覆盖已有助记（含手改），此操作不可撤销</span>
                  </label>
                ) : null}
              </>
            ) : (
              <div className="mm-caption core-io-counts">
                导入完成：本义助记 {coreImportPreview.report.counts.sensesImported} · 串联{' '}
                {coreImportPreview.report.counts.overviewsImported} · 跳过已有{' '}
                {coreImportPreview.report.counts.skippedExisting} · 跳过手改{' '}
                {coreImportPreview.report.counts.skippedManual} · stale{' '}
                {coreImportPreview.report.counts.stale} · 空文本{' '}
                {coreImportPreview.report.counts.emptySkipped} · 未匹配词{' '}
                {coreImportPreview.report.counts.unresolvedWords}
              </div>
            )}
            {coreImportPreview.report.issues.length > 0 ? (
              <details className="core-io-issues">
                <summary>问题/警告 {coreImportPreview.report.issues.length} 条</summary>
                <ul>
                  {coreImportPreview.report.issues.slice(0, 30).map((issue, index) => (
                    <li key={`${issue.code}-${index}`} className={issue.level === 'error' ? 'mm-danger-text' : ''}>
                      {issue.headword ? `${issue.headword}: ` : ''}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={confirmCompleteExport}
        title="完整备份？"
        body="完整备份包含全量引申图与内容包，体积可能很大；超过安全上限时会直接提示并取消（不会崩溃），请改用「导出学习进度 + 导出全部引申图 + 内容包导出」分项备份。"
        confirmLabel="仍要完整备份"
        onCancel={() => setConfirmCompleteExport(false)}
        onConfirm={() => {
          setConfirmCompleteExport(false)
          void handleExportMigration(true)
        }}
      />

      <BatchDerivationPanel open={batchOpen} onClose={() => setBatchOpen(false)} />

      <SectionBand title="其他" />
      <div className="mm-list">
        <SettingRow label="设置" chevron onClick={() => navigate('/me/settings')} />
        <SettingRow label="关于" hint="版本 / 算法说明 / 词库版权 / 开源许可" chevron onClick={() => navigate('/me/about')} />
      </div>

      <div className="mm-caption" style={{ textAlign: 'center', paddingTop: 24 }}>
        本地优先 · 数据只存本机 · v{APP_VERSION}
      </div>

      <ConfirmDialog
        open={pendingForce != null}
        title="校验和不一致"
        body="迁移包可能被修改或损坏。仍要导入吗？（可能产生重复词条，建议先备份）"
        confirmLabel="仍要导入"
        danger
        busy={importing}
        onCancel={() => setPendingForce(null)}
        onConfirm={() => {
          if (pendingForce) void handleImportMigration(pendingForce, true)
        }}
      />
      <Dialog
        open={migrationDiagOpen}
        title="SQLite M3 迁移演练（dryRun）"
        onClose={() => setMigrationDiagOpen(false)}
        actions={
          <>
            <button
              type="button"
              className="mm-btn"
              disabled={migrationDiagBusy || !migrationDiagText}
              onClick={() => {
                void navigator.clipboard?.writeText(migrationDiagText).then(
                  () => toast.success('已复制迁移演练 JSON'),
                  () => toast.error('复制失败'),
                )
              }}
            >
              复制
            </button>
            <button
              type="button"
              className="mm-btn"
              disabled={migrationDiagBusy || !migrationDiagText}
              onClick={() => {
                void saveBlobFile(
                  new Blob([migrationDiagText], { type: 'application/json' }),
                  datedFileName('迁移演练', 'sqlite-m3-dryrun.json'),
                  'application/json',
                ).then((result) => {
                  const info = saveResultMessage(result)
                  if (info.ok) toast.success(`已导出：${info.message}`)
                  else toast.error(info.message)
                })
              }}
            >
              导出下载
            </button>
            <button type="button" className="mm-btn mm-btn--primary" onClick={() => setMigrationDiagOpen(false)}>
              关闭
            </button>
          </>
        }
      >
        <pre className="mm-caption" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflow: 'auto', margin: 0 }}>
          {migrationDiagText}
        </pre>
      </Dialog>

      <Dialog
        open={sqliteRestoreOpen}
        title="SQLite facts 恢复"
        onClose={() => setSqliteRestoreOpen(false)}
        actions={<button type="button" className="mm-btn" onClick={() => setSqliteRestoreOpen(false)}>关闭</button>}
      >
        <div className="mm-caption" style={{ marginBottom: 8 }}>
          仅列出有效的 SQLite facts 备份；恢复前强制完整备份并校验 counts。旧 JSON 包仍在「从自动备份恢复」中兼容显示（标注旧）。
        </div>
        {sqliteBackups.length === 0 ? <div className="mm-caption">没有有效的 SQLite facts 备份。</div> : null}
        {sqliteBackups.map((backup) => (
          <div className="mm-row" key={backup.name}>
            <span className="mm-row-main">
              <span className="mm-row-title">{new Date(backup.mtime).toLocaleString()}</span>
              <span className="mm-row-sub">
                {(backup.size / 1024 / 1024).toFixed(1)}MB · SQLite facts
              </span>
            </span>
            <button
              type="button"
              className="mm-btn mm-btn--sm"
              disabled={sqliteBackupBusy}
              onClick={() => {
                if (!window.confirm('从该 SQLite 备份恢复？会先完整备份当前数据并校验 counts，失败拒绝。')) return
                setSqliteRestoreOpen(false)
                setSqliteBackupBusy(true)
                void (async () => {
                  try {
                    const pre = await createPreBackup()
                    if (!pre.ok) {
                      toast.error(`预备份失败，已中止恢复：${pre.error ?? '未知错误'}`)
                      return
                    }
                    const result = await restoreSqliteFactsBackup(
                      { path: backup.path, ...(backup.manifest ? { manifest: backup.manifest as never } : {}) },
                      { preBackup: async () => ({ ok: true }) },
                    )
                    setMigrationDiagText(JSON.stringify({ result }, null, 2))
                    setMigrationDiagOpen(true)
                    if (result.ok) {
                      toast.success(`SQLite 恢复完成（${result.counts?.states ?? 0} 状态），请重启验证`)
                    } else {
                      toast.error(`恢复失败：${result.error ?? '未知错误'}`)
                    }
                  } finally {
                    setSqliteBackupBusy(false)
                  }
                })()
              }}
            >
              恢复
            </button>
          </div>
        ))}
      </Dialog>

      <Dialog
        open={rollbackOpen}
        title="0.10 回退包"
        onClose={() => setRollbackOpen(false)}
        actions={
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => setRollbackOpen(false)}>关闭</button>
        }
      >
        {rollbackBusy ? <div className="mm-caption">正在生成回退包…</div> : null}
        {rollbackInfo?.error ? <div className="mm-caption mm-danger-text">失败：{rollbackInfo.error}</div> : null}
        {rollbackInfo?.counts ? (
          <div className="mm-caption" style={{ lineHeight: 1.8 }}>
            <div>已生成：{rollbackInfo.file}</div>
            <div>版本：{rollbackInfo.version} · epoch {rollbackInfo.epoch}</div>
            <div>
              counts：states {rollbackInfo.counts.states} / plans {rollbackInfo.counts.plans} / settings {rollbackInfo.counts.settings} / logs {rollbackInfo.counts.reviewLogs}
            </div>
            {rollbackInfo.delta ? (
              <div>
                delta 检测：{rollbackInfo.delta.hasDelta ? `有新增（states ${rollbackInfo.delta.states} / plans ${rollbackInfo.delta.plans} / logs ${rollbackInfo.delta.reviewLogs}），再次升级前需同步` : '无新增，可直接再次升级'}
              </div>
            ) : null}
            <div style={{ marginTop: 8, fontWeight: 600 }}>回退步骤</div>
            <div>1）安装 0.10 APK；</div>
            <div>2）我的→数据→导入学习进度，选择该 JSON；</div>
            <div>3）选择覆盖导入并确认；导入前会先自动备份。</div>
          </div>
        ) : null}
      </Dialog>

      <Dialog
        open={sqliteDiagOpen}
        title="SQLite M1 自检"
        onClose={() => setSqliteDiagOpen(false)}
        actions={
          <>
            <button
              type="button"
              className="mm-btn"
              disabled={sqliteDiagBusy || !sqliteDiagText}
              onClick={() => {
                void navigator.clipboard?.writeText(sqliteDiagText).then(
                  () => toast.success('已复制 SQLite 自检 JSON'),
                  () => toast.error('复制失败'),
                )
              }}
            >
              复制
            </button>
            <button
              type="button"
              className="mm-btn"
              disabled={sqliteDiagBusy || !sqliteDiagText}
              onClick={() => {
                void saveBlobFile(
                  new Blob([sqliteDiagText], { type: 'application/json' }),
                  datedFileName('SQLite自检', 'sqlite-m1-selftest.json'),
                  'application/json',
                ).then((result) => {
                  const info = saveResultMessage(result)
                  if (info.ok) toast.success(`已导出：${info.message}`)
                  else toast.error(info.message)
                })
              }}
            >
              导出下载
            </button>
            <button type="button" className="mm-btn mm-btn--primary" onClick={() => setSqliteDiagOpen(false)}>
              关闭
            </button>
          </>
        }
      >
        <pre className="mm-caption" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '50vh', overflow: 'auto', margin: 0 }}>
          {sqliteDiagText}
        </pre>
      </Dialog>
    </PageShell>
  )
}
