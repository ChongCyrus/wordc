import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
} from '../../data'
import { useStatsOverview } from '../../app/hooks/useStats'
import { useTheme } from '../../app/theme'
import './me.css'
import { useToast } from '../../app/toast'
import { useSettings } from '../../app/hooks/useSettings'
import { useGeneratedSeedStatus } from '../../app/hooks/useGeneratedSeedStatus'
import {
  listAutoBackupsForUi,
  requestAutoBackupPersist,
  restoreAutoBackupForUi,
  startupAutoBackup,
} from '../../app/utils/auto-backup-service'
import type { AutoBackupRestoreStatus } from '../../data'
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
  const [diagnosticOpen, setDiagnosticOpen] = useState(false)
  const [diagnosticText, setDiagnosticText] = useState('')
  const [exportBackupOpen, setExportBackupOpen] = useState(false)
  const [exportBackupBusy, setExportBackupBusy] = useState(false)
  const { status: generatedStatus, importing: generatedImporting, importNow: importGeneratedNow } =
    useGeneratedSeedStatus(1200)
  const [persistState, setPersistState] = useState<
    'unsupported' | 'granted' | 'prompt' | 'failed'
  >('prompt')
  const currentDeckId = settings?.['data.selectedDeckId'] ?? ''
  const autoBackupAvailable = isAutoBackupAvailable()

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
      try {
        setAutoBackups(listAutoBackupsForUi())
      } catch {
        setAutoBackups([])
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
    void requestAutoBackupPersist().then((granted) => setPersistState(granted ? 'granted' : 'failed'))
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
      setAutoBackups(autoBackupAvailable ? listAutoBackupsForUi() : [])
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
      const report = await importMigration(text, { strategy: 'merge', ...(force ? { force: true } : {}) })
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

  return (
    <PageShell title="我的" hero>
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
            怎么练：词根词缀法三步（点开展开）
          </summary>
          <div className="mm-caption" style={{ lineHeight: 1.8, paddingTop: 8 }}>
            <p style={{ margin: '0 0 8px' }}>
              <strong>词根词缀法三步</strong>
            </p>
            <ol style={{ margin: '0 0 8px', paddingLeft: 20 }}>
              <li style={{ margin: '0 0 6px' }}>
                <strong>记忆词根词缀词源</strong>：注释面/记忆页先看词根、前缀、后缀、词源分解，理解核心义（生成元）从哪来。
              </li>
              <li style={{ margin: '0 0 6px' }}>
                <strong>加权记忆推导各含义/本义</strong>：把核心义代入各含义的语境、搭配、词性，推导实际指代；推导不出的含义（nc）反复加权。
              </li>
              <li style={{ margin: '0 0 6px' }}>
                <strong>白板推导 + 针对性巩固</strong>：白板只看单词/词性/例句，先按词根缀源推导；再对不熟含义用加权记忆巩固，直到能仅凭词根缀源想起各含义。
              </li>
            </ol>
            <p className="mm-caption usage-guide-note" style={{ margin: '0 0 8px' }}>
              <strong>映射算法原理</strong>：词根/词缀/词源是压缩后的核心义；每个实际含义都是「核心义 + 语境/搭配/词性/作用对象」的一次实例化。记忆时先建「词根缀源→核心义→各含义」的正向映射，只对推导失败的含义（nc）加密；回忆时反向由含义回到核心义，再由核心义展开其它含义；核心义遗忘时用几个已记含义交叉反推。这样不必为每个含义单独建记忆，只需维护一张可双向推导的映射网。
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
            <p style={{ margin: '0 0 4px' }}>· 注释面：看中文含义/例句/助记与词根词缀词源；点「记忆」练「单词→含义」，「加权记忆」对不熟悉的含义多练。</p>
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
          label="预装内容"
          hint={
            generatedStatus == null
              ? '读取中…'
              : !generatedStatus.supported
                ? '浏览器版不含预装数据'
                : generatedStatus.state === 'running'
                  ? `导入中 ${Math.round(((generatedStatus.done || 0) / Math.max(1, generatedStatus.total || 0)) * 100)}%（可继续使用）`
                  : generatedStatus.state === 'completed'
                    ? `已完成：本义助记 ${generatedStatus.senseImported ?? 0} 条 / 引申图 ${generatedStatus.derivationImported ?? 0} 词${generatedStatus.completedAt ? ` · ${new Date(generatedStatus.completedAt).toLocaleString()}` : ''}`
                    : generatedStatus.state === 'failed'
                      ? `导入失败：${generatedStatus.error ?? '未知错误'}（下次启动重试）`
                      : generatedStatus.state === 'skipped-existing'
                        ? '已存在内容，跳过导入'
                        : '未开始（启动后自动导入）'
          }
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
        <SettingRow
          label="自动备份"
          hint={
            autoBackupAvailable
              ? `自动备份存 App 内部（清 WebView 数据不丢）；最近 ${autoBackups[0] ? new Date(autoBackups[0].mtime).toLocaleString() : '暂无'} · ${autoBackups.length} 份（gzip 压缩，保留 7 份且 ≤100MB），可导出到下载`
              : '自动备份存 App 内部（清 WebView 数据不丢），浏览器版请手动导出'
          }
          value={autoBackupAvailable && autoBackups.length > 0 ? `${autoBackups.length} 份` : undefined}
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
                ? '已申请持久化，降低被系统清理风险'
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
        <SettingRow label="词库管理" hint="新建 / 导入 / 导出 / 从墨墨导入" chevron onClick={() => navigate('/decks')} />
        <SettingRow
          label="从墨墨导入学习进度"
          hint="APK 内置直连；浏览器/PWA 需本机代理（详见弹层说明）"
          chevron
          onClick={() => navigate('/decks?maimemo=1')}
        />
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
          hint={
            importing
              ? '正在导入…'
              : '兼容轻量/完整包；轻量包不会清空本机引申图/内容包'
          }
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
          <div className="mm-caption">选择一份备份恢复；恢复前会自动备份当前数据，采用合并且不清空现有数据。</div>
          {autoBackups.map((backup) => (
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
    </PageShell>
  )
}
