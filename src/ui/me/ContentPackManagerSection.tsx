/**
 * 内容包管理（task-86）：列出已导入 pack，导出单个/全部、删除（危险确认）。
 * 导出走现有 saveBlobFile（APK 桥接/浏览器统一），失败有提示。
 */
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { deletePack, exportPack, listPackItems, listPacks } from '../../data'
import { useToast } from '../../app/toast'
import { ConfirmDialog } from '../components/Dialog'
import { dateSuffix, saveBlobFile, saveResultMessage } from '../../app/utils/files'

export interface ContentPackRow {
  id: string
  name: string
  kind: string
  items: number
  applied: number
  source: string
  createdAt: number
}

export function packExportFileName(name: string, kind: string, date = dateSuffix()): string {
  const safe = (name || kind || 'pack').replace(/[\\/:*?"<>|]/g, '-').slice(0, 60)
  return `${safe}-${date}.pack.json`
}

export function ContentPackList({
  rows,
  onExport,
  onExportAll,
  onDelete,
  busy = false,
}: {
  rows: ContentPackRow[]
  onExport: (row: ContentPackRow) => void
  onExportAll: () => void
  onDelete: (row: ContentPackRow) => void
  busy?: boolean
}) {
  if (rows.length === 0) {
    return (
      <div className="mm-list">
        <div className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">内容包管理</span>
            <span className="mm-row-sub">还没有导入过内容包；可先导入 `.pack.json`</span>
          </span>
        </div>
      </div>
    )
  }
  return (
    <div className="mm-list">
      {rows.map((row) => (
        <div key={row.id} className="mm-row">
          <span className="mm-row-main">
            <span className="mm-row-title">{row.name || row.id}</span>
            <span className="mm-row-sub">
              {row.kind} · {row.items} 条（已应用 {row.applied}）· 来源 {row.source}
            </span>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            <button type="button" className="mm-btn" onClick={() => onExport(row)} disabled={busy}>
              导出
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--danger"
              aria-label={`删除内容包 ${row.name || row.id}`}
              onClick={() => onDelete(row)}
              disabled={busy}
            >
              删除
            </button>
          </span>
        </div>
      ))}
      <div className="mm-btn-row">
        <button type="button" className="mm-btn mm-btn--primary" onClick={onExportAll} disabled={busy}>
          导出全部
        </button>
      </div>
    </div>
  )
}

export function ContentPackManagerSection() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<ContentPackRow | null>(null)
  const rows = useLiveQuery<ContentPackRow[]>(async () => {
    const packs = await listPacks()
    return Promise.all(
      packs.map(async (pack) => {
        const items = await listPackItems(pack.id)
        return {
          id: pack.id,
          name: pack.name || pack.id,
          kind: pack.kind,
          items: items.length,
          applied: items.filter((item) => item.status === 'applied').length,
          source: String(pack.source ?? 'import'),
          createdAt: pack.createdAt,
        }
      }),
    )
  }, [])

  const exportOne = async (row: ContentPackRow) => {
    setBusy(true)
    try {
      const blob = await exportPack(row.id, { includePending: true })
      const result = await saveBlobFile(blob, packExportFileName(row.name, row.kind), 'application/json')
      const message = saveResultMessage(result)
      if (message.ok) toast.success(message.message)
      else toast.error(message.message)
      return true
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出内容包失败')
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <ContentPackList
        rows={rows ?? []}
        busy={busy}
        onExport={(row) => void exportOne(row)}
        onExportAll={() => {
          void (async () => {
            const list = rows ?? []
            let ok = 0
            let failed = 0
            for (const row of list) {
              if (await exportOne(row)) ok += 1
              else failed += 1
            }
            toast.success(`已导出 ${ok} 个内容包${failed > 0 ? `，失败 ${failed} 个` : ''}`)
          })()
        }}
        onDelete={(row) => setPendingDelete(row)}
      />
      <ConfirmDialog
        open={pendingDelete != null}
        title="删除内容包？"
        body={
          pendingDelete
            ? `将删除「${pendingDelete.name}」及其 ${pendingDelete.items} 条内容记录；已应用到词库的内容默认保留。`
            : ''
        }
        confirmLabel="删除"
        danger
        busy={busy}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          void (async () => {
            if (!pendingDelete) return
            setBusy(true)
            try {
              await deletePack(pendingDelete.id)
              toast.success('已删除内容包')
              setPendingDelete(null)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : '删除失败')
            } finally {
              setBusy(false)
            }
          })()
        }}
      />
    </>
  )
}
