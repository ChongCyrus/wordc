import { useState } from 'react'
import { useSettings } from '../../app/hooks/useSettings'
import { useNavigate } from 'react-router-dom'
import {
  exportMigration,
  importMigration,
  createFactsPreBackup,
  FULL_BACKUP_MAX_BYTES,
  exportRootEtymologyBundleText,
  importRootEtymologyBundle,
  isRootEtymologyBundle,
  exportCoreSenseMnemonicJson,
  coreSenseMnemonicFileName,
  previewCoreSenseMnemonicImport,
  applyCoreSenseMnemonicImportParsed,
  exportAllDerivationMaps,
  importDerivationBundle,
  parseDerivationBundle,
} from '../../data'
import { useToast } from '../../app/toast'
import {
  buildSafetyDiagnosticsText,
  createAutoBackupBridge,
  listAutoBackupsForUi,
  restoreAutoBackupForUi,
} from '../../app/utils/auto-backup-service'
import { exportBackupToDownloads } from '../../app/utils/auto-backup'
import {
  datedFileName,
  pickTextFile,
  readFileAsText,
  saveBlobFile,
  saveResultMessage,
} from '../../app/utils/files'
import { BRAND } from '../../app/brand'
import { mapContentError } from '../../app/utils/content-errors'
import { PageShell } from '../components/PageShell'
import { SectionBand } from '../components/SectionBand'
import { SettingRow } from '../components/SettingRow'
import { Switch } from '../components/Switch'

function reportText(report: Awaited<ReturnType<typeof importMigration>>): string {
  if (report.ok) return `导入完成：${report.counts.decks} 词库 / ${report.counts.words} 词 / ${report.counts.states} 条状态`
  const issue = report.issues.find((item) => item.level === 'error')
  return issue ? `导入失败：${issue.message}` : '导入失败'
}

export default function ImportExportPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const { settings } = useSettings()

  const saveExport = async (complete: boolean) => {
    setBusy(complete ? '完整备份…' : '导出中…')
    try {
      const blob = await exportMigration(
        complete
          ? { includeDerivationMaps: true, includeContentPacks: true, maxBytes: FULL_BACKUP_MAX_BYTES }
          : undefined,
      )
      const result = await saveBlobFile(
        blob,
        datedFileName(`${BRAND.shortName}-${complete ? '完整备份' : '学习进度'}`, 'migration.json'),
        'application/json',
      )
      const info = saveResultMessage(result)
      if (info.ok) toast.success(info.message)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setBusy(null)
    }
  }

  const importProgress = async () => {
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      const text = await readFileAsText(file)
      setBusy('导入中…')
      const report = await importMigration(text, {
        strategy: 'merge',
        preBackup: async () => {
          const r = await createFactsPreBackup(createAutoBackupBridge())
          return { ok: r.ok, ...(r.error ? { error: r.error } : {}) }
        },
      })
      if (report.ok) toast.success(reportText(report))
      else toast.error(reportText(report))
    } catch (error) {
      toast.error(mapContentError(error, '导入失败'))
    } finally {
      setBusy(null)
    }
  }

  const exportLatestBackup = () => {
    const latest = listAutoBackupsForUi()[0]
    if (!latest) {
      toast.error('暂无自动备份可导出')
      return
    }
    const result = exportBackupToDownloads(latest.name)
    if (result.ok) toast.success(result.path ? `已导出到下载：${result.path}` : '已导出到下载')
    else toast.error(result.error ?? '导出备份失败')
  }

  const restoreLatestBackup = async () => {
    const latest = listAutoBackupsForUi()[0]
    if (!latest) {
      toast.error('暂无自动备份可恢复')
      return
    }
    if (!window.confirm(`从 ${new Date(latest.mtime).toLocaleString()} 的自动备份恢复？恢复前会备份当前数据。`)) return
    setBusy('恢复中…')
    try {
      const result = await restoreAutoBackupForUi(latest.name)
      if (result.ok) {
        toast.success('已从自动备份恢复，请重启验证')
        window.location.reload()
      } else {
        toast.error(result.error ?? '恢复失败')
      }
    } catch (error) {
      toast.error(mapContentError(error, '恢复失败'))
    } finally {
      setBusy(null)
    }
  }

  const exportDiagnostics = async () => {
    setBusy('导出诊断…')
    try {
      const payload = await buildSafetyDiagnosticsText()
      const saved = await saveBlobFile(
        new Blob([payload], { type: 'application/json' }),
        datedFileName('数据安全诊断', 'data-safety-diagnostics.json'),
        'application/json',
      )
      const info = saveResultMessage(saved)
      if (info.ok) toast.success(`诊断包已导出：${info.message}`)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setBusy(null)
    }
  }

  const exportRoot = async () => {
    setBusy('导出词根缀源…')
    try {
      const text = await exportRootEtymologyBundleText()
      const saved = await saveBlobFile(
        new Blob([text], { type: 'application/json' }),
        datedFileName('词根缀源', 'root-etymology.json'),
        'application/json',
      )
      const info = saveResultMessage(saved)
      if (info.ok) toast.success(info.message)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    } finally {
      setBusy(null)
    }
  }

  const importRoot = async () => {
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      setBusy('导入词根缀源…')
      const text = await readFileAsText(file)
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        toast.error('JSON 解析失败')
        return
      }
      if (!isRootEtymologyBundle(parsed)) {
        toast.error('不是有效的词根缀源 bundle')
        return
      }
      // 根缀 bundle 只更新 words.rootEtymology（preserveManual，不删除其它数据），
      // 全量 preBackup 在 Web 端会因 27MB 导出长时间阻塞；这里不再做全量备份。
      const report = await importRootEtymologyBundle(parsed, { preserveManual: true })
      if (!report.ok) {
        toast.error(`导入失败：${report.issues[0]?.message ?? '校验失败'}`)
        return
      }
      toast.success(
        `词根缀源导入完成：更新 ${report.updated} / 跳过手改 ${report.skippedManual} / 缺词 ${report.skippedMissing} / 失败 ${report.failed.length}`,
      )
      try {
        window.dispatchEvent(new Event('momo:generated-seed-updated'))
      } catch {
        /* ignore */
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入词根缀源失败')
    } finally {
      setBusy(null)
    }
  }

  const exportCore = async () => {
    setBusy('导出本义助记…')
    try {
      const blob = await exportCoreSenseMnemonicJson()
      const saved = await saveBlobFile(blob, coreSenseMnemonicFileName(), 'application/json')
      const info = saveResultMessage(saved)
      if (info.ok) toast.success(info.message)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出本义助记失败')
    } finally {
      setBusy(null)
    }
  }

  const importCore = async () => {
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      setBusy('导入本义助记…')
      const text = await readFileAsText(file)
      const preview = await previewCoreSenseMnemonicImport(text)
      if (!preview.ok) {
        toast.error(preview.issues.find((item) => item.level === 'error')?.message ?? '本义助记文件无效')
        return
      }
      const report = await applyCoreSenseMnemonicImportParsed(preview)
      if (report.ok) toast.success('本义助记导入完成')
      else toast.error(report.issues.find((item) => item.level === 'error')?.message ?? '导入失败')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入本义助记失败')
    } finally {
      setBusy(null)
    }
  }

  const exportDerivation = async () => {
    setBusy('导出引申图…')
    try {
      const bundle = await exportAllDerivationMaps()
      const saved = await saveBlobFile(
        new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
        datedFileName(`${BRAND.shortName}-引申图`, 'derivation-bundle.json'),
        'application/json',
      )
      const info = saveResultMessage(saved)
      if (info.ok) toast.success(`已导出 ${bundle.items?.length ?? 0} 条引申图`)
      else toast.error(info.message)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出引申图失败')
    } finally {
      setBusy(null)
    }
  }

  const importDerivation = async () => {
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      setBusy('导入引申图…')
      const text = await readFileAsText(file)
      const parsed = parseDerivationBundle(text)
      if (!parsed.ok) {
        toast.error(`引申图文件无效：${parsed.errors[0] ?? '格式错误'}`)
        return
      }
      const result = await importDerivationBundle(text, { mode: 'merge' })
      toast.success(`导入引申图：成功 ${result.imported} / 跳过 ${result.skipped} / 失败 ${result.failed}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入引申图失败')
    } finally {
      setBusy(null)
    }
  }

  return (
    <PageShell title="导入与导出" backTo="/me">
      <div className="mm-caption" style={{ marginBottom: 8 }}>学习进度、完整备份与内容包导入导出。</div>
      <SectionBand title="学习进度" />
      <div className="mm-list">
        <SettingRow label="导出学习进度" hint="轻量包：词库 + 学习状态 + 设置" value={busy === '导出中…' ? '导出中…' : undefined} disabled={busy !== null} chevron onClick={() => void saveExport(false)} />
        <SettingRow label="完整备份（含引申图/内容包）" hint="体积大、较慢；含额外内容" value={busy === '完整备份…' ? '备份中…' : undefined} disabled={busy !== null} chevron onClick={() => void saveExport(true)} />
        <SettingRow label="导入学习进度" hint="轻量/完整包；会先自动备份" value={busy === '导入中…' ? '导入中…' : undefined} disabled={busy !== null} chevron onClick={() => void importProgress()} />
      </div>
      <SectionBand title="自动备份" />
      <div className="mm-list">
        <SettingRow
          label="自动备份（每次启动）"
          hint="每次启动学习时自动备份；同日覆盖，保留最近 7 份"
          control={
            <Switch
              label="自动备份（每次启动）"
              checked={settings?.['data.autoBackupEnabled'] !== false}
              onChange={(checked) => {
                void import('../../data').then(({ updateSettings }) =>
                  updateSettings({ 'data.autoBackupEnabled': checked }),
                )
              }}
            />
          }
        />
        <SettingRow
          label="立即备份"
          hint="只备份学习进度 facts（states/plans/settings/logs），不含词库/内容包/引申图；内容请用完整导出"
          value={busy === '备份中…' ? '备份中…' : undefined}
          chevron
          onClick={() => {
            if (busy) return
            setBusy('备份中…')
            void import('../../app/utils/auto-backup-service')
              .then(({ startupAutoBackup }) => startupAutoBackup({ force: true }))
              .then((result) => {
                if ('mode' in result && result.mode === 'error') toast.error(result.error ?? '备份失败')
                else toast.success('自动备份完成')
              })
              .catch((error) => toast.error(error instanceof Error ? error.message : '备份失败'))
              .finally(() => setBusy(null))
          }}
        />
        <SettingRow label="导出备份到下载" hint="导出最近一份自动备份到 Download/DSH-Go" chevron onClick={exportLatestBackup} />
        <SettingRow label="从自动备份恢复" hint="恢复前会备份当前数据" value={busy === '恢复中…' ? '恢复中…' : undefined} chevron onClick={() => void restoreLatestBackup()} />
      </div>
      <SectionBand title="内容包" />
      <div className="mm-list">
        <SettingRow label="词库导入 / 导出" hint="新建、导入 JSON/CSV、导出词库" chevron onClick={() => navigate('/decks')} />
        <SettingRow label="导出词根缀源" hint="导出 bundle JSON" chevron onClick={() => void exportRoot()} />
        <SettingRow label="导入词根缀源" hint="选择 JSON，手改优先" value={busy === '导入词根缀源…' ? '导入中…' : undefined} disabled={busy !== null} chevron onClick={() => void importRoot()} />
        <SettingRow label="导出本义助记" hint="导出词/本义/助记 JSON" value={busy === '导出本义助记…' ? '导出中…' : undefined} disabled={busy !== null} chevron onClick={() => void exportCore()} />
        <SettingRow label="导入本义助记" hint="校验后合并导入" value={busy === '导入本义助记…' ? '导入中…' : undefined} disabled={busy !== null} chevron onClick={() => void importCore()} />
        <SettingRow label="导出全部引申图" hint="导出 derivation bundle" value={busy === '导出引申图…' ? '导出中…' : undefined} disabled={busy !== null} chevron onClick={() => void exportDerivation()} />
        <SettingRow label="导入引申图" hint="合并导入引申图" value={busy === '导入引申图…' ? '导入中…' : undefined} disabled={busy !== null} chevron onClick={() => void importDerivation()} />
      </div>
      <SectionBand title="诊断" />
      <div className="mm-list">
        <SettingRow label="导出安全诊断包" hint="JSON 保存到 Download/DSH-Go" value={busy === '导出诊断…' ? '导出中…' : undefined} chevron onClick={() => void exportDiagnostics()} />
        <SettingRow label="迁移与修复 / 调试" hint="SQLite 迁移、写源修复、自检" chevron onClick={() => navigate('/me/debug')} />
      </div>
    </PageShell>
  )
}
