import { useEffect, useState } from 'react'
import {
  isSqliteAvailable,
  sqliteCall,
  migrateIdbToSqlite,
  repairMigratedPlans,
  getLearningWriteSource,
  repairLearningWriteSource,
  getSqliteFactsManifest,
} from '../../data'
import { readDiagnosticFile } from '../../app/utils/auto-backup'
import { buildSafetyDiagnosticsText } from '../../app/utils/auto-backup-service'
import { datedFileName, saveBlobFile, saveResultMessage } from '../../app/utils/files'
import { PageShell } from '../components/PageShell'
import { SectionBand } from '../components/SectionBand'
import { SettingRow } from '../components/SettingRow'
import { Dialog } from '../components/Dialog'
import { useToast } from '../../app/toast'

/** 0.11.1：我的→数据→调试 独立页；默认从主列表隐藏 */
export default function DebugPage() {
  const toast = useToast()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [writeSource, setWriteSource] = useState(() => getLearningWriteSource())
  const [manifestText, setManifestText] = useState('尚未读取 SQLite manifest')

  useEffect(() => {
    setWriteSource(getLearningWriteSource())
  }, [])

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setOpen(true)
    setText('执行中…')
    try {
      setText(JSON.stringify(await action(), null, 2))
    } catch (error) {
      setText(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2))
      toast.error(error instanceof Error ? error.message : '调试操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell title="调试" backTo="/me">
      <SectionBand title="数据与 SQLite" />
      <div className="mm-list">
        <SettingRow
          label="存储诊断"
          hint="读取内部诊断文件并显示 JSON"
          value={busy ? '读取中…' : undefined}
          chevron
          onClick={() => {
            setBusy(true)
            setOpen(true)
            setText('读取中…')
            try {
              setText(readDiagnosticFile() ?? '暂无诊断文件')
            } catch (error) {
              setText(String(error))
            } finally {
              setBusy(false)
            }
          }}
        />
        <SettingRow
          label="SQLite M1 自检"
          hint="health + integrity"
          chevron
          onClick={() =>
            void run(async () => ({
              available: isSqliteAvailable(),
              health: await sqliteCall({ method: 'health', timeoutMs: 10_000 }),
              integrity: await sqliteCall({ method: 'integrity', timeoutMs: 20_000 }),
            }))
          }
        />
        <SettingRow
          label="M3 迁移演练（dryRun）"
          hint="IDB counts / 批次 / 可迁移"
          chevron
          onClick={() => void run(() => migrateIdbToSqlite({ dryRun: true, batchSize: 200 }))}
        />
        <SettingRow
          label="M4b2 plan 修复演练（dryRun）"
          hint="扫描 plan 字段问题"
          chevron
          onClick={() => void run(() => repairMigratedPlans({ dryRun: true }))}
        />
        <SettingRow
          label="SQLite facts manifest"
          hint={manifestText}
          chevron
          onClick={() =>
            void getSqliteFactsManifest()
              .then((manifest) => {
                setManifestText(
                  manifest
                    ? `states ${manifest.counts.states} / plans ${manifest.counts.plans} / settings ${manifest.counts.settings} · epoch ${manifest.dataEpoch} · v${manifest.userVersion}`
                    : '尚未读取 SQLite manifest',
                )
              })
              .catch((error) => toast.error(error instanceof Error ? error.message : '读取失败'))
          }
        />
        <SettingRow
          label="当前学习写源"
          hint={`${writeSource}${writeSource === 'readonly' ? '（需修复）' : ''}`}
          value={writeSource === 'readonly' ? '修复' : undefined}
          chevron
          onClick={() =>
            void run(async () => {
              const before = getLearningWriteSource()
              const result = await repairLearningWriteSource()
              const after = getLearningWriteSource()
              setWriteSource(after)
              return { before, after, result }
            })
          }
        />
        <SettingRow
          label="导出安全诊断包"
          hint="保存到 Download/DSH-Go"
          chevron
          onClick={() =>
            void run(async () => {
              const payload = await buildSafetyDiagnosticsText()
              const saved = await saveBlobFile(
                new Blob([payload], { type: 'application/json' }),
                datedFileName('数据安全诊断', 'data-safety-diagnostics.json'),
                'application/json',
              )
              return saveResultMessage(saved)
            })
          }
        />
      </div>
      <Dialog
        open={open}
        title="调试结果"
        onClose={() => setOpen(false)}
        actions={<button type="button" className="mm-btn mm-btn--primary" onClick={() => setOpen(false)}>关闭</button>}
      >
        <pre className="mm-caption" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '55vh', overflow: 'auto', margin: 0 }}>
          {text}
        </pre>
      </Dialog>
    </PageShell>
  )
}
