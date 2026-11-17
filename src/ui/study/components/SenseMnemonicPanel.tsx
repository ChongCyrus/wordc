import { useEffect, useRef, useState } from 'react'
import { Dialog } from '../../components/Dialog'
import { SenseMnemonicBatchPanel } from './SenseMnemonicBatchPanel'
import { withTimeout } from '../lib/with-timeout'
import { Stepper } from '../../components/Stepper'
import { aiErrorMessage } from '../../../app/hooks/aiUi'
import {
  applySenseMnemonicSuggestions,
  clearAllSenseMnemonics,
  clearSenseMnemonic,
  collectSenseMnemonicSources,
  generateSenseMnemonic,
  generateSenseMnemonicBatch,
  clearCoreSenseOverview,
  getCoreSenseOverview,
  getEffectiveContent,
  getWord,
  generateCoreSenseOverview,
  listSenseMnemonics,
  listSenseMnemonicViews,
  loadAiConfig,
  saveCoreSenseOverview,
  saveSenseMnemonic,
  type SenseMnemonic,
  type SenseMnemonicSuggestion,
  type SenseMnemonicView,
} from '../../../data'
import {
  buildSenseMnemonicViews,
  type SenseCoreLike,
} from '../lib/sense-mnemonic-views'

/** task-200：注释面「本义助记·本义N：…」文案 */
export function senseMnemonicLabel(coreSenseIndex: number, label: string): string {
  return `本义助记·本义${coreSenseIndex}「${label}」`
}

/** task-205：点击行打开编辑器时回填——已保存助记优先，其次未应用的 AI 建议 */
export function senseEditorInitialText(
  mnemonicText: string | undefined,
  suggestionText: string | undefined,
): string {
  return (mnemonicText ?? suggestionText ?? '').trim()
}

export function SenseMnemonicPanel({
  open,
  wordId,
  word,
  coreSenses = [],
  initialEditIndex,
  onClose,
  onChanged,
}: {
  open: boolean
  wordId: string
  word: string
  coreSenses?: SenseCoreLike[]
  initialEditIndex?: number | null
  onClose: () => void
  onChanged?: () => void
}) {
  const [views, setViews] = useState<SenseMnemonicView[]>([])
  const [stale, setStale] = useState<SenseMnemonic[]>([])
  const [suggestions, setSuggestions] = useState<Record<number, string>>({})
  const [overwriteAi, setOverwriteAi] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [savedStatus, setSavedStatus] = useState<string | null>(null)
  const [migrateTo, setMigrateTo] = useState<Record<string, number>>({})
  const [batchOpen, setBatchOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const initialResultRef = useRef<ReturnType<typeof buildSenseMnemonicViews> | null>(null)
  const [overviewText, setOverviewText] = useState('')
  const [overviewSuggestion, setOverviewSuggestion] = useState<string | null>(null)
  const [overviewBusy, setOverviewBusy] = useState(false)
  const [overviewError, setOverviewError] = useState<string | null>(null)
  const [genProgress, setGenProgress] = useState({ done: 0, total: 0, succeeded: 0, failed: 0, inFlight: 0 })
  const [genStatus, setGenStatus] = useState<Record<number, 'running' | 'ok' | 'error'>>({})
  const [concurrency, setConcurrency] = useState(2)
  // task-214：本义助记 AI 生成默认排除已标不常考的本义（会话级，不持久）
  const [excludeRareCoreSenses, setExcludeRareCoreSenses] = useState(true)
  const genControllerRef = useRef<AbortController | null>(null)
  const [editor, setEditor] = useState<null | {
    coreSenseIndex: number
    label: string
    text: string
    busy?: boolean
    error?: string | null
  }>(null)

  // task-205：coreSenses 每次父渲染可能是新数组，用稳定 label key 防止 effect 重跑重置 loading
  const coreSensesKey = coreSenses.map((sense) => sense.label).join('|')

  const load = async () => {
    setLoading(true)
    try {
      // task-205：绕过可能挂起的 listSenseMnemonicViews，直接读原始字段 + 本地匹配
      const stored = await withTimeout(
        listSenseMnemonics(wordId),
        8_000,
        '读取本义助记超时（8s），请重试',
      )
      let result = buildSenseMnemonicViews(coreSenses, stored)
      // 兜底：部分旧 v3 applied pack 下 StudyPage 的 coreSenses 可能暂为空/未就绪；
      // 此时回退到 repo 的 effective 视图（含 coreSenses 合并逻辑），避免面板误报「暂无本义数据」。
      if (result.current.length === 0) {
        try {
          const remote = await withTimeout(
            listSenseMnemonicViews(wordId),
            4_000,
            '读取本义视图超时',
          )
          if (remote.current.length > 0) {
            result = {
              current: remote.current.map((view) => ({
                coreSenseIndex: view.coreSenseIndex,
                label: view.label,
                ...(view.gloss ? { gloss: view.gloss } : {}),
                ...(view.origin ? { origin: view.origin } : {}),
                ...(view.mnemonic ? { mnemonic: view.mnemonic } : {}),
                ...(view.match ? { match: view.match } : {}),
              })),
              stale: remote.stale,
            }
          }
        } catch {
          // 保持本地结果；若 repo 也失败继续用 getEffectiveContent 兜底
        }
      }
      // 第二层兜底：直接读 effective coreSenses 再本地匹配（某些旧 v3 fixture 下 views 可能为空）
      if (result.current.length === 0) {
        try {
          const effective = await withTimeout(
            getEffectiveContent(wordId),
            4_000,
            '读取本义数据超时',
          )
          const effectiveSenses = (effective?.coreSenses ?? [])
            .filter((sense) => Boolean(sense.label))
            .map((sense) => ({
              label: sense.label,
              ...(sense.note ? { note: sense.note } : {}),
              ...(sense.origin ? { origin: sense.origin } : {}),
            }))
          if (effectiveSenses.length > 0) {
            result = buildSenseMnemonicViews(effectiveSenses, stored)
          }
        } catch {
          // 保持空态；错误/超时由外层 error 展示
        }
      }
      initialResultRef.current = result
      try {
        const overview = await getCoreSenseOverview(wordId)
        setOverviewText(overview?.text ?? '')
      } catch {
        setOverviewText('')
      }
    setViews(result.current)
    setStale(result.stale)
    setSuggestions({})
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    setError(null)
    setSavedStatus(null)
    void load()
      .then(() => {
        if (initialEditIndex == null) return
        const view = initialResultRef.current?.current.find(
          (item) => item.coreSenseIndex === initialEditIndex,
        )
        if (view) {
          setEditor({
            coreSenseIndex: view.coreSenseIndex,
            label: view.label,
            text: view.mnemonic?.text ?? '',
          })
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : '读取本义助记失败'))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, wordId, coreSensesKey])

  const sourceFor = async (coreSenseIndex: number) => {
    const sources = await collectSenseMnemonicSources({ scope: 'word', wordId }, { includeExisting: true })
    return sources.find((source) => source.coreSenseIndex === coreSenseIndex)
  }

  const generateAll = async () => {
    setBusy(true)
    setError(null)
    setGenStatus({})
    const controller = new AbortController()
    genControllerRef.current = controller
    try {
      const config = await loadAiConfig()
      if (!config.apiKey) throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
      const sources = await collectSenseMnemonicSources(
        { scope: 'word', wordId },
        { includeExisting: false, includeRare: !excludeRareCoreSenses },
      )
      if (sources.length === 0) {
        setError(
          excludeRareCoreSenses
            ? '可生成本义为空（全部已标记不常考或已有助记）；可取消勾选「排除不常考本义」后重试'
            : '没有需要生成的本义（本义数据缺失或已全部有助记）',
        )
        return
      }
      setGenProgress({ done: 0, total: sources.length, succeeded: 0, failed: 0, inFlight: 0 })
      setGenStatus(Object.fromEntries(sources.map((source) => [source.coreSenseIndex, 'running'])))
      const result = await generateSenseMnemonicBatch(sources, config, {
        concurrency,
        timeoutMs: 30_000,
        retryTimeoutOnce: true,
        signal: controller.signal,
        onProgress: (p) => {
          setGenProgress({
            done: p.done,
            total: p.total,
            succeeded: p.succeeded,
            failed: p.failed,
            inFlight: p.inFlight,
          })
        },
      })
      const next: Record<number, string> = {}
      const statuses: Record<number, 'ok' | 'error'> = {}
      for (const entry of result.results) {
        const index = entry.source.coreSenseIndex
        if (index == null) continue
        if (!entry.error && entry.mnemonic) {
          next[index] = entry.mnemonic
          statuses[index] = 'ok'
        } else if (entry.errorKind !== 'canceled') {
          statuses[index] = 'error'
        }
      }
      setSuggestions(next)
      setGenStatus(statuses)
      // 共享生成入口：一并生成串联记忆预览（失败不阻断助记结果）
      setOverviewBusy(true)
      setOverviewError(null)
      try {
        const [effective, wordRow] = await Promise.all([
          getEffectiveContent(wordId),
          getWord(wordId),
        ])
        const source = {
          word,
          coreSenses: (effective?.coreSenses ?? [])
            .filter((sense) => Boolean(sense.label))
            .map((sense) => ({
              index: sense.index,
              label: sense.label,
              ...(sense.note ? { note: sense.note } : {}),
              ...(sense.origin ? { origin: sense.origin } : {}),
            })),
          mappedMeanings: (effective?.meaningMap ?? []).map((mapping) => ({
            coreSenseIndex: mapping.coreSenseIndex,
            meaningIndex: mapping.meaningIndex,
            cn: wordRow?.meanings?.[mapping.meaningIndex - 1]?.cn ?? '',
            ...(wordRow?.meanings?.[mapping.meaningIndex - 1]?.pos
              ? { pos: wordRow.meanings[mapping.meaningIndex - 1]!.pos }
              : {}),
          })),
        }
        if (source.coreSenses.length > 0) {
          const overview = await generateCoreSenseOverview(source, config)
          setOverviewSuggestion(overview.text)
        }
      } catch (err) {
        setOverviewError(aiErrorMessage((err as { code?: string })?.code, 'AI 生成本义串联记忆失败'))
      } finally {
        setOverviewBusy(false)
      }
      setGenProgress({
        done: sources.length,
        total: sources.length,
        succeeded: Object.keys(next).length,
        failed: Object.values(statuses).filter((status) => status === 'error').length,
        inFlight: 0,
      })
      if (result.canceled) setError('已取消；已生成结果保留，可重试')
      else if (Object.keys(next).length === 0) setError('没有生成可应用的结果')
    } catch (err) {
      setError(aiErrorMessage((err as { code?: string })?.code, 'AI 生成本义助记失败'))
    } finally {
      setBusy(false)
      genControllerRef.current = null
    }
  }

  const cancelGenerateAll = () => {
    genControllerRef.current?.abort()
    setBusy(false)
    setGenProgress((prev) => ({ ...prev, inFlight: 0 }))
  }

  const applySuggestions = async () => {
    const list: SenseMnemonicSuggestion[] = views
      .map((view) => {
        const text = (suggestions[view.coreSenseIndex] ?? '').trim()
        return text ? { coreSenseIndex: view.coreSenseIndex, label: view.label, text } : null
      })
      .filter((item): item is SenseMnemonicSuggestion => Boolean(item))
    if (list.length === 0) return
    setBusy(true)
    setError(null)
    try {
      const overviewToSave = (overviewSuggestion ?? overviewText).trim()
      if (overviewToSave) {
        await saveCoreSenseOverview(wordId, { text: overviewToSave, source: overviewSuggestion ? 'ai' : 'manual' })
        setOverviewText(overviewToSave)
        setOverviewSuggestion(null)
      }
      const result = await applySenseMnemonicSuggestions(wordId, list, { overwriteAi })
      setSavedStatus(
        `已应用 ${result.applied} · 跳过手改 ${result.skippedManual} · 跳过已有 AI ${result.skippedExisting} · 本义已变化 ${result.stale}`,
      )
      await load()
      onChanged?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : '应用本义助记失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
    <Dialog
      open={open}
      title={`本义助记 · ${word}`}
      overlayClassName="mm-mask--above-rating"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="mm-btn" onClick={onClose} disabled={busy}>
            关闭
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            onClick={() => void applySuggestions()}
            disabled={busy || Object.values(suggestions).every((text) => !text.trim())}
          >
            应用 AI 建议
          </button>
        </>
      }
    >
      <div className="sense-panel">
      <div className="sense-panel-actions">
        <button
          type="button"
          className="mm-btn sense-panel-btn"
          onClick={() => void generateAll()}
          disabled={busy || views.length === 0}
        >
          AI 生成全部
        </button>
        <button type="button" className="mm-btn sense-panel-btn" onClick={() => setBatchOpen(true)}>
          批量生成
        </button>
        {busy ? (
          <button
            type="button"
            className="mm-btn mm-btn--danger sense-panel-btn sense-panel-btn--full"
            onClick={cancelGenerateAll}
          >
            取消生成
          </button>
        ) : null}
      </div>
      <label className="sense-panel-overwrite">
        <input
          type="checkbox"
          checked={overwriteAi}
          onChange={(event) => setOverwriteAi(event.target.checked)}
        />
        <span>覆盖已有 AI 助记（手改永不覆盖）</span>
      </label>
      <label className="sense-panel-overwrite">
        <input
          type="checkbox"
          checked={excludeRareCoreSenses}
          onChange={(event) => setExcludeRareCoreSenses(event.target.checked)}
        />
        <span>排除已标记不常考的本义（默认勾选；单条重新生成仍可手动生成）</span>
      </label>
      <div className="sense-panel-status">
        <div className="sense-status-line">
          {busy || genProgress.done > 0
            ? `生成中 ${genProgress.done} / ${genProgress.total}（成功 ${genProgress.succeeded} · 失败 ${genProgress.failed} · 当前 ${genProgress.inFlight}）`
            : '就绪'}
        </div>
        <div className="sense-status-line">
          <span>生成并发</span>
          <Stepper ariaLabel="本义助记生成并发" value={concurrency} min={2} max={4} onChange={setConcurrency} />
        </div>
      </div>
      {overviewBusy || overviewSuggestion || overviewText ? (
        <div className="sense-panel-overview">
          <div className="sense-panel-overview-title">
            本义串联记忆{overviewSuggestion ? '（AI 建议）' : ''}
          </div>
          <textarea
            className="mm-input"
            aria-label="本义串联记忆"
            rows={3}
            value={overviewSuggestion ?? overviewText}
            onChange={(event) => {
              if (overviewSuggestion) setOverviewSuggestion(event.target.value)
              else setOverviewText(event.target.value)
            }}
            disabled={overviewBusy}
          />
          <div className="mm-btn-row">
            <button
              type="button"
              className="mm-btn mm-btn--sm"
              disabled={overviewBusy || !(overviewSuggestion ?? overviewText).trim()}
              onClick={() =>
                void (async () => {
                  setOverviewBusy(true)
                  setOverviewError(null)
                  try {
                    const text = (overviewSuggestion ?? overviewText).trim()
                    await saveCoreSenseOverview(wordId, {
                      text,
                      source: overviewSuggestion ? 'ai' : 'manual',
                    })
                    setOverviewText(text)
                    setOverviewSuggestion(null)
                    onChanged?.()
                  } catch (err) {
                    setOverviewError(err instanceof Error ? err.message : '保存串联记忆失败')
                  } finally {
                    setOverviewBusy(false)
                  }
                })()
              }
            >
              保存串联记忆
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--sm"
              disabled={overviewBusy}
              onClick={() =>
                void (async () => {
                  setOverviewBusy(true)
                  setOverviewError(null)
                  try {
                    await clearCoreSenseOverview(wordId)
                    setOverviewText('')
                    setOverviewSuggestion(null)
                    onChanged?.()
                  } catch (err) {
                    setOverviewError(err instanceof Error ? err.message : '清空串联记忆失败')
                  } finally {
                    setOverviewBusy(false)
                  }
                })()
              }
            >
              清空
            </button>
          </div>
          {overviewBusy ? <div className="mm-caption">生成中…</div> : null}
          {overviewError ? <div className="mm-caption mm-danger-text">{overviewError}</div> : null}
        </div>
      ) : null}
      {loading ? (
        <div className="mm-caption">正在加载本义助记…（超过 8 秒会提示错误，可重试）</div>
      ) : error ? (
        <div className="mm-caption mm-danger-text">
          {error}
          <button type="button" className="mm-btn mm-btn--sm" onClick={() => void load().catch(() => undefined)}>
            重试
          </button>
        </div>
      ) : views.length === 0 ? (
        <div className="mm-caption">该词暂无本义数据（需先应用本义 pack）。</div>
      ) : (
        <div className="sense-mnemonic-list">
          {views.map((view) => (
            <button
              type="button"
              className="sense-mnemonic-row sense-mnemonic-row--clickable"
              key={view.coreSenseIndex}
              aria-label={`${senseMnemonicLabel(view.coreSenseIndex, view.label)}，${view.mnemonic ? '点击编辑' : '点击添加'}`}
              onClick={() =>
                setEditor({
                  coreSenseIndex: view.coreSenseIndex,
                  label: view.label,
                  text: senseEditorInitialText(
                    view.mnemonic?.text,
                    suggestions[view.coreSenseIndex],
                  ),
                })
              }
            >
              <span className="sense-mnemonic-title">
                本义{view.coreSenseIndex}「{view.label}」
                {view.gloss ? <span className="mm-caption"> · {view.gloss}</span> : null}
                {view.mnemonic ? (
                  <span className="mm-badge">{view.mnemonic.source === 'manual' ? '我的' : 'AI'}</span>
                ) : null}
              </span>
              <span className="sense-mnemonic-text">
                {view.mnemonic
                  ? `${senseMnemonicLabel(view.coreSenseIndex, view.label)}：${view.mnemonic.text}`
                  : '点击添加本义助记'}
              </span>
              {genStatus[view.coreSenseIndex] === 'running' ? (
                <span className="mm-caption">生成中…</span>
              ) : genStatus[view.coreSenseIndex] === 'error' ? (
                <span className="mm-caption mm-danger-text">生成失败，可重试</span>
              ) : null}
              {suggestions[view.coreSenseIndex]?.trim() ? (
                <span className="mm-caption">AI 建议：{suggestions[view.coreSenseIndex]}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
      {stale.length > 0 ? (
        <div className="sense-mnemonic-stale">
          <div className="mm-caption">本义已变化：以下旧助记对不上当前本义，可删除或迁移到当前本义。</div>
          {stale.map((item, index) => (
            <div className="sense-mnemonic-row" key={`${item.coreSenseIndex}-${item.label}-${index}`}>
              <div className="mm-caption">
                本义已变化：旧助记·本义{item.coreSenseIndex}「{item.label}」：{item.text}
              </div>
              <div className="mm-btn-row">
                <button
                  type="button"
                  className="mm-btn mm-btn--sm"
                  onClick={() =>
                    void (async () => {
                      await clearSenseMnemonic(wordId, { coreSenseIndex: item.coreSenseIndex, label: item.label })
                      await load()
                      onChanged?.()
                    })()
                  }
                >
                  删除
                </button>
                <select
                  className="mm-input"
                  style={{ maxWidth: 120 }}
                  aria-label="迁移到本义"
                  value={migrateTo[`${item.coreSenseIndex}-${index}`] ?? views[0]?.coreSenseIndex ?? 1}
                  onChange={(event) =>
                    setMigrateTo((prev) => ({
                      ...prev,
                      [`${item.coreSenseIndex}-${index}`]: Number(event.target.value),
                    }))
                  }
                >
                  {views.map((view) => (
                    <option key={view.coreSenseIndex} value={view.coreSenseIndex}>
                      本义{view.coreSenseIndex}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="mm-btn mm-btn--sm"
                  disabled={views.length === 0}
                  onClick={() =>
                    void (async () => {
                      const target = views.find(
                        (view) =>
                          view.coreSenseIndex ===
                          (migrateTo[`${item.coreSenseIndex}-${index}`] ?? views[0]?.coreSenseIndex),
                      )
                      if (!target) return
                      await saveSenseMnemonic(wordId, {
                        coreSenseIndex: target.coreSenseIndex,
                        label: target.label,
                        text: item.text,
                        source: item.source,
                      })
                      await clearSenseMnemonic(wordId, {
                        coreSenseIndex: item.coreSenseIndex,
                        label: item.label,
                      })
                      await load()
                      onChanged?.()
                    })()
                  }
                >
                  迁移
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
      {savedStatus ? <div className="mm-caption">{savedStatus}</div> : null}
      {views.length > 0 ? (
        <button
          type="button"
          className="mm-btn mm-btn--sm"
          disabled={busy}
          onClick={() =>
            void (async () => {
              await clearAllSenseMnemonics(wordId)
              await load()
              onChanged?.()
            })()
          }
        >
          清除全部本义助记
        </button>
      ) : null}
      </div>
    </Dialog>
    <Dialog
      open={editor != null}
      title={editor ? `本义助记 · 本义${editor.coreSenseIndex}「${editor.label}」` : '本义助记'}
      onClose={() => setEditor(null)}
      actions={
        <>
          <button type="button" className="mm-btn" onClick={() => setEditor(null)} disabled={editor?.busy}>
            取消
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            disabled={editor?.busy || !editor?.text.trim()}
            onClick={() => {
              if (!editor) return
              setEditor({ ...editor, busy: true, error: null })
              void (async () => {
                try {
                  await saveSenseMnemonic(wordId, {
                    coreSenseIndex: editor.coreSenseIndex,
                    label: editor.label,
                    text: editor.text.trim(),
                    source: 'manual',
                  })
                  setEditor(null)
                  setSavedStatus('已保存本义助记')
                  await load()
                  onChanged?.()
                } catch (err) {
                  setEditor((prev) => (prev ? { ...prev, busy: false, error: err instanceof Error ? err.message : '保存失败' } : prev))
                }
              })()
            }}
          >
            保存
          </button>
        </>
      }
    >
      {editor ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <textarea
            className="mm-input"
            aria-label="本义助记内容"
            rows={4}
            value={editor.text}
            onChange={(event) => setEditor({ ...editor, text: event.target.value })}
          />
          <div className="mm-btn-row">
            <button
              type="button"
              className="mm-btn"
              disabled={editor.busy}
              onClick={() => {
                setEditor({ ...editor, busy: true, error: null })
                void (async () => {
                  try {
                    const config = await loadAiConfig()
                    if (!config.apiKey) throw Object.assign(new Error('未配置 AI Key'), { code: 'AI_NO_KEY' })
                    const source = await sourceFor(editor.coreSenseIndex)
                    if (!source) throw new Error('找不到本义数据')
                    const result = await generateSenseMnemonic(source, config)
                    setEditor((prev) => (prev ? { ...prev, text: result.mnemonic, busy: false } : prev))
                  } catch (err) {
                    setEditor((prev) =>
                      prev
                        ? {
                            ...prev,
                            busy: false,
                            error: aiErrorMessage((err as { code?: string })?.code, '生成失败'),
                          }
                        : prev,
                    )
                  }
                })()
              }}
            >
              重新生成
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--danger"
              disabled={editor.busy || !editor.text.trim()}
              onClick={() => {
                setEditor({ ...editor, busy: true, error: null })
                void (async () => {
                  try {
                    await clearSenseMnemonic(wordId, {
                      coreSenseIndex: editor.coreSenseIndex,
                      label: editor.label,
                    })
                    setEditor(null)
                    setSavedStatus('已删除本义助记')
                    await load()
                    onChanged?.()
                  } catch (err) {
                    setEditor((prev) => (prev ? { ...prev, busy: false, error: err instanceof Error ? err.message : '删除失败' } : prev))
                  }
                })()
              }}
            >
              删除
            </button>
          </div>
          {editor.error ? <div className="mm-caption mm-danger-text">{editor.error}</div> : null}
        </div>
      ) : null}
    </Dialog>
    <SenseMnemonicBatchPanel
      open={batchOpen}
      onClose={() => setBatchOpen(false)}
      currentWordId={wordId}
      onApplied={() => {
        void load()
        onChanged?.()
      }}
    />
    </>
  )
}
