import { useEffect, useState } from 'react'
import {
  getDb,
  getContentWriteSource,
  readContentCounts,
  CONTENT_MIGRATION_STATE_KEY,
  isSqliteAvailable,
  sqliteCall,
  migrateIdbToSqlite,
  repairMigratedPlans,
  getLearningWriteSource,
  repairLearningWriteSource,
  getSqliteFactsManifest,
  getContentSourceV15Status,
} from '../../data'
import { readDiagnosticFile } from '../../app/utils/auto-backup'
import { buildSafetyDiagnosticsText } from '../../app/utils/auto-backup-service'
import { mapContentError } from '../../app/utils/content-errors'
import { datedFileName, saveBlobFile, saveResultMessage } from '../../app/utils/files'
import { PageShell } from '../components/PageShell'
import { SectionBand } from '../components/SectionBand'
import { SettingRow } from '../components/SettingRow'
import { Dialog } from '../components/Dialog'
import { useToast } from '../../app/toast'

export function describeContentWriteError(error: unknown): string {
  return mapContentError(error)
}

/** 0.11.1：我的→数据→调试 独立页；默认从主列表隐藏 */
export default function DebugPage() {
  const toast = useToast()
  const [text, setText] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [writeSource, setWriteSource] = useState(() => getLearningWriteSource())
  const [manifestText, setManifestText] = useState('尚未读取 SQLite manifest')
  const [contentState, setContentState] = useState<{
    source: 'idb' | 'sqlite' | null
    status: string
    counts: { total?: number } & Record<string, unknown>
    revision?: number
    writeCoverageComplete?: boolean
    error?: string
    v15?: { status?: string; source?: string; error?: string; from?: string } | null
  } | null>(null)

  useEffect(() => {
    setWriteSource(getLearningWriteSource())
  }, [])

  const refreshContentState = async () => {
    try {
      const [source, row, counts, v15] = await Promise.all([
        getContentWriteSource(),
        getDb().meta.get(CONTENT_MIGRATION_STATE_KEY),
        readContentCounts().catch(() => ({}) as Record<string, unknown>),
        getContentSourceV15Status().catch(() => null),
      ])
      const value = (row?.value ?? {}) as { status?: string; revision?: number; writeCoverageComplete?: boolean; error?: string }
      setContentState({
        source,
        status: value.status ?? '未开始',
        counts: counts as { total?: number } & Record<string, unknown>,
        ...(value.revision != null ? { revision: value.revision } : {}),
        ...(typeof value.writeCoverageComplete === 'boolean' ? { writeCoverageComplete: value.writeCoverageComplete } : {}),
        ...(value.error ? { error: value.error } : {}),
        v15: v15 ? { status: v15.state?.status ?? '未开始', source: v15.source, ...(v15.state?.error ? { error: v15.state.error } : {}), ...(v15.state?.from ? { from: v15.state.from } : {}) } : null,
      })
    } catch (error) {
      setContentState({
        source: null,
        status: '读取失败',
        counts: {},
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  useEffect(() => {
    void refreshContentState()
    const onUpdated = () => void refreshContentState()
    window.addEventListener('momo:content-backup-updated', onUpdated)
    window.addEventListener('focus', onUpdated)
    document.addEventListener('visibilitychange', onUpdated)
    return () => {
      window.removeEventListener('momo:content-backup-updated', onUpdated)
      window.removeEventListener('focus', onUpdated)
      document.removeEventListener('visibilitychange', onUpdated)
    }
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
      void refreshContentState()
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
          label="内容写入源"
          hint={`${contentState?.source ?? '读取失败/未知'} · 迁移状态 ${contentState?.status ?? '未开始'}${contentState?.revision != null ? ` · revision ${contentState.revision}` : ''}${contentState?.error ? ` · ${contentState.error}` : ''}`}
          value={contentState?.source === 'sqlite' ? 'SQLite' : contentState?.source === 'idb' ? 'IDB' : '未知'}
        />
        <details className="mm-card" style={{ margin: '4px 0' }}>
          <summary className="mm-row-title">内容 counts / 错误详情（可展开）</summary>
          <pre className="mm-caption" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', margin: 0 }}>
            {contentState ? JSON.stringify(contentState, null, 2) : '读取中…'}
          </pre>
        </details>
        <SettingRow
          label="v15 单一事实源迁移"
          hint={`只读：v15 ${contentState?.v15?.status ?? '未开始'}${contentState?.v15?.from ? ` (${contentState.v15.from})` : ''} · source ${contentState?.v15?.source ?? contentState?.source ?? '读取中'}${contentState?.v15?.error ? ` · ${contentState.v15.error}` : ''}；不提供用户切换`}
          value={contentState?.source === 'sqlite' ? '已切 SQLite' : 'IDB'}
        />
        <SettingRow
          label="重建内容缓存"
          hint="从 SQLite facts 重建 IDB 内容缓存；cache 可丢弃，失败不回写事实源"
          value={busy ? '重建中…' : undefined}
          disabled={busy}
          chevron
          onClick={() =>
            void run(async () => {
              const mod = (await import('../../data')) as {
                rebuildContentCacheFromSqlite?: () => Promise<{ ok: boolean; rows?: number; error?: string }>
              }
              if (!mod.rebuildContentCacheFromSqlite) throw new Error('重建缓存接口未就绪')
              const result = await mod.rebuildContentCacheFromSqlite()
              if (!result.ok) throw new Error(describeContentWriteError(result.error ?? '重建失败'))
              return result
            })
          }
        />
        <SettingRow
          label="清理过期内容库（导入回退后）"
          hint="把导入后遗留的 content_kv live 行标记删除，再允许重新影子迁移；IDB 内容不动"
          chevron
          onClick={() =>
            void run(async () => {
              if (!window.confirm('清理过期 content_kv？只标记删除旧 SQLite 内容行，不改 IDB。')) return { skipped: true }
              const mod = (await import('../../data')) as {
                discardStaleContentKv?: () => Promise<{ ok: boolean; cleared: number; error?: string }>
              }
              if (!mod.discardStaleContentKv) throw new Error('清理接口未就绪')
              const result = await mod.discardStaleContentKv()
              if (!result.ok) throw new Error(describeContentWriteError(result.error ?? '清理失败'))
              await refreshContentState()
              return result
            })
          }
        />
        <SettingRow
          label="M3 迁移演练（dryRun）"
          hint="IDB counts / 批次 / 可迁移"
          chevron
          onClick={() => void run(() => migrateIdbToSqlite({ dryRun: true, batchSize: 200 }))}
        />
        <SettingRow
          label="强制 IDB→SQLite facts 迁移（修复写源）"
          hint="把当前 IDB states/plans/settings/logs 写入 SQLite，再修复写源；仅数据恢复用"
          chevron
          onClick={() =>
            void run(async () => {
              const migrated = await migrateIdbToSqlite({ dryRun: false, batchSize: 200 })
              const repaired = await repairLearningWriteSource()
              setWriteSource(getLearningWriteSource())
              return { migrated, repaired, writeSource: getLearningWriteSource() }
            })
          }
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
