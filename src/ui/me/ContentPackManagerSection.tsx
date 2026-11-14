/**
 * 内容包管理（task-86）：列出已导入 pack，导出单个/全部、删除（危险确认）。
 * 导出走现有 saveBlobFile（APK 桥接/浏览器统一），失败有提示。
 */
import { useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { dedupePacks, deletePack, ensureDefaultContentPacks, exportPack, listPackItems, listPacks, mergeDuplicateAiPacks, reapplyPack, resetSemanticsData } from '../../data'
import { useToast } from '../../app/toast'
import { ConfirmDialog } from '../components/Dialog'
import { dateSuffix, saveBlobFile, saveResultMessage } from '../../app/utils/files'

/** 包来源展示（task-116）：内置/手工/草稿/AI */
export function packSourceLabel(source: string, isDraft = false): string {
  if (isDraft) return '草稿'
  if (source === 'builtin') return '内置'
  if (source === 'ai') return 'AI'
  if (source === 'import') return '手工'
  return '手工'
}

export interface ContentPackRow {
  id: string
  name: string
  kind: string
  items: number
  applied: number
  /** task-138：跳过/失败条数（unknown/limit 等，UI 显示原因汇总入口） */
  skipped?: number
  source: string
  createdAt: number
}

/** 清理结果文案（task-93） */
export function dedupeSummary(removed: number, kept: number): string {
  return `已清理 ${removed} 个重复内容包（保留 ${kept} 个）`
}

/** 重复内容包检测（task-93）：同名/同 kind/同条目数视为可能重复 */
/** AI 内容包重复检测（task-138 B2）：同一 deck 的 AI 生成内容应仅一个包 */
export function countAiPacks(rows: ContentPackRow[]): number {
  return rows.filter((row) => row.source === 'ai' && row.kind !== 'semantics').length
}

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
  onResetSemantics,
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
  /** 重置本义数据并重新应用内置 v4（task-116） */
  onResetSemantics?: () => void
  busy?: boolean
}) {
  const toast = useToast()
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
              {row.kind} · 已应用 {row.applied} / 总 {row.items}
              {(row.skipped ?? 0) > 0 ? `（跳过 ${row.skipped}）` : ''} · 来源 {row.source}
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
      {countAiPacks(rows) > 1 ? (
        <div className="mm-caption mm-danger-text">
          检测到 {countAiPacks(rows)} 个 AI 内容包（多次生成产生）；可合并为 1 个，已应用内容保留。
          <button
            type="button"
            className="mm-btn"
            style={{ marginLeft: 8 }}
            onClick={() => {
              void (async () => {
                try {
                  const result = await mergeDuplicateAiPacks()
                  toast.success(`已合并 AI 内容包：删除 ${result.removed} 个，保留 ${result.kept.length} 个`)
                } catch (error) {
                  toast.error(error instanceof Error ? error.message : '合并 AI 内容包失败')
                }
              })()
            }}
          >
            合并 AI 内容包
          </button>
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
        {onResetSemantics ? (
          <button
            type="button"
            className="mm-btn mm-btn--danger"
            onClick={onResetSemantics}
            disabled={busy}
          >
            重置本义数据
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
  const [removeAppliedOnDelete, setRemoveAppliedOnDelete] = useState(false)
  const [resetSemanticsConfirm, setResetSemanticsConfirm] = useState(false)
  const [resetMessage, setResetMessage] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<ContentPackRow | null>(null)
  const rows = useLiveQuery<ContentPackRow[]>(async () => {
    const packs = await listPacks()
    // task-116：草稿包（draft pack）不混入内容包列表
    const visible = packs.filter((pack) => !(pack as { draft?: unknown }).draft)
    return Promise.all(
      visible.map(async (pack) => {
        const items = await listPackItems(pack.id)
        return {
          id: pack.id,
          name: pack.name || pack.id,
          kind: pack.kind,
          items: items.length,
          applied: items.filter((item) => item.status === 'applied').length,
          skipped: items.filter((item) => item.status === 'skipped').length,
          source: packSourceLabel(String(pack.source ?? 'import')),
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
        `已重新应用「${row.name || row.id}」：应用 ${result.applied} 条，跳过 ${result.skipped} 条` +
          (result.errors?.length ? `，失败批次 ${result.errors.length} 个（可再次重新应用）` : ''),
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
      {resetMessage ? <div className="mm-caption">{resetMessage}</div> : null}
      <ContentPackList
        rows={rows ?? []}
        busy={busy}
        onRecheckBuiltin={recheckBuiltin}
        onReapply={(row) => void reapplyOne(row)}
        onDedupe={() => setDedupeConfirm(true)}
        onResetSemantics={() => setResetSemanticsConfirm(true)}
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
        open={resetSemanticsConfirm}
        title="重置本义数据并重新应用内置 v4？"
        body="将移除所有已应用的本义链（semantics）内容，并重新应用当前内置 v4 本义包；词条/学习数据不动。若中途失败，已移除内容需重新应用。"
        confirmLabel="重置并重应用"
        danger
        busy={busy}
        onCancel={() => setResetSemanticsConfirm(false)}
        onConfirm={() => {
          void (async () => {
            setBusy(true)
            setResetMessage(null)
            setRecheckMessage('正在重置本义数据：清理旧语义包…')
            let summary = ''
            try {
              const result = await resetSemanticsData()
              summary = `已清理 ${result.removedPacks} 个旧语义包 / ${result.removedItems} 条旧语义记录`
              setRecheckMessage('正在重新应用内置 v4 本义包…')
              const seeded = await ensureDefaultContentPacks({
                force: true,
                onProgress: (progress) =>
                  setRecheckMessage(
                    `正在重新应用内置 v4（${progress.path.split('/').pop() ?? ''} ${progress.phase} ${progress.done}/${progress.total}）…`,
                  ),
              })
              summary += `；内置应用 ${seeded.applied} 条`
              setResetMessage(summary)
              toast.success(`已重置本义数据：${summary}`)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              setResetMessage(`${summary ? `${summary}；` : ''}重置失败：${message}`)
              toast.error(`重置本义数据失败：${message}`)
            } finally {
              setRecheckMessage(null)
              setBusy(false)
              setResetSemanticsConfirm(false)
            }
          })()
        }}
      />
      <ConfirmDialog
        open={pendingDelete != null}
        title="删除内容包？"
        body={
          pendingDelete
            ? `将删除「${pendingDelete.name}」及其 ${pendingDelete.items} 条内容记录。${
                removeAppliedOnDelete
                  ? '已应用到词库的内容也会移除（词条本身保留）。'
                  : '已应用到词库的内容默认保留。'
              }`
            : ''
        }
        confirmLabel="删除"
        danger
        busy={busy}
        onCancel={() => {
          setPendingDelete(null)
          setRemoveAppliedOnDelete(false)
        }}
        onConfirm={() => {
          void (async () => {
            if (!pendingDelete) return
            setBusy(true)
            try {
              await deletePack(pendingDelete.id, {
                removeAppliedContent: removeAppliedOnDelete,
              })
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
