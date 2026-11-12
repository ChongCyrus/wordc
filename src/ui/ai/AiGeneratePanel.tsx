import { useEffect, useState } from 'react'
import type { GenerationKind } from '../../data/ai'
import {
  aiErrorMessage,
  pickAiFailureMessage,
  summarizeAiFailures,
  aiKindLabel,
  formatDeckOption,
  AI_CONTENT_KIND_OPTIONS,
  AI_EXCLUDE_OPTIONS,
  AI_SCOPE_OPTIONS,
  formatAiBudget,
  formatAiProgress,
  formatAiSummary,
  withAiTimeout,
  AI_EMPTY_TARGET_MESSAGE,
  type AiExcludeKey,
  type AiScope,
  type AiGenerationMode,
  AI_MODE_OPTIONS,
  AI_SEMANTICS_MODE_OPTIONS,
} from '../../app/hooks/aiUi'
import {
  appendGenerationDraftItems,
  applyApproved,
  approveItems,
  clearContentForReplace,
  clearGenerationDraft,
  createGenerationDraft,
  listGenerationDrafts,
  updateGenerationDraftCursor,
  computeChecksum,
  generateItems,
  getSettings,
  getWord,
  getWordsPage,
  importContentPack,
  pendingGenerationTargetsPage,
  listPackItems,
  loadAiSettings,
  rejectGeneratedItem,
  stableStringify,
  toCoreMnemonicType,
  type ContentKind,
  type PackItemV1,
} from '../../data'
import { useDecks } from '../../app/hooks/useDecks'
import {
  AI_BATCH_CONTINUE_STOP_LABEL,
  AI_BATCH_LIMIT_OPTIONS,
  batchSizeForLimit,
  draftResumeMessage,
  formatDraftProgress,
  isDraftComplete,
  type AiBatchLimit,
} from '../../app/hooks/aiDraft'
import { useToast } from '../../app/toast'
import { Dialog } from '../components/Dialog'

export interface AiGenerateViewProps {
  scope: AiScope
  kinds: GenerationKind[]
  excludes: AiExcludeKey[]
  targetCount: number
  estimateText: string
  budgetText: string
  running: boolean
  progress: { done: number; total: number; costYuan: number } | null
  summary: string | null
  error: string | null
  onScope: (scope: AiScope) => void
  onToggleKind: (kind: GenerationKind) => void
  onToggleExclude: (key: AiExcludeKey) => void
  onStart: () => void
  onCancel: () => void
  onClose: () => void
  decks?: Array<{ id: string; name: string; wordCount: number }>
  targetDeckId?: string
  onDeck?: (deckId: string) => void
  customSearch?: string
  onCustomSearch?: (value: string) => void
  customWords?: Array<{ id: string; headword: string }>
  customTotal?: number
  selectedWordIds?: string[]
  truncated?: boolean
  onToggleWord?: (wordId: string) => void
  onSelectAll?: () => void
  onInvert?: () => void
  onClearSelected?: () => void
  batchLimit?: AiBatchLimit
  onBatchLimit?: (limit: AiBatchLimit) => void
  modes?: Partial<Record<GenerationKind, AiGenerationMode>>
  onMode?: (kind: GenerationKind, mode: AiGenerationMode) => void
  wordMeanings?: Array<{ index: number; cn: string; pos?: string }>
  selectedMeaningIndexes?: number[]
  onToggleMeaning?: (index: number) => void
  replaceNotice?: string | null
  draftMessage?: string | null
  onResumeDraft?: () => void
  onDiscardDraft?: () => void
}

/** 批量生成面板（纯展示；task-71） */
export function AiGenerateView({
  scope,
  kinds,
  excludes,
  targetCount,
  estimateText,
  budgetText,
  running,
  progress,
  summary,
  error,
  onScope,
  onToggleKind,
  onToggleExclude,
  onStart,
  onCancel,
  onClose,
  decks = [],
  targetDeckId = '',
  onDeck,
  customSearch = '',
  onCustomSearch,
  customWords = [],
  customTotal = 0,
  selectedWordIds = [],
  truncated = false,
  onToggleWord,
  onSelectAll,
  onInvert,
  onClearSelected,
  batchLimit = 100,
  onBatchLimit,
  modes = {},
  onMode,
  wordMeanings = [],
  selectedMeaningIndexes = [],
  onToggleMeaning,
  replaceNotice,
  draftMessage,
  onResumeDraft,
  onDiscardDraft,
}: AiGenerateViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {draftMessage ? (
        <div className="mm-caption" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span>{draftMessage}</span>
          {onResumeDraft ? (
            <button type="button" className="mm-btn" onClick={onResumeDraft} disabled={running}>
              继续
            </button>
          ) : null}
          {onDiscardDraft ? (
            <button type="button" className="mm-btn mm-btn--danger" onClick={onDiscardDraft} disabled={running}>
              放弃草稿
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="mm-caption">本次生成上限</div>
      <div className="mm-btn-row">
        {AI_BATCH_LIMIT_OPTIONS.map((option) => (
          <button
            key={String(option.value)}
            type="button"
            className={`mm-btn${batchLimit === option.value ? ' mm-btn--primary' : ''}`}
            aria-pressed={batchLimit === option.value}
            onClick={() => onBatchLimit?.(option.value)}
            disabled={running}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mm-caption">范围</div>
      <div className="mm-btn-row">
        {AI_SCOPE_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            className={`mm-btn${scope === option.value ? ' mm-btn--primary' : ''}`}
            onClick={() => onScope(option.value)}
            disabled={running}
          >
            {option.label}
          </button>
        ))}
      </div>

      {scope === 'meanings' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div className="mm-caption">选择含义（可多选）</div>
          {wordMeanings.length === 0 ? (
            <div className="mm-caption">当前词没有可生成的含义</div>
          ) : (
            <div className="mm-list">
              {wordMeanings.map((meaning) => (
                <label key={meaning.index} className="mm-row">
                  <input
                    type="checkbox"
                    aria-label={`选择含义 c${meaning.index}`}
                    checked={selectedMeaningIndexes.includes(meaning.index)}
                    onChange={() => onToggleMeaning?.(meaning.index)}
                    disabled={running}
                  />
                  <span className="mm-row-main">
                    c{meaning.index}{meaning.pos ? ` ${meaning.pos}` : ''} {meaning.cn}
                  </span>
                </label>
              ))}
            </div>
          )}
          {selectedMeaningIndexes.length === 0 ? (
            <div className="mm-caption">请至少选择一个含义</div>
          ) : null}
        </div>
      ) : null}

      {scope === 'deck-select' || scope === 'custom' ? (
        <div className="mm-list">
          {decks.map((deck) => (
            <button
              key={deck.id}
              type="button"
              className={`mm-row${targetDeckId === deck.id ? ' is-active' : ''}`}
              aria-pressed={targetDeckId === deck.id}
              onClick={() => onDeck?.(deck.id)}
              disabled={running}
            >
              <span className="mm-row-main">
                {formatDeckOption(deck.name, deck.wordCount)}
              </span>
              {targetDeckId === deck.id ? <span className="mm-caption">已选</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      {scope === 'custom' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className="mm-input"
            aria-label="搜索单词"
            placeholder="搜索单词或输入字母前缀"
            value={customSearch}
            onChange={(event) => onCustomSearch?.(event.target.value)}
            disabled={running}
          />
          <div className="mm-caption">
            已选 {selectedWordIds.length} / 共 {customTotal}（单次 ≤500）
            {truncated ? ' · 已截断，分批生成' : ''}
          </div>
          <div className="mm-btn-row">
            <button type="button" className="mm-btn" onClick={onSelectAll} disabled={running}>
              全选筛选结果
            </button>
            <button type="button" className="mm-btn" onClick={onInvert} disabled={running}>
              反选
            </button>
            <button type="button" className="mm-btn" onClick={onClearSelected} disabled={running}>
              清空已选
            </button>
          </div>
          {customWords.length === 0 && !customSearch.trim() ? (
            <div className="mm-caption">请先选择词库或输入搜索/字母前缀</div>
          ) : null}
          <div style={{ maxHeight: 180, overflowY: 'auto' }} className="mm-list">
            {customWords.map((word) => (
              <label key={word.id} className="mm-row">
                <input
                  type="checkbox"
                  aria-label={`选择 ${word.headword}`}
                  checked={selectedWordIds.includes(word.id)}
                  onChange={() => onToggleWord?.(word.id)}
                  disabled={running}
                />
                <span className="mm-row-main">{word.headword}</span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mm-caption">生成类型（可多选）</div>
      <div className="mm-btn-row">
        {AI_CONTENT_KIND_OPTIONS.map((option) => {
          const active = kinds.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              className={`mm-btn${active ? ' mm-btn--primary' : ''}`}
              aria-pressed={active}
              onClick={() => onToggleKind(option.value)}
              disabled={running}
            >
              {active ? '✓ ' : ''}
              {option.label}
            </button>
          )
        })}
      </div>

      <div className="mm-caption">生成模式（按类型）</div>
      {kinds.map((kind) => (
        <div key={kind} className="mm-row">
          <span className="mm-row-main">{aiKindLabel(kind)}</span>
          <select
            className="mm-input"
            aria-label={`${aiKindLabel(kind)}生成模式`}
            value={modes[kind] ?? 'missing'}
            onChange={(event) => onMode?.(kind, event.target.value as AiGenerationMode)}
            disabled={running}
          >
            {(kind === 'semantics' ? AI_SEMANTICS_MODE_OPTIONS : AI_MODE_OPTIONS).map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      ))}

      <div className="mm-caption">排除</div>
      <div className="mm-btn-row">
        {AI_EXCLUDE_OPTIONS.map((option) => {
          const active = excludes.includes(option.value)
          return (
            <button
              key={option.value}
              type="button"
              className={`mm-btn${active ? ' mm-btn--primary' : ''}`}
              aria-pressed={active}
              onClick={() => onToggleExclude(option.value)}
              disabled={running}
            >
              {active ? '✓ ' : ''}
              {option.label}
            </button>
          )
        })}
      </div>

      <div className="mm-caption">
        目标：{targetCount} 个词/含义 · {kinds.map(aiKindLabel).join(' / ') || '未选类型'}
      </div>
      <div className="mm-caption">{budgetText}</div>
      <div className="mm-caption">{estimateText}</div>

      {/* 空目标提示（空词库 / 已全部有内容或被排除） */}
      {targetCount === 0 && !running ? (
        <div className="mm-caption">{AI_EMPTY_TARGET_MESSAGE}</div>
      ) : null}
      {/* semantics 只对多含义词生成；单含义词数据层直接跳过 */}
      {kinds.includes('semantics') && !running ? (
        <div className="mm-caption">本义链仅对多含义词生成（单含义词跳过）</div>
      ) : null}

      {progress ? <div className="mm-caption">{formatAiProgress(progress.done, progress.total, progress.costYuan)}</div> : null}
      {summary ? <div className="mm-caption">{summary}</div> : null}
      {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}
      {replaceNotice ? <div className="mm-caption mm-danger-text">{replaceNotice}</div> : null}

      <div className="mm-btn-row">
        {running ? (
          <button type="button" className="mm-btn mm-btn--danger" onClick={onCancel}>
            取消生成
          </button>
        ) : (
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            onClick={onStart}
            disabled={targetCount === 0 || kinds.length === 0}
          >
            开始生成
          </button>
        )}
        <button type="button" className="mm-btn" onClick={onClose} disabled={running}>
          关闭
        </button>
      </div>
    </div>
  )
}

export interface AiReviewItem {
  key: string
  headword: string
  kindLabel: string
  lines: string[]
}

export interface AiReviewDialogProps {
  open: boolean
  items: AiReviewItem[]
  selected: ReadonlySet<string>
  /** 未注入落库接口时禁用保存 */
  canApply: boolean
  onToggle: (key: string) => void
  onToggleAll: (selected: boolean) => void
  onApply: () => void
  onReject: (key: string) => void
  onClose: () => void
  /** task-107：覆盖模式提示（保存前明确告知将替换） */
  replaceNotice?: string | null
  /** 落库应用成功后回调（如重载当前词刷新注释面/w-c） */
  onApplied?: () => void
}

/** 审核对话框（✓/❌；task-71；落库由外部 onApply 注入） */
export function AiReviewDialog({
  open,
  items,
  selected,
  canApply,
  onToggle,
  onToggleAll,
  onApply,
  onReject,
  onClose,
  replaceNotice,
}: AiReviewDialogProps) {
  if (!open) return null
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.key))
  return (
    <Dialog
      open={open}
      title={`审核生成内容（${items.length}）`}
      onClose={onClose}
      dismissable={false}
      actions={
        <>
          <button type="button" className="mm-btn" onClick={() => onToggleAll(!allSelected)}>
            {allSelected ? '全不选' : '全选'}
          </button>
          <button
            type="button"
            className="mm-btn mm-btn--primary"
            disabled={!canApply || selected.size === 0}
            onClick={onApply}
          >
            保存已选（{selected.size}）
          </button>
          <button type="button" className="mm-btn" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      {replaceNotice ? <div className="mm-caption mm-danger-text">{replaceNotice}</div> : null}
      {!canApply ? (
        <div className="mm-caption">落库接口尚未接通：当前仅预览，保存按钮在 packs.repo 就绪后启用。</div>
      ) : (
        <div className="mm-caption">✓ 选中后保存到本地词库；❌ 会记住并排除该目标。</div>
      )}
      <div className="mm-list">
        {items.map((item) => (
          <div key={item.key} className="mm-row">
            <label className="mm-row-main" style={{ display: 'flex', gap: 8 }}>
              <input
                type="checkbox"
                aria-label={`选择 ${item.headword}`}
                checked={selected.has(item.key)}
                onChange={() => onToggle(item.key)}
              />
              <span>
                <span className="mm-row-title">
                  {item.headword} · {item.kindLabel}
                </span>
                {item.lines.map((line) => (
                  <span key={line} className="mm-row-sub" style={{ display: 'block' }}>
                    {line}
                  </span>
                ))}
              </span>
            </label>
            <button
              type="button"
              className="mm-btn mm-btn--ghost"
              aria-label={`拒绝 ${item.headword}`}
              onClick={() => onReject(item.key)}
            >
              ❌
            </button>
          </div>
        ))}
      </div>
    </Dialog>
  )
}

function keyOf(entry: { kind: GenerationKind; target: { headwordLower: string; meaningIndex?: number } }): string {
  return `${entry.kind}:${entry.target.headwordLower}#${entry.target.meaningIndex ?? ''}`
}

export function itemLines(kind: GenerationKind, item: PackItemV1): string[] {
  if (kind === 'semantics') {
    const semantics = item as unknown as {
      coreSenses?: Array<{ index?: number; label: string; confidence?: string; note?: string }>
      meaningMap?: Array<{ meaningIndex: number; coreSenseIndex: number; note?: string; steps?: string[] }>
    }
    const lines: string[] = []
    for (const sense of semantics.coreSenses ?? []) {
      lines.push(`本义${sense.index ?? ''} 「${sense.label}」${sense.confidence ? `（${sense.confidence}）` : ''}`)
    }
    for (const mapping of semantics.meaningMap ?? []) {
      const chain = mapping.steps?.length ? mapping.steps.join(' → ') : (mapping.note ?? '')
      lines.push(`c${mapping.meaningIndex} → 本义${mapping.coreSenseIndex}${chain ? `：${chain}` : ''}`)
    }
    return lines
  }
  if (kind === 'examples') return (item.examples ?? []).map((example) => `${example.en} — ${example.cn}`)
  if (kind === 'phrases') return (item.phrases ?? []).map((phrase) => `${phrase.en} — ${phrase.cn}`)
  return (item.mnemonics ?? []).map((mnemonic) => `[${mnemonic.type}] ${mnemonic.text}`)
}

export interface AiGeneratePanelProps {
  open: boolean
  /** 当前词/含义入口预填 */
  initialScope?: AiScope
  currentWordId?: string
  currentMeaningIndex?: number
  onClose: () => void
  /** 落库应用成功后回调（如重载当前词刷新注释面/w-c） */
  onApplied?: () => void
}

/** 批量生成容器：buildTargets → generateItems → 审核 → onApplyApproved */
export function AiGeneratePanel({
  open,
  initialScope = 'today',
  currentWordId,
  currentMeaningIndex,
  onClose,
  onApplied,
}: AiGeneratePanelProps) {
  const toast = useToast()
  const { decks } = useDecks()
  const [scope, setScope] = useState<AiScope>(currentWordId ? 'word' : initialScope)
  const [targetDeckId, setTargetDeckId] = useState<string>('')
  const [customSearch, setCustomSearch] = useState('')
  const [customWords, setCustomWords] = useState<Array<{ id: string; headword: string }>>([])
  const [customTotal, setCustomTotal] = useState(0)
  const [selectedWordIds, setSelectedWordIds] = useState<string[]>([])
  const [truncated, setTruncated] = useState(false)
  const [promptVersion, setPromptVersion] = useState('v1')
  const [batchLimit, setBatchLimit] = useState<AiBatchLimit>(100)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [draftDone, setDraftDone] = useState(0)
  const [draftTotal, setDraftTotal] = useState(0)
  const [draftCursor, setDraftCursor] = useState(0)
  const [draftPrompt, setDraftPrompt] = useState<{ id: string; done: number; total: number } | null>(null)
  const [discardConfirm, setDiscardConfirm] = useState(false)
  const [kinds, setKinds] = useState<GenerationKind[]>(['examples'])
  const [excludes, setExcludes] = useState<AiExcludeKey[]>(['rejected'])
  const [targetCount, setTargetCount] = useState(0)
  const [budgetText, setBudgetText] = useState('')
  const [estimateText, setEstimateText] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; costYuan: number } | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<AiReviewItem[]>([])
  const [pending, setPending] = useState<Array<{ kind: GenerationKind; mode: AiGenerationMode; target: { wordId: string; headwordLower: string; meaningIndex?: number }; item: PackItemV1 }>>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [controller, setController] = useState<AbortController | null>(null)
  const [modes, setModes] = useState<Record<GenerationKind, AiGenerationMode>>({
    examples: 'missing', phrases: 'missing', mnemonics: 'missing', semantics: 'missing',
  })
  const [selectedMeaningIndexes, setSelectedMeaningIndexes] = useState<number[]>([])
  const [wordMeanings, setWordMeanings] = useState<Array<{ index: number; cn: string; pos?: string }>>([])
  let canceled = false

  useEffect(() => {
    if (!open) return
    void (async () => {
      const drafts = await listGenerationDrafts()
      const usable = drafts.filter((draft) => draft.done > 0)
      // 空草稿（0/0）自动清理，避免幽灵横幅
      for (const empty of drafts.filter((draft) => !usable.includes(draft))) {
        await clearGenerationDraft(empty.id)
      }
      const first = usable[0]
      if (first) {
        const meta = first.meta
        setDraftPrompt({
          id: first.id,
          done: first.done,
          total: meta.targetTotal,
        })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open || !currentWordId) {
      setWordMeanings([])
      return
    }
    void (async () => {
      const word = await getWord(currentWordId)
      setWordMeanings(
        (word?.meanings ?? []).map((meaning, index) => ({
          index: index + 1,
          cn: meaning.cn,
          ...(meaning.pos ? { pos: meaning.pos } : {}),
        })),
      )
    })()
  }, [open, currentWordId])

  useEffect(() => {
    if (scope !== 'custom' || !targetDeckId) return
    void (async () => {
      const page = await getWordsPage(targetDeckId, { search: customSearch.trim(), limit: 100 })
      setCustomWords(page.words.map((word) => ({ id: word.id, headword: word.headword })))
      setCustomTotal(page.total)
    })()
  }, [scope, targetDeckId, customSearch])

  const targetScope = async () => {
    if (scope === 'meanings') {
      return { kind: 'meanings' as const, wordId: currentWordId!, meaningIndexes: selectedMeaningIndexes }
    }
    if (scope === 'word') {
      return currentMeaningIndex == null
        ? { kind: 'word' as const, wordId: currentWordId! }
        : { kind: 'meaning' as const, wordId: currentWordId!, meaningIndex: currentMeaningIndex }
    }
    if (scope === 'today') return { kind: 'today' as const }
    if (scope === 'deck-select') {
      const settings = await getSettings()
      return { kind: 'deck' as const, deckId: targetDeckId || settings['data.selectedDeckId'] }
    }
    if (scope === 'custom') {
      if (selectedWordIds.length > 0) return { kind: 'words' as const, wordIds: selectedWordIds }
      return { kind: 'prefix' as const, deckId: targetDeckId || 'kaoyan-2027-dagang', prefix: customSearch.trim() }
    }
    const settings = await getSettings()
    return { kind: 'deck' as const, deckId: settings['data.selectedDeckId'] }
  }

  /** 按 kind 汇总待生成目标（默认只补缺 + 排除已拒绝） */
  const buildTargetsByKind = async (selected: GenerationKind[]) => {
    const sc = await targetScope()
    const entries: Array<{
      kind: GenerationKind
      mode: AiGenerationMode
      targets: Awaited<ReturnType<typeof pendingGenerationTargetsPage>>['targets']
    }> = []
    for (const kind of selected) {
      const mode: AiGenerationMode = modes[kind] ?? 'missing'
      const page = await pendingGenerationTargetsPage(sc as never, kind as ContentKind, { mode }, {
        offset: 0,
        limit: 500,
      })
      setTruncated(page.truncated)
      entries.push({ kind, targets: page.targets, mode })
    }
    return entries
  }

  const refreshEstimate = async () => {
    setError(null)
    try {
      // 指定含义但未勾选：目标数应为 0/请选择含义
      if (scope === 'meanings' && selectedMeaningIndexes.length === 0) {
        setTargetCount(0)
        setEstimateText('请先勾选要生成的含义（c）')
        return
      }
      const settings = await loadAiSettings()
      const groups = await buildTargetsByKind(kinds)
      const targets = groups.flatMap((group) => group.targets)
      setTargetCount(targets.length)
      setBudgetText(
        `预计费用按所选类型 × 目标数估算；单次上限 ${settings.config.maxCostPerRun > 0 ? `¥${settings.config.maxCostPerRun.toFixed(2)}` : '不限'}；全量预算 ¥${settings.pregenBudget}`,
      )
      setEstimateText(formatAiBudget(0, settings.config.maxCostPerRun))
    } catch (err) {
      setError(aiErrorMessage((err as { code?: string })?.code, '读取生成目标失败'))
    }
  }

  useEffect(() => {
    void refreshEstimate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, targetDeckId, customSearch, selectedWordIds, kinds, modes, batchLimit, selectedMeaningIndexes])

  const handleStart = () => {
    void (async () => {
      setError(null)
      setSummary(null)
      setRunning(true)
      const nextController = new AbortController()
      setController(nextController)
      try {
        if (scope === 'word' && !currentWordId) {
          setError('当前没有选中单词，无法生成')
          return
        }
        if (scope === 'meanings' && (!currentWordId || selectedMeaningIndexes.length === 0)) {
          setError('请至少选择一个含义后再生成')
          return
        }
        const settings = await loadAiSettings()
        if (!settings.enabled) throw Object.assign(new Error('disabled'), { code: 'AI_DISABLED' })
        if (!settings.config.apiKey) throw Object.assign(new Error('no key'), { code: 'AI_NO_KEY' })
        const groups = await buildTargetsByKind(kinds)
        const pairs = groups.flatMap((group) =>
          group.targets.map((target) => ({ kind: group.kind, target, mode: group.mode })),
        )
        if (pairs.length === 0) {
          setSummary('没有需要生成的目标（已排除已有内容/已拒绝）')
          return
        }
        const total = pairs.length
        setProgress({ done: 0, total, costYuan: 0 })
        // 草稿：没有则创建；续跑从 cursor 开始
        let activeDraftId = draftId
        let startCursor = draftCursor
        if (!activeDraftId) {
          const draft = await createGenerationDraft({
            scope: await targetScope(),
            kind: kinds,
            name: `AI 生成 ${new Date().toLocaleString('zh-CN')}`,
          })
          activeDraftId = draft.id
          startCursor = 0
          setDraftId(draft.id)
          setDraftDone(0)
          setDraftCursor(0)
        }
        setDraftTotal(total)
        const batchSize = batchSizeForLimit(batchLimit, total - startCursor)
        const slice = pairs.slice(startCursor, startCursor + batchSize)
        const allItems: PackItemV1[] = []
        const allEntries: typeof pending = []
        const allResults: AiReviewItem[] = []
        const errorCodes: Array<string | undefined> = []
        let done = 0
        let cost = 0
        let cursor = startCursor
        for (const group of groups) {
          const groupPairs = slice.filter((pair) => pair.kind === group.kind)
          if (groupPairs.length === 0) continue
          const kind = group.kind
          const res = await withAiTimeout(generateItems({
            kind,
            targets: groupPairs.map((pair) => pair.target) as never,
            config: settings.config,
            signal: nextController.signal,
            onProgress: (p) => {
              done = p.done
              cost = p.costYuan
              setProgress({ done, total, costYuan: cost })
            },
          }), { onTimeout: () => nextController.abort() })
          cost = res.costYuan
          if (res.promptVersion) setPromptVersion(res.promptVersion)
          for (const result of res.results) {
            if (!result.item) {
              errorCodes.push(result.error?.code)
              continue
            }
            allItems.push(result.item)
            allEntries.push({ kind, mode: group.mode, target: result.target as never, item: result.item })
            allResults.push({
              key: keyOf({ kind, target: result.target }),
              headword: result.target.headword,
              kindLabel: aiKindLabel(kind),
              lines: itemLines(kind, result.item),
            })
          }
          const appendItems = res.results
            .filter((result) => result.item)
            .map((result) => ({
              headwordLower: result.target.headwordLower,
              ...(result.target.meaningIndex != null ? { meaningIndex: result.target.meaningIndex } : {}),
              payload: result.item!,
            }))
          if (appendItems.length > 0 && activeDraftId) {
            const appended = await appendGenerationDraftItems(activeDraftId, appendItems)
            setDraftDone(appended.done)
          }
          if (res.canceled) {
            canceled = true
            break
          }
          cursor += groupPairs.length
          if (activeDraftId) {
            await updateGenerationDraftCursor(activeDraftId, { cursor, targetTotal: total })
            setDraftCursor(cursor)
          }
        }
        setPending(allEntries)
        // task-117：失败/超时且 0 条目 → 清理空生成草稿（取消时保留）
        if (allItems.length === 0 && activeDraftId && !canceled) {
          try { await clearGenerationDraft(activeDraftId) } catch { /* ignore */ }
          setDraftId(null)
          setDraftDone(0)
          setDraftTotal(0)
          setDraftCursor(0)
        }
        // QA S18 P2：402/429/408 等不能只显示「失败 N 条」，要展示分类文案
        if (canceled) {
          setSummary(`已取消，草稿已保存：${formatDraftProgress(done, total)}`)
          return
        }
        if (!isDraftComplete(cursor, total)) {
          setSummary(
            `${formatDraftProgress(done, total)} · 本次已达上限 ${batchLimit === 'all' ? '全部' : batchLimit}，可点「${AI_BATCH_CONTINUE_STOP_LABEL}」/重新打开继续`,
          )
          return
        }
        const failureSummary = summarizeAiFailures(errorCodes)
        const fatalMessage = pickAiFailureMessage(errorCodes)
        if (failureSummary) {
          setSummary((prev) => (prev ? `${prev} · ${failureSummary}` : failureSummary))
        }
        if (fatalMessage && (allItems.length === 0 || errorCodes.some((code) => code != null))) {
          setError(fatalMessage)
        }
        setItems(allResults)
        setSelected(new Set(allResults.map((item) => item.key)))
        const failed = total - allItems.length
        setSummary(
          formatAiSummary({
            total,
            succeeded: allItems.length,
            failed: Math.max(0, failed),
            canceled,
            costYuan: cost,
          }),
        )
      } catch (err) {
        const code = (err as { code?: string })?.code
        if (code === 'AI_CANCELED') {
          setSummary('已取消。')
        } else {
          const message = aiErrorMessage(code, '生成失败，请稍后重试')
          setError(message)
          toast.error(message)
        }
      } finally {
        setRunning(false)
        setController(null)
        setProgress(null)
      }
    })()
  }

  const handleApply = () => {
    void (async () => {
      try {
        const selectedEntries = pending.filter((entry) => selected.has(keyOf(entry)))
        if (selectedEntries.length === 0) return
        const kindsUsed = [...new Set(selectedEntries.map((entry) => entry.kind))] as GenerationKind[]
        const packKind = kindsUsed.length === 1 ? kindsUsed[0] : 'mixed'
        const items = selectedEntries.map((entry) => ({
          ...entry.item,
          ...(entry.item.mnemonics
            ? {
                mnemonics: entry.item.mnemonics.map((mnemonic) => ({
                  type: toCoreMnemonicType(mnemonic.type),
                  text: mnemonic.text,
                })),
              }
            : {}),
        }))
        const checksum = await computeChecksum(
          stableStringify({ format: 'momo-pack', formatVersion: 1, kind: packKind, items }),
        )
        const settings = await loadAiSettings()
        const packFile = {
          format: 'momo-pack',
          formatVersion: 1,
          kind: packKind,
          createdAt: Date.now(),
          generator: 'wordc-ai',
          items,
          checksum: checksum.hex,
          meta: {
            name: 'AI 生成',
            source: 'ai',
            provider: settings.config.provider,
            model: settings.config.model,
            promptVersion,
            checksumAlgo: checksum.algo,
          },
        }
        const imported = await importContentPack(JSON.stringify(packFile))
        if (!imported.ok || !imported.packId) {
          throw new Error(imported.issues?.[0]?.message ?? '内容包导入失败')
        }
        const replaceEntries = selectedEntries.filter((entry) => entry.mode === 'replace')
        if (replaceEntries.length > 0) {
          const wordIds = [...new Set(replaceEntries.map((entry) => entry.target.wordId))]
          const kinds = [...new Set(replaceEntries.map((entry) => entry.kind))]
          await clearContentForReplace(wordIds, kinds as never)
        }
        const records = await listPackItems(imported.packId)
        const pendingIds = records.filter((record) => record.status === 'pending').map((record) => record.id)
        await approveItems(imported.packId, pendingIds)
        const applied = await applyApproved(imported.packId)
        toast.success(`已应用 ${applied.applied} 条生成内容（跳过 ${applied.skipped}）`)
        if (draftId) await clearGenerationDraft(draftId)
        onApplied?.()
        onClose()
        setItems([])
        setPending([])
      } catch (err) {
        toast.error(err instanceof Error ? err.message : '保存生成内容失败')
      }
    })()
  }

  return (
    <>
      <Dialog open={open} title="AI 扩充内容" onClose={onClose} dismissable={false}>
        <AiGenerateView
          scope={scope}
          decks={decks.map((deck) => ({ id: deck.id, name: deck.name, wordCount: (deck as { wordCount?: number }).wordCount ?? 0 }))}
          targetDeckId={targetDeckId}
          onDeck={(deckId) => setTargetDeckId(deckId)}
          customSearch={customSearch}
          onCustomSearch={setCustomSearch}
          customWords={customWords}
          customTotal={customTotal}
          selectedWordIds={selectedWordIds}
          truncated={truncated}
          onToggleWord={(wordId) =>
            setSelectedWordIds((prev) =>
              prev.includes(wordId) ? prev.filter((id) => id !== wordId) : [...prev, wordId],
            )
          }
          onSelectAll={() => setSelectedWordIds(customWords.map((word) => word.id))}
          onInvert={() =>
            setSelectedWordIds((prev) =>
              customWords.map((word) => word.id).filter((id) => !prev.includes(id)),
            )
          }
          onClearSelected={() => setSelectedWordIds([])}
          batchLimit={batchLimit}
          onBatchLimit={setBatchLimit}
          modes={modes}
          onMode={(kind, mode) => setModes((prev) => ({ ...prev, [kind]: mode }))}
          wordMeanings={wordMeanings}
          selectedMeaningIndexes={selectedMeaningIndexes}
          onToggleMeaning={(index) =>
            setSelectedMeaningIndexes((prev) =>
              prev.includes(index) ? prev.filter((item) => item !== index) : [...prev, index],
            )
          }
          draftMessage={
            !open
              ? null
              : draftPrompt && !draftId
                ? draftResumeMessage(draftPrompt.done, draftPrompt.total)
                : draftId && (draftDone > 0 || running)
                  ? formatDraftProgress(draftDone, draftTotal)
                  : null
          }
          onResumeDraft={() => {
            if (!draftPrompt) return
            setDraftId(draftPrompt.id)
            setDraftCursor(draftPrompt.done)
            setDraftDone(draftPrompt.done)
            setDraftTotal(draftPrompt.total)
            setDraftPrompt(null)
          }}
          onDiscardDraft={() => setDiscardConfirm(true)}
          kinds={kinds}
          excludes={excludes}
          targetCount={targetCount}
          estimateText={estimateText}
          budgetText={budgetText}
          running={running}
          progress={progress}
          summary={summary}
          error={error}
          onScope={(next) => {
            setScope(next)
            void refreshEstimate()
          }}
          onToggleKind={(kind) =>
            setKinds((prev) =>
              prev.includes(kind) ? prev.filter((item) => item !== kind) : [...prev, kind],
            )
          }
          onToggleExclude={(key) =>
            setExcludes((prev) =>
              prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key],
            )
          }
          onStart={handleStart}
          onCancel={() => controller?.abort()}
          onClose={onClose}
        />
      </Dialog>
      <Dialog
        open={discardConfirm}
        title="放弃草稿？"
        onClose={() => setDiscardConfirm(false)}
        actions={
          <>
            <button type="button" className="mm-btn" onClick={() => setDiscardConfirm(false)}>
              取消
            </button>
            <button
              type="button"
              className="mm-btn mm-btn--danger"
              onClick={() => {
                void (async () => {
                  if (draftPrompt?.id ?? draftId) {
                    await clearGenerationDraft((draftPrompt?.id ?? draftId)!)
                  }
                  setDraftId(null)
                  setDraftCursor(0)
                  setDraftDone(0)
                  setDraftTotal(0)
                  setDraftPrompt(null)
                  setDiscardConfirm(false)
                })()
              }}
            >
              放弃
            </button>
          </>
        }
      >
        <div className="mm-caption">放弃后未生成的草稿会删除，已应用内容不受影响。</div>
      </Dialog>

      <AiReviewDialog
        open={items.length > 0 && !running}
        items={items}
        selected={selected}
        canApply
        onToggle={(key) =>
          setSelected((prev) => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            return next
          })
        }
        onToggleAll={(value) =>
          setSelected(value ? new Set(items.map((item) => item.key)) : new Set())
        }
        onApply={handleApply}
        replaceNotice={pending.some((entry) => entry.mode === 'replace') ? '覆盖模式：保存后将替换已选词对应类型的内容（旧内容被清空后写入新内容）' : null}
        onReject={(key) => {
          const entry = pending.find((candidate) => keyOf(candidate) === key)
          if (entry) void rejectGeneratedItem(entry.item)
          setItems((prev) => prev.filter((item) => item.key !== key))
          setPending((prev) => prev.filter((candidate) => keyOf(candidate) !== key))
          setSelected((prev) => {
            const next = new Set(prev)
            next.delete(key)
            return next
          })
          toast.success('已拒绝该条（后续生成会排除）')
        }}
        onClose={() => {
          setItems([])
          setPending([])
        }}
      />
    </>
  )
}
