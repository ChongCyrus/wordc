import { useEffect, useState } from 'react'
import { Dialog } from '../components/Dialog'
import { useToast } from '../../app/toast'
import {
  listAutoBackupsForUi,
  restoreAutoBackupForUi,
  startupAutoBackup,
} from '../../app/utils/auto-backup-service'
import type { AutoBackupEntry } from '../../app/utils/auto-backup'
import type { AutoBackupRestoreResult } from '../../data'
import { describeRestoreFailure } from '../../app/utils/auto-backup-error'

/** task-255：启动检查一次进度异常；异常时列出 auto 备份并可恢复 */
export function AutoBackupStartupGate() {
  const toast = useToast()
  const [open, setOpen] = useState(false)
  const [backups, setBackups] = useState<AutoBackupEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<AutoBackupRestoreResult | null>(null)

  useEffect(() => {
    let started = false
    // 0.4.0-A：anomaly 必须可靠执行；导出已异步分片让出主线程，
    // 因此直接启动（若首帧隐藏则等可见）。
    const start = () => {
      if (started) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      started = true
      void (async () => {
      const run = await startupAutoBackup()
      try {
        window.dispatchEvent(new Event('momo:auto-backup-updated'))
      } catch {
        /* 忽略事件派发失败 */
      }
      const mode = run && 'mode' in run ? run.mode : null
      const error =
        run && 'error' in run && typeof run.error === 'string' ? run.error : null
      // 0.3.94 热修：启动备份失败不再静默，明确 toast（容量/桥错误）；Web/禁用不打扰
      if (mode === 'error' || (mode !== 'disabled' && mode !== 'unavailable' && error)) {
        toast.error(`自动备份失败：${error ?? '未知错误'}（可到 我的→数据 手动备份）`)
        return
      }
      const anomaly =
        (run && 'progressAnomaly' in run && run.progressAnomaly) ||
        mode === 'anomaly'
      if (!anomaly) return
      setBackups(listAutoBackupsForUi())
      setOpen(true)
      })()
    }
    start()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') start()
    }
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])

  const restore = (name: string) => {
    void (async () => {
      setBusy(true)
      try {
        const restored = await restoreAutoBackupForUi(name)
        setResult(restored)
        if (restored.ok) toast.success('已从备份恢复学习进度')
        else toast.error(describeRestoreFailure(restored))
      } catch (error) {
        toast.error(error instanceof Error ? error.message : '恢复失败')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <Dialog
      open={open}
      title="检测到学习进度异常"
      dismissable={!busy}
      onClose={() => setOpen(false)}
      actions={
        result?.ok ? (
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => window.location.reload()}>
            重新加载
          </button>
        ) : (
          <button type="button" className="mm-btn" disabled={busy} onClick={() => setOpen(false)}>
            暂不恢复
          </button>
        )
      }
    >
      <div className="mm-caption">
        当前学习状态为空，但检测到本地自动备份。可先恢复最近的备份，恢复采用合并、不会清空现有数据。
      </div>
      {result ? (
        <div className="mm-caption">
          {result.ok
            ? `恢复完成：${result.report?.counts?.words ?? 0} 词 / ${result.report?.counts?.states ?? 0} 条状态`
            : `恢复失败：${describeRestoreFailure(result)}`}
        </div>
      ) : (
        <div className="mm-list">
          {backups.length === 0 ? (
            <div className="mm-caption">未找到自动备份；可用「我的→数据→导出学习进度」手动恢复。</div>
          ) : (
            backups.slice(0, 5).map((backup) => (
              <div className="mm-row" key={backup.name}>
                <span className="mm-row-main">
                  <span className="mm-row-title">{new Date(backup.mtime).toLocaleString()}</span>
                  <span className="mm-row-sub">{backup.size >= 1024 * 1024 ? `${(backup.size / 1024 / 1024).toFixed(1)} MB` : `${(backup.size / 1024).toFixed(0)} KB`}</span>
                </span>
                <button
                  type="button"
                  className="mm-btn mm-btn--sm"
                  disabled={busy}
                  onClick={() => restore(backup.name)}
                >
                  从备份恢复
                </button>
              </div>
            ))
          )}
        </div>
      )}
      {busy ? <div className="mm-caption">恢复中，请稍候…</div> : null}
      <div className="mm-caption">备份位置：应用私有目录 auto/（可在「我的→数据」查看/手动恢复）。</div>
    </Dialog>
  )
}
