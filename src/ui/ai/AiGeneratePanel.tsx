import { useState } from 'react'
import type { SingleContentKind } from '../../data/ai'
import {
  aiErrorMessage,
  pickAiFailureMessage,
  summarizeAiFailures,
  aiKindLabel,
  AI_CONTENT_KIND_OPTIONS,
  AI_EXCLUDE_OPTIONS,
  AI_SCOPE_OPTIONS,
  formatAiBudget,
  formatAiProgress,
  formatAiSummary,
  type AiExcludeKey,
  type AiScope,
} from '../../app/hooks/aiUi'
import {
  applyApproved,
  approveItems,
  computeChecksum,
  generateItems,
  getSettings,
  importContentPack,
  listPackItems,
  loadAiSettings,
  pendingGenerationTargets,
  rejectGeneratedItem,
  stableStringify,
  toCoreMnemonicType,
  type ContentKind,
  type PackItemV1,
} from '../../data'
import { useToast } from '../../app/toast'
import { Dialog } from '../components/Dialog'

export interface AiGenerateViewProps {
  scope: AiScope
  kinds: SingleContentKind[]
  excludes: AiExcludeKey[]
  targetCount: number
  estimateText: string
  budgetText: string
  running: boolean
  progress: { done: number; total: number; costYuan: number } | null
  summary: string | null
  error: string | null
  onScope: (scope: AiScope) => void
  onToggleKind: (kind: SingleContentKind) => void
  onToggleExclude: (key: AiExcludeKey) => void
  onStart: () => void
  onCancel: () => void
  onClose: () => void
  /** 落库应用成功后回调（如重载当前词刷新注释面/w-c） */
  onApplied?: () => void
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
}: AiGenerateViewProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
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

      {progress ? <div className="mm-caption">{formatAiProgress(progress.done, progress.total, progress.costYuan)}</div> : null}
      {summary ? <div className="mm-caption">{summary}</div> : null}
      {error ? <div className="mm-caption mm-danger-text">{error}</div> : null}

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

function keyOf(entry: { kind: SingleContentKind; target: { headwordLower: string; meaningIndex?: number } }): string {
  return `${entry.kind}:${entry.target.headwordLower}#${entry.target.meaningIndex ?? ''}`
}

function itemLines(kind: SingleContentKind, item: PackItemV1): string[] {
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
  const [scope, setScope] = useState<AiScope>(currentWordId ? 'word' : initialScope)
  const [kinds, setKinds] = useState<SingleContentKind[]>(['examples'])
  const [excludes, setExcludes] = useState<AiExcludeKey[]>(['rejected'])
  const [targetCount, setTargetCount] = useState(0)
  const [budgetText, setBudgetText] = useState('')
  const [estimateText, setEstimateText] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number; costYuan: number } | null>(null)
  const [summary, setSummary] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [items, setItems] = useState<AiReviewItem[]>([])
  const [pending, setPending] = useState<Array<{ kind: SingleContentKind; target: { headwordLower: string; meaningIndex?: number }; item: PackItemV1 }>>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [controller, setController] = useState<AbortController | null>(null)
  let canceled = false

  if (!open) return null

  const targetScope = async () => {
    if (scope === 'word') {
      return currentMeaningIndex == null
        ? { kind: 'word' as const, wordId: currentWordId! }
        : { kind: 'meaning' as const, wordId: currentWordId!, meaningIndex: currentMeaningIndex }
    }
    if (scope === 'today') return { kind: 'today' as const }
    const settings = await getSettings()
    return { kind: 'deck' as const, deckId: settings['data.selectedDeckId'] }
  }

  /** 按 kind 汇总待生成目标（默认只补缺 + 排除已拒绝） */
  const buildTargetsByKind = async (selected: SingleContentKind[]) => {
    const sc = await targetScope()
    const entries: Array<{ kind: SingleContentKind; targets: Awaited<ReturnType<typeof pendingGenerationTargets>> }> = []
    for (const kind of selected) {
      const targets = await pendingGenerationTargets(sc as never, kind as ContentKind)
      entries.push({ kind, targets })
    }
    return entries
  }

  const refreshEstimate = async () => {
    try {
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

  const handleStart = () => {
    void (async () => {
      setError(null)
      setSummary(null)
      setRunning(true)
      const nextController = new AbortController()
      setController(nextController)
      try {
        const settings = await loadAiSettings()
        if (!settings.enabled) throw Object.assign(new Error('disabled'), { code: 'AI_DISABLED' })
        if (!settings.config.apiKey) throw Object.assign(new Error('no key'), { code: 'AI_NO_KEY' })
        const groups = await buildTargetsByKind(kinds)
        const allTargets = groups.flatMap((group) => group.targets)
        if (allTargets.length === 0) {
          setSummary('没有需要生成的目标（已排除已有内容/已拒绝）')
          return
        }
        const allItems: PackItemV1[] = []
        const allEntries: typeof pending = []
        const allResults: AiReviewItem[] = []
        const errorCodes: Array<string | undefined> = []
        let done = 0
        let cost = 0
        const total = allTargets.length
        for (const group of groups) {
          if (group.targets.length === 0) continue
          const kind = group.kind
          const res = await generateItems({
            kind,
            targets: group.targets as never,
            config: settings.config,
            signal: nextController.signal,
            onProgress: (p) => {
              done = p.done
              cost = p.costYuan
              setProgress({ done, total, costYuan: cost })
            },
          })
          cost = res.costYuan
          for (const result of res.results) {
            if (!result.item) {
              errorCodes.push(result.error?.code)
              continue
            }
            allItems.push(result.item)
            allEntries.push({ kind, target: result.target, item: result.item })
            allResults.push({
              key: keyOf({ kind, target: result.target }),
              headword: result.target.headword,
              kindLabel: aiKindLabel(kind),
              lines: itemLines(kind, result.item),
            })
          }
          if (res.canceled) {
            canceled = true
            break
          }
        }
        setPending(allEntries)
        // QA S18 P2：402/429/408 等不能只显示「失败 N 条」，要展示分类文案
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
          setError(aiErrorMessage(code, '生成失败，请稍后重试'))
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
        const kindsUsed = [...new Set(selectedEntries.map((entry) => entry.kind))] as SingleContentKind[]
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
            promptVersion: 'v1',
            checksumAlgo: checksum.algo,
          },
        }
        const imported = await importContentPack(JSON.stringify(packFile))
        if (!imported.ok || !imported.packId) {
          throw new Error(imported.issues?.[0]?.message ?? '内容包导入失败')
        }
        const records = await listPackItems(imported.packId)
        const pendingIds = records.filter((record) => record.status === 'pending').map((record) => record.id)
        await approveItems(imported.packId, pendingIds)
        const applied = await applyApproved(imported.packId)
        toast.success(`已应用 ${applied.applied} 条生成内容（跳过 ${applied.skipped}）`)
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
