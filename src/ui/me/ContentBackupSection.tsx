import { useEffect, useState } from 'react'
import {
  createContentBaseline,
  createContentIncrement,
  getContentBackupStatus,
  listContentBackups,
  restoreContentBackup,
  updateSettings,
  type ContentBackupListItem,
  type ContentBackupStatus,
} from '../../data'
import { useSettings } from '../../app/hooks/useSettings'
import { mapContentError } from '../../app/utils/content-errors'
import { useToast } from '../../app/toast'
import { SettingRow } from '../components/SettingRow'
import { Switch } from '../components/Switch'
import { Dialog } from '../components/Dialog'

const KIND_LABEL: Record<string, string> = { baseline: '基线', increment: '增量' }

/** 0.12：自动备份内容（实验）开关 + 基线/增量/列表/恢复 + 状态 */
export function ContentBackupSection() {
  const toast = useToast()
  const { settings } = useSettings()
  const [status, setStatus] = useState<ContentBackupStatus | null>(null)
  const [items, setItems] = useState<ContentBackupListItem[]>([])
  const [listOpen, setListOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)

  const refresh = async () => {
    try {
      const [nextStatus, nextItems] = await Promise.all([getContentBackupStatus(), listContentBackups()])
      setStatus(nextStatus)
      setItems(nextItems)
    } catch (error) {
      toast.error(`读取内容备份状态失败：${error instanceof Error ? error.message : '未知错误'}`)
    }
  }

  useEffect(() => {
    void refresh()
    const onUpdated = () => {
      void refresh()
    }
    const onVisible = () => {
      if (typeof document === 'undefined' || document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('momo:content-backup-updated', onUpdated)
    window.addEventListener('focus', onVisible)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('momo:content-backup-updated', onUpdated)
      window.removeEventListener('focus', onVisible)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  useEffect(() => {
    if (!listOpen) return
    setBusy('读取内容备份列表…')
    void refresh().finally(() => setBusy(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listOpen])

  const runBaseline = async () => {
    if (busy) return
    setBusy('基线创建中…')
    try {
      const result = await createContentBaseline()
      if (result.ok) {
        toast.success(`内容基线完成：revision ${result.revision} · ${result.bytes} bytes`)
        await refresh()
      } else {
        toast.error(`内容基线失败：${result.error ?? '未知错误'}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '内容基线失败')
    } finally {
      setBusy(null)
    }
  }

  const runIncrement = async () => {
    if (busy) return
    setBusy('增量备份中…')
    try {
      const result = await createContentIncrement()
      if (result.ok) {
        toast.success(`内容增量完成：revision ${result.revision} · sequence ${result.sequence}`)
        await refresh()
      } else if (result.mode === 'noop') {
        toast.success('内容无变化，无需增量')
      } else {
        toast.error(`内容增量失败：${result.error ?? '需要新完整基线'}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '内容增量失败')
    } finally {
      setBusy(null)
    }
  }

  const restore = async (item: ContentBackupListItem) => {
    if (busy) return
    if (!window.confirm(`从内容${KIND_LABEL[item.kind]} ${item.name} 恢复？恢复为单事务，失败不会改变现有内容。`)) return
    setBusy('恢复内容备份中…')
    try {
      const result = await restoreContentBackup(item.id)
      if (result.ok) {
        toast.success('内容备份恢复完成')
        setListOpen(false)
        await refresh()
      } else {
        toast.error(`恢复失败：${mapContentError(result.error ?? '未知错误')}`)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复内容备份失败')
    } finally {
      setBusy(null)
    }
  }

  const fmt = (at: number | null | undefined) => (at ? new Date(at).toLocaleString() : '—')

  return (
    <>
      <SettingRow
        label="自动备份内容（实验）"
        hint="开启后先创建完整基线，之后只做增量；内容备份在后台执行，不阻塞学习；失败不会影响学习进度"
        control={
          <Switch
            label="自动备份内容（实验）"
            checked={settings?.['backup.autoContentEnabled'] === true}
            onChange={(checked) => {
              void updateSettings({ 'backup.autoContentEnabled': checked }).then(() => refresh())
            }}
          />
        }
      />
      <SettingRow
        label="内容备份状态"
        hint={`最近基线 ${fmt(status?.lastBaseline)} · 最近增量 ${fmt(status?.lastIncrement)} · 上次成功 ${fmt(status?.lastSuccess)} · 连续失败 ${status?.consecutiveFailures ?? 0}${status?.needsFullSnapshot ? ' · 需要完整基线' : ''}${status?.chainBroken ? ' · 链断' : ''}${status?.error ? ` · ` + status.error : ''}`}
        value={busy ?? (status?.needsFullSnapshot ? '需新基线' : status?.chainBroken ? '链断' : undefined)}
        chevron
        onClick={() => setListOpen(true)}
      />
      {status?.needsFullSnapshot || status?.chainBroken ? (
        <div className="mm-caption mm-danger-text" style={{ padding: '4px 12px' }}>
          {status.needsFullSnapshot ? '需要创建新的完整基线后才能继续增量备份。' : '增量链已断，需要创建新基线。'}
        </div>
      ) : null}
      <SettingRow
        label="创建内容基线"
        hint="完整内容快照；其余增量以它为起点"
        value={busy === '基线创建中…' ? '创建中…' : undefined}
        disabled={busy !== null}
        chevron
        onClick={() => void runBaseline()}
      />
      <SettingRow
        label="立即增量备份"
        hint="自上次基线/增量以来的内容变化；无变化不写文件"
        value={busy === '增量备份中…' ? '备份中…' : undefined}
        disabled={busy !== null}
        chevron
        onClick={() => void runIncrement()}
      />
      <SettingRow
        label="内容备份列表 / 恢复"
        hint={items.length > 0 ? `${items.length} 份（基线/增量链）` : '暂无内容备份'}
        chevron
        onClick={() => setListOpen(true)}
      />
      <Dialog
        open={listOpen}
        title="内容备份列表"
        onClose={() => {
          if (!busy) setListOpen(false)
        }}
        dismissable={!busy}
        actions={<button type="button" className="mm-btn" disabled={busy !== null} onClick={() => setListOpen(false)}>关闭</button>}
      >
        <div className="mm-caption" style={{ marginBottom: 8 }}>
          基线/增量链均可恢复（增量会沿链校验 ancestors/checksum）。
        </div>
        {items.length === 0 ? <div className="mm-caption">暂无内容备份。</div> : null}
        {items.map((item) => (
          <div className="mm-row" key={item.id}>
            <span className="mm-row-main">
              <span className="mm-row-title">
                {KIND_LABEL[item.kind]} r{item.revision} · seq {item.sequence} · {(item.size / 1024).toFixed(0)} KB
              </span>
              <span className="mm-row-sub">
                {new Date(item.mtime).toLocaleString()} · {item.valid ? '有效' : '无效'} · checksum {item.checksum ? item.checksum.slice(0, 8) : '—'}
                {item.parentChecksum ? ` · parent ${item.parentChecksum.slice(0, 8)}` : ''}
              </span>
            </span>
            <button
              type="button"
              className="mm-btn mm-btn--sm"
              disabled={busy !== null || !item.valid}
              onClick={() => void restore(item)}
            >
              恢复
            </button>
          </div>
        ))}
      </Dialog>
    </>
  )
}
