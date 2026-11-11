import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import type { ImportReport } from '../../core'
import {
  createDeck,
  deleteDeck,
  exportDeck,
  importCsv,
  importDeckFile,
  importMaimemoProgress,
  importMaimemoRecords,
  isNativeHttpAvailable,
  maimemoMessageFor,
  renameDeck,
  setDefaultDeck,
} from '../../data'
import { useSettings } from '../../app/hooks/useSettings'
import { useDecksWithProgress } from '../../app/hooks/useDecks'
import { useToast } from '../../app/toast'
import {
  datedFileName,
  pickTextFile,
  readFileAsText,
  saveBlobFile,
  saveResultMessage,
} from '../../app/utils/files'
import { PageShell } from '../components/PageShell'
import { SectionBand, Card } from '../components/SectionBand'
import { Button, IconButton } from '../components/Buttons'
import { Dialog, ConfirmDialog } from '../components/Dialog'
import { ActionSheet } from '../components/Sheet'
import { EmptyState } from '../components/EmptyState'
import { MoreIcon, PlusIcon, UploadIcon } from '../components/icons'
import type { MaimemoErrorCode, MaimemoImportResult } from '../../data'
import {
  createMaimemoAbortHandle,
  describeMaimemoFailure,
  formatMaimemoScanProgress,
  formatMaimemoSummary,
  isMaimemoCancelled,
  resolveMaimemoTransport,
} from '../../app/hooks/useMaimemoTransport'

type DeckRow = ReturnType<typeof useDecksWithProgress>['rows'][number]

function reportMessage(report: ImportReport): string {
  if (!report.ok) {
    const first = report.issues.find((issue) => issue.level === 'error')
    return first ? `导入失败：${first.message}` : '导入失败：文件格式不正确'
  }
  if (report.kind === 'maimemo') {
    return `墨墨数据导入完成：${report.counts.words} 词 / ${report.counts.states} 条学习状态`
  }
  return `导入成功：${report.counts.decks} 个词库 / ${report.counts.words} 个单词`
}

/**
 * 词库页（SPEC §8.3 / 03-ui §4.5）：
 * 当前在学 + 全部词库（进度）+ 新建/重命名/删除/导出 + 导入词库 + 从墨墨导入。
 */
export default function DecksPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { settings, update } = useSettings()
  const { rows, loading } = useDecksWithProgress()

  const [actionRow, setActionRow] = useState<DeckRow | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [renameRow, setRenameRow] = useState<DeckRow | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteRow, setDeleteRow] = useState<DeckRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [maimemoOpen, setMaimemoOpen] = useState(false)
  const [maimemoToken, setMaimemoToken] = useState(settings?.['data.maimemoToken'] ?? '')
  const [maimemoProxy, setMaimemoProxy] = useState(settings?.['data.proxyUrl'] ?? '')
  const [maimemoProgress, setMaimemoProgress] = useState<string | null>(null)
  const [maimemoError, setMaimemoError] = useState<string | null>(null)
  const [maimemoResult, setMaimemoResult] = useState<{
    ok: boolean
    summary: string
  } | null>(null)
  const [maimemoBusy, setMaimemoBusy] = useState(false)
  const maimemoAbortRef = useRef<ReturnType<typeof createMaimemoAbortHandle> | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()

  // task-39：APK 原生直连 vs PWA 本地代理
  const maimemoTransport = resolveMaimemoTransport({
    nativeAvailable: isNativeHttpAvailable(),
    proxyUrl: maimemoProxy,
  })

  // 离开页面时中断在途导入（task-41）
  useEffect(() => {
    return () => {
      maimemoAbortRef.current?.abort()
    }
  }, [])

  // 从「我的 → 从墨墨导入进度」跳转时自动打开弹层（?maimemo=1）
  useEffect(() => {
    if (searchParams.get('maimemo') !== '1') return
    setMaimemoOpen(true)
    const next = new URLSearchParams(searchParams)
    next.delete('maimemo')
    setSearchParams(next, { replace: true })
  }, [searchParams, setSearchParams])

  const selectedDeckId = settings?.['data.selectedDeckId'] ?? ''
  const currentRow =
    rows.find((row) => row.deck.id === selectedDeckId) ??
    rows.find((row) => row.deck.isDefault) ??
    rows[0]

  const handleSetCurrent = async (row: DeckRow) => {
    try {
      await setDefaultDeck(row.deck.id)
      await update({ 'data.selectedDeckId': row.deck.id })
      toast.success(`已切换到「${row.deck.name}」`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '切换词库失败')
    }
  }

  const handleCreate = async () => {
    const name = createName.trim()
    if (!name) {
      toast.error('请输入词库名称')
      return
    }
    setBusy(true)
    try {
      const deck = await createDeck(name)
      setCreateOpen(false)
      setCreateName('')
      toast.success(`已创建词库「${deck.name}」`)
      navigate(`/decks/${deck.id}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '创建词库失败')
    } finally {
      setBusy(false)
    }
  }

  const handleRename = async () => {
    if (!renameRow) return
    const name = renameValue.trim()
    if (!name) {
      toast.error('请输入词库名称')
      return
    }
    setBusy(true)
    try {
      await renameDeck(renameRow.deck.id, name)
      setRenameRow(null)
      toast.success('已重命名')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '重命名失败')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteRow) return
    setBusy(true)
    try {
      await deleteDeck(deleteRow.deck.id)
      if (selectedDeckId === deleteRow.deck.id) {
        const nextDeck = rows.find((row) => row.deck.id !== deleteRow.deck.id)
        await update({ 'data.selectedDeckId': nextDeck?.deck.id ?? '' })
      }
      setDeleteRow(null)
      toast.success('已删除词库')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '删除词库失败')
    } finally {
      setBusy(false)
    }
  }

  const toastSave = (result: Awaited<ReturnType<typeof saveBlobFile>>) => {
    const info = saveResultMessage(result)
    if (info.ok) toast.success(`${info.message}（词库不含学习状态）`)
    else toast.error(info.message)
  }

  const handleExport = async (row: DeckRow) => {
    try {
      const blob = await exportDeck(row.deck.id)
      toastSave(await saveBlobFile(blob, datedFileName(row.deck.name, 'deck.json'), 'application/json'))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出失败')
    }
  }

  const handlePickImport = async () => {
    try {
      const file = await pickTextFile('.json,.csv,application/json,text/csv')
      if (file) await handleFile(file)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '选择文件失败')
    }
  }

  const handleFile = async (file: File | null) => {
    if (!file) return
    try {
      const text = await readFileAsText(file)
      const isCsv = /\.csv$/i.test(file.name)
      const report = isCsv
        ? await importCsv(text, file.name.replace(/\.csv$/i, ''))
        : await importDeckFile(text)
      if (report.ok) {
        toast.success(reportMessage(report))
      } else {
        toast.error(reportMessage(report))
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败')
    }
  }

  const toastMaimemoResult = (result: MaimemoImportResult) => {
    if (result.ok) {
      toast.success(
        `墨墨导入完成：匹配 ${result.matched} 词，跳过 ${result.skipped} 条，共 ${result.totalRecords} 条记录`,
      )
    } else {
      const issue = result.issues.find((item) => item.level === 'error')
      toast.error(issue ? `墨墨导入失败：${issue.message}` : '墨墨导入失败')
    }
  }

  /** 墨墨文件降级：从 JSON（数组或 {records:[]}）导入 */
  const handleMaimemoFileImport = async () => {
    setMaimemoBusy(true)
    try {
      const file = await pickTextFile('.json,application/json')
      if (!file) return
      const text = await readFileAsText(file)
      const parsed: unknown = JSON.parse(text)
      const records = Array.isArray(parsed)
        ? parsed
        : parsed && typeof parsed === 'object' && Array.isArray((parsed as { records?: unknown[] }).records)
          ? ((parsed as { records: unknown[] }).records)
          : []
      if (records.length === 0) {
        toast.error('文件中没有可导入的墨墨记录')
        return
      }
      setMaimemoProgress(`正在解析文件（${records.length} 条记录）…`)
      const result = await importMaimemoRecords(records)
      setMaimemoProgress('导入完成')
      toastMaimemoResult(result)
      if (result.ok) setMaimemoOpen(false)
    } catch (error) {
      setMaimemoProgress(null)
      toast.error(error instanceof Error ? error.message : '文件导入失败')
    } finally {
      setMaimemoBusy(false)
    }
  }

  /** 开始导入：按词库扫描约 1 分钟，期间可取消（task-40/41） */
  const handleMaimemoImport = async () => {
    if (!maimemoTransport.canImport) {
      toast.error(maimemoTransport.missingProxyMessage ?? '请先填写代理地址')
      return
    }
    if (!maimemoToken.trim()) {
      toast.error('请先填写墨墨 Token')
      return
    }
    const startedAt = Date.now()
    const handle = createMaimemoAbortHandle()
    maimemoAbortRef.current?.abort()
    maimemoAbortRef.current = handle
    setMaimemoBusy(true)
    setMaimemoError(null)
    setMaimemoResult(null)
    setMaimemoProgress('正在连接墨墨…')
    try {
      await update({
        'data.maimemoToken': maimemoToken.trim(),
        // APK 内置直连不覆盖用户原有代理地址（切回浏览器/PWA 仍可用）
        ...(maimemoTransport.isNative ? {} : { 'data.proxyUrl': maimemoProxy.trim() }),
      })
      const result = await importMaimemoProgress({
        token: maimemoToken.trim(),
        ...(maimemoTransport.isNative ? {} : { proxyUrl: maimemoProxy.trim() }),
        signal: handle.signal,
        // task-40 新语义：scanned=已扫描词数、total=总词数（不是导入记录数）
        onProgress: (scanned, total) =>
          setMaimemoProgress(
            formatMaimemoScanProgress(scanned, total, { startedAt, now: Date.now() }),
          ),
      })
      const summary = formatMaimemoSummary(result)
      setMaimemoProgress('导入完成')
      setMaimemoResult(summary)
      if (result.ok) toast.success(summary.summary)
      else toast.error(summary.summary)
    } catch (error) {
      const cancelled = isMaimemoCancelled(error as { code?: string })
      if (cancelled) {
        // 用户主动取消：静默，不 toast 错误
        setMaimemoProgress('导入已取消（未写入任何数据）')
        setMaimemoError(null)
        return
      }
      setMaimemoProgress(null)
      const message = describeMaimemoFailure(
        error as { code?: string; message?: string },
        maimemoTransport.transport,
        (code) => maimemoMessageFor(code as MaimemoErrorCode),
      )
      setMaimemoError(message)
      toast.error(message)
    } finally {
      maimemoAbortRef.current = null
      setMaimemoBusy(false)
    }
  }

  /** 取消在途导入 */
  const handleCancelMaimemo = () => {
    if (!maimemoAbortRef.current) return
    setMaimemoProgress('正在取消…')
    maimemoAbortRef.current.abort()
  }

  const handleCloseMaimemo = () => {
    if (maimemoBusy) maimemoAbortRef.current?.abort()
    setMaimemoOpen(false)
  }

  const actionItems = actionRow
    ? [
        { label: '设为在学词库', onSelect: () => void handleSetCurrent(actionRow) },
        {
          label: '重命名',
          onSelect: () => {
            setRenameValue(actionRow.deck.name)
            setRenameRow(actionRow)
          },
        },
        { label: '导出词库（含版权说明）', onSelect: () => void handleExport(actionRow) },
        { label: '删除词库', danger: true, onSelect: () => setDeleteRow(actionRow) },
      ]
    : []

  return (
    <PageShell
      title="词库"
      actions={
        <>
          <IconButton label="新建词库" onClick={() => setCreateOpen(true)}>
            <PlusIcon size={22} />
          </IconButton>
          <IconButton label="导入词库" onClick={() => void handlePickImport()}>
            <UploadIcon size={22} />
          </IconButton>
        </>
      }
    >
      {loading ? <div className="mm-loading">正在加载词库…</div> : null}

      {!loading && rows.length === 0 ? (
        <Card>
          <EmptyState
            title="还没有词库"
            description="新建一个词库、导入 JSON/CSV 词库，或从墨墨导入学习数据。"
            action={
              <div className="mm-btn-row" style={{ width: '100%' }}>
                <Button variant="primary" onClick={() => setCreateOpen(true)}>
                  新建词库
                </Button>
                <Button onClick={() => void handlePickImport()}>导入词库</Button>
              </div>
            }
          />
        </Card>
      ) : null}

      {!loading && currentRow ? (
        <>
          <SectionBand title="当前在学" />
          <Card onClick={() => navigate(`/decks/${currentRow.deck.id}`)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div className="mm-row-title">{currentRow.deck.name}</div>
                <div className="mm-row-sub">
                  {currentRow.progress.wordCount} 词 · 已学 {currentRow.progress.studiedCount} ·{' '}
                  {Math.round(currentRow.progress.progress * 100)}%
                </div>
              </div>
              <span className="mm-badge mm-badge--soft">在学</span>
            </div>
            <div className="mm-progress mm-progress--thin">
              <div
                className="mm-progress-fill"
                style={{ width: `${Math.round(currentRow.progress.progress * 100)}%` }}
              />
            </div>
            {currentRow.deck.license ? (
              <div className="mm-caption">{currentRow.deck.license}</div>
            ) : null}
          </Card>
        </>
      ) : null}

      {!loading && rows.length > 0 ? (
        <>
          <SectionBand title={`全部词库（${rows.length}）`} />
          <div className="mm-list">
            {rows.map((row) => (
              <div key={row.deck.id} style={{ display: 'flex', alignItems: 'stretch' }}>
                <Link
                  to={`/decks/${row.deck.id}`}
                  className="mm-row"
                  style={{ borderBottom: '1px solid var(--mm-divider)' }}
                >
                  <span className="mm-row-main">
                    <span className="mm-row-title">{row.deck.name}</span>
                    <span className="mm-row-sub">
                      {row.progress.wordCount} 词 · 已学 {row.progress.studiedCount} · 到期{' '}
                      {row.progress.dueCount}
                      {row.deck.id === currentRow?.deck.id ? ' · 当前在学' : ''}
                    </span>
                  </span>
                  <span className="mm-chevron">›</span>
                </Link>
                <button
                  type="button"
                  className="mm-icon-btn"
                  aria-label={`更多：${row.deck.name}`}
                  onClick={() => setActionRow(row)}
                  style={{ alignSelf: 'center' }}
                >
                  <MoreIcon size={20} />
                </button>
              </div>
            ))}
          </div>

          <div className="mm-btn-row" style={{ marginTop: 16 }}>
            <Button variant="soft" onClick={() => void handlePickImport()}>
            导入词库
          </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setMaimemoError(null)
                setMaimemoResult(null)
                setMaimemoProgress(null)
                setMaimemoOpen(true)
              }}
            >
              从墨墨导入
            </Button>
          </div>
        </>
      ) : null}

      <ActionSheet
        open={actionRow != null}
        title={actionRow?.deck.name}
        items={actionItems}
        onClose={() => setActionRow(null)}
      />

      <Dialog
        open={createOpen}
        title="新建词库"
        onClose={() => setCreateOpen(false)}
        actions={
          <>
            <Button onClick={() => setCreateOpen(false)}>取消</Button>
            <Button variant="primary" onClick={() => void handleCreate()} disabled={busy}>
              创建
            </Button>
          </>
        }
      >
        <label className="mm-field">
          <span className="mm-field-label">词库名称</span>
          <input
            className="mm-input"
            value={createName}
            maxLength={64}
            placeholder="如：考研英语词汇"
            onChange={(event) => setCreateName(event.target.value)}
            autoFocus
          />
        </label>
      </Dialog>

      <Dialog
        open={renameRow != null}
        title="重命名词库"
        onClose={() => setRenameRow(null)}
        actions={
          <>
            <Button onClick={() => setRenameRow(null)}>取消</Button>
            <Button variant="primary" onClick={() => void handleRename()} disabled={busy}>
              保存
            </Button>
          </>
        }
      >
        <label className="mm-field">
          <span className="mm-field-label">词库名称</span>
          <input
            className="mm-input"
            value={renameValue}
            maxLength={64}
            onChange={(event) => setRenameValue(event.target.value)}
            autoFocus
          />
        </label>
      </Dialog>

      <ConfirmDialog
        open={deleteRow != null}
        title="删除词库？"
        body={
          deleteRow
            ? `将删除「${deleteRow.deck.name}」及其全部单词、学习状态与记录，无法恢复。`
            : ''
        }
        confirmLabel="删除"
        danger
        busy={busy}
        onCancel={() => setDeleteRow(null)}
        onConfirm={() => void handleDelete()}
      />

      <Dialog
        open={maimemoOpen}
        title="从墨墨导入"
        onClose={handleCloseMaimemo}
        dismissable={false}
        actions={
          <>
            <Button onClick={handleCloseMaimemo} disabled={false}>
              关闭
            </Button>
            {maimemoBusy ? (
              <Button variant="danger" onClick={handleCancelMaimemo}>
                取消导入
              </Button>
            ) : (
              <Button
                variant="primary"
                onClick={() => void handleMaimemoImport()}
                disabled={maimemoToken.trim().length === 0 || !maimemoTransport.canImport}
              >
                开始导入
              </Button>
            )}
          </>
        }
      >
        <div
          className="mm-caption"
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            background: 'var(--mm-primary-soft)',
            color: 'var(--mm-primary-text)',
          }}
        >
          <strong>{maimemoTransport.modeLabel}</strong>
          <br />
          {maimemoTransport.modeDescription}
          <br />
          {maimemoTransport.privacyText}
        </div>
        <label className="mm-field">
          <span className="mm-field-label">墨墨个人 Token（必填，仅存本机）</span>
          <input
            className="mm-input"
            type="password"
            value={maimemoToken}
            placeholder="墨墨 App → 我的 → 更多设置 → 实验功能 → 开放 API 复制"
            onChange={(event) => setMaimemoToken(event.target.value)}
          />
        </label>
        {maimemoTransport.showProxyInput ? (
          <label className="mm-field">
            <span className="mm-field-label">本地代理地址（浏览器/PWA 需要）</span>
            <input
              className="mm-input"
              value={maimemoProxy}
              placeholder="http://127.0.0.1:8787"
              onChange={(event) => setMaimemoProxy(event.target.value)}
            />
          </label>
        ) : null}
        {maimemoTransport.proxyHint ? (
          <div className="mm-caption">{maimemoTransport.proxyHint}</div>
        ) : null}
        {maimemoTransport.missingProxyMessage ? (
          <div className="mm-caption mm-danger-text">{maimemoTransport.missingProxyMessage}</div>
        ) : null}
        <div className="mm-caption">
          按词库扫描，约需 1 分钟；进度显示「已扫描词数 / 总词数」，期间可随时取消。
        </div>
        {maimemoProgress ? <div className="mm-caption">{maimemoProgress}</div> : null}
        {maimemoResult ? (
          <div className={maimemoResult.ok ? 'mm-caption' : 'mm-caption mm-danger-text'}>
            {maimemoResult.summary}
          </div>
        ) : null}
        {maimemoError ? <div className="mm-caption mm-danger-text">{maimemoError}</div> : null}
        <button
          type="button"
          className="mm-btn mm-btn--ghost"
          onClick={() => void handleMaimemoFileImport()}
          disabled={maimemoBusy}
        >
          或从墨墨导出文件导入（JSON）
        </button>
        <div className="mm-caption">
          Token 约 7 天有效；墨墨拿不到的释义/助记/持久度会按 SPEC 映射规则降级处理。进度只写本机，不上传。
        </div>
      </Dialog>
    </PageShell>
  )
}
