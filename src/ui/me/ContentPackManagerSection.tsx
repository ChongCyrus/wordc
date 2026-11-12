/**
 * 内容包管理（task-86）：列出已导入 pack，导出单个/全部、删除（危险确认）。
 * 导出走现有 saveBlobFile（APK 桥接/浏览器统一），失败有提示。
 */
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { dedupePacks, deletePack, ensureDefaultContentPacks, exportPack, listPackItems, listPacks, reapplyPack } from '../../data'
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

/** 清理结果文案（task-93） */
export function dedupeSummary(removed: number, kept: number): string {
  return `已清理 ${removed} 个重复内容包（保留 ${kept} 个）`
}

/** 重复内容包检测（task-93）：同名/同 kind/同条目数视为可能重复 */
export function countDuplicatePacks(rows: ContentPackRow[]): number {
  const seen = new Set<string>()
  let duplicates = 0
  for (const row of rows) {
    const key = `${row.name}|${row.kind}|${row.items}`
    if (seen.has(key)) duplicates += 1
    else seen.add(key)
  }
  return duplicates
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
  onRecheckBuiltin,
  onReapply,
  onDedupe,
  busy = false,
}: {
  rows: ContentPackRow[]
  onExport: (row: ContentPackRow) => void
  onExportAll: () => void
  onDelete: (row: ContentPackRow) => void
  /** 重新检查/应用内置内容包（task-91） */
  onRecheckBuiltin?: () => void
  /** 重新应用某个 pack（task-91；`reapplyPack` 接口就绪后注入） */
  onReapply?: (row: ContentPackRow) => void
  /** 清理重复内容包（task-93；dedupePacks） */
  onDedupe?: () => void
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
          {onRecheckBuiltin ? (
            <button type="button" className="mm-btn" onClick={onRecheckBuiltin}>
              重新检查内置内容
            </button>
          ) : null}
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
              {row.kind} · 已应用 {row.applied} / 总 {row.items} · 来源 {row.source}
            </span>
          </span>
          <span style={{ display: 'flex', gap: 6 }}>
            {onReapply && row.applied < row.items ? (
              <button
                type="button"
                className="mm-btn"
                aria-label={`重新应用内容包 ${row.name || row.id}`}
                onClick={() => onReapply(row)}
                disabled={busy}
              >
                重新应用
              </button>
            ) : null}
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
      {countDuplicatePacks(rows) > 0 ? (
        <div className="mm-caption mm-danger-text">
          检测到 {countDuplicatePacks(rows)} 个重复内容包（多次检查内置内容产生）；可清理重复记录，已应用内容会保留。
          {onDedupe ? (
            <button
              type="button"
              className="mm-btn"
              style={{ marginLeft: 8 }}
              onClick={onDedupe}
              disabled={busy}
            >
              清理重复内容包
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="mm-btn-row">
        <button type="button" className="mm-btn mm-btn--primary" onClick={onExportAll} disabled={busy}>
          导出全部
        </button>
        {onRecheckBuiltin ? (
          <button type="button" className="mm-btn" onClick={onRecheckBuiltin} disabled={busy}>
            重新检查内置内容
          </button>
        ) : null}
      </div>
    </div>
  )
}

export function ContentPackManagerSection() {
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [recheckMessage, setRecheckMessage] = useState<string | null>(null)
  const [dedupeConfirm, setDedupeConfirm] = useState(false)
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

  const reapplyOne = async (row: ContentPackRow): Promise<{ applied: number; skipped: number } | null> => {
    setBusy(true)
    try {
      const result = await reapplyPack(row.id, {
        batchSize: 200,
        onProgress: ({ phase, done, total }) =>
          setRecheckMessage(`正在重新应用（${phase}）${done}/${total}…（不要重复点击）`),
      })
      toast.success(
        `已重新应用「${row.name || row.id}」：应用 ${result.applied} 条，跳过 ${result.skipped} 条`,
      )
      return result
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重新应用内容包失败')
      return null
    } finally {
      setBusy(false)
    }
  }

  const recheckBuiltin = () => {
    void (async () => {
      setBusy(true)
      setRecheckMessage('正在检查内置内容…（不要重复点击）')
      try {
        const result = await ensureDefaultContentPacks({
          force: true,
          onProgress: ({ phase, done, total }) =>
            setRecheckMessage(`正在检查内置内容（${phase}）${done}/${total}…（不要重复点击）`),
        })
        if (!result.ok) {
          setRecheckMessage(null)
          toast.error(result.issues[0]?.message ?? '内置内容检查失败，请稍后重试')
          return
        }
        setRecheckMessage('正在重新应用未完成的条目…（不要重复点击）')
        // 对仍未完整应用的旧 pack 重新应用（task-90 的 deckId 修复生效）
        let reapplied = 0
        let skipped = 0
        for (const row of rows ?? []) {
          if (row.applied >= row.items) continue
          try {
            const applied = await reapplyPack(row.id, {
              batchSize: 200,
              onProgress: ({ phase, done, total }) =>
                setRecheckMessage(`正在重新应用未完成条目（${phase}）${done}/${total}…`),
            })
            reapplied += applied.applied
            skipped += applied.skipped
          } catch {
            /* 单个失败继续其他 pack */
          }
        }
        setRecheckMessage(null)
        toast.success(
          `已重新应用内置内容：应用 ${result.applied + reapplied} 条，跳过 ${result.issues.length + skipped} 条`,
        )
      } catch (error) {
        setRecheckMessage(null)
        toast.error(error instanceof Error ? error.message : '内置内容检查失败')
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <>
      {recheckMessage ? <div className="mm-caption">{recheckMessage}</div> : null}
      <ContentPackList
        rows={rows ?? []}
        busy={busy}
        onRecheckBuiltin={recheckBuiltin}
        onReapply={(row) => void reapplyOne(row)}
        onDedupe={() => setDedupeConfirm(true)}
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
        open={dedupeConfirm}
        title="清理重复内容包？"
        body="只删除重复的内容包记录（同 checksum）；已应用到词库的内容保留，不影响学习数据。"
        confirmLabel="清理"
        danger
        busy={busy}
        onCancel={() => setDedupeConfirm(false)}
        onConfirm={() => {
          void (async () => {
            setBusy(true)
            try {
              const result = await dedupePacks()
              toast.success(dedupeSummary(result.removed, result.kept))
              setDedupeConfirm(false)
            } catch (error) {
              toast.error(error instanceof Error ? error.message : '清理重复内容包失败')
            } finally {
              setBusy(false)
            }
          })()
        }}
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
