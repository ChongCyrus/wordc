import { useEffect, useState } from 'react'
import type { DeckChapterSummary, Word } from '../../data'
import {
  appendNewWordsToTodayPlan,
  getDeckChapters,
  getManualNewWordCandidateIds,
  getManualNewWordCandidates,
  getTodayPlan,
  pickUnlearnedNewWords,
  removeUnlearnedAutoNewWords,
} from '../../data'
import { useSettings } from '../../app/hooks/useSettings'
import { useToast } from '../../app/toast'
import { Dialog } from '../components/Dialog'
import { BulkSelectToolbar } from '../components/BulkSelectToolbar'

type Mode = 'manual' | 'random' | 'order'
type PendingAction = 'keep' | 'remove-then-add' | 'remove-only'

export function AddTodayWordsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast()
  const { settings } = useSettings()
  const deckId = settings?.['data.selectedDeckId'] ?? ''
  const [mode, setMode] = useState<Mode>('manual')
  const [countInput, setCountInput] = useState('20')
  const [query, setQuery] = useState('')
  const [chapter, setChapter] = useState('')
  const [sort, setSort] = useState<'order' | 'alpha' | 'due' | 'familiarity'>('order')
  const [chapters, setChapters] = useState<DeckChapterSummary[]>([])
  const [candidates, setCandidates] = useState<Word[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [planOpen, setPlanOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [planHasWords, setPlanHasWords] = useState(false)

  useEffect(() => {
    if (!open) return
    setSelected([])
    setQuery('')
    setChapter('')
    setPlanHasWords(false)
    if (!deckId) return
    void getDeckChapters(deckId)
      .then(setChapters)
      .catch(() => setChapters([]))
  }, [open, deckId])

  useEffect(() => {
    if (!open || mode !== 'manual' || !deckId) return
    let alive = true
    void getManualNewWordCandidates({ query, chapter: chapter || undefined, sort, limit: 200, offset: 0 }).then(
      (result) => alive && setCandidates(result.words),
    )
    return () => {
      alive = false
    }
  }, [open, mode, deckId, query, chapter, sort])

  const parsedCount = () => {
    const value = Number.parseInt(countInput, 10)
    if (!Number.isFinite(value) || value < 1) return 20
    return Math.min(999, value)
  }

  const commitCount = () => {
    if (countInput.trim() === '') {
      setCountInput('20')
      return
    }
    const value = Number.parseInt(countInput, 10)
    setCountInput(String(Number.isFinite(value) ? Math.min(999, Math.max(1, value)) : 20))
  }

  const selectAllManual = async () => {
    const ids = await getManualNewWordCandidateIds({ query, chapter: chapter || undefined, sort, max: 999 })
    setSelected(ids)
    if (ids.length >= 999) toast.error('最多批量选择 999 个词')
  }

  const invertManual = async () => {
    const ids = await getManualNewWordCandidateIds({ query, chapter: chapter || undefined, sort, max: 999 })
    setSelected(ids.filter((id) => !selected.includes(id)))
  }

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))

  const doAppend = async (action: PendingAction) => {
    setBusy(true)
    try {
      if (action !== 'keep') {
        const removed = await removeUnlearnedAutoNewWords()
        if (action === 'remove-only') {
          toast.success(`已移除 ${removed.removed} 个未学自动新词`)
          onClose()
          return
        }
        if (removed.removed > 0) toast.success(`已移除 ${removed.removed} 个未学自动新词`)
      }
      let result
      if (mode === 'manual') {
        result = await appendNewWordsToTodayPlan({ wordIds: selected, mode: 'manual' })
      } else {
        result = await appendNewWordsToTodayPlan({ mode, count: parsedCount() })
      }
      toast.success(
        `已追加 ${result.added} 个新词到今日计划${
          result.plan.index >= result.plan.wordIds.length ? '，可继续学习' : ''
        }`,
      )
      onClose()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '添加今日新词失败')
    } finally {
      setBusy(false)
      setPlanOpen(false)
    }
  }

  const submit = async () => {
    if (!deckId) {
      toast.error('请先选择词库')
      return
    }
    if (mode === 'manual' && selected.length === 0) {
      toast.error('请先勾选单词')
      return
    }
    if (mode === 'manual') {
      const picked = candidates.filter((word) => selected.includes(word.id))
      if (picked.length === 0) {
        toast.error('所选单词已不在候选中，请刷新')
        return
      }
    } else {
      const picked = await pickUnlearnedNewWords({ deckId, count: parsedCount(), mode })
      if (picked.length === 0) {
        toast.error('当前词库没有可添加的未学单词')
        return
      }
    }
    try {
      const plan = await getTodayPlan({ deckId })
      if (plan.wordIds.length > 0) {
        setPlanHasWords(true)
        setPlanOpen(true)
      } else {
        await doAppend('keep')
      }
    } catch {
      await doAppend('keep')
    }
  }

  return (
    <>
      <Dialog
        open={open && !planOpen}
        title="添加今日新单词"
        onClose={() => {
          if (!busy) onClose()
        }}
        actions={
          <>
            <button type="button" className="mm-btn" disabled={busy} onClick={onClose}>
              取消
            </button>
            <button type="button" className="mm-btn mm-btn--primary" disabled={busy} onClick={() => void submit()}>
              添加
            </button>
          </>
        }
      >
        <div className="mm-btn-row add-word-modes">
          {(
            [
              ['manual', '手动筛选'],
              ['random', '随机选择'],
              ['order', '顺序选择'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`mm-btn mm-btn--sm${mode === value ? ' mm-btn--primary' : ''}`}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === 'manual' ? (
          <>
            <BulkSelectToolbar
              query={query}
              onQueryChange={setQuery}
              searchLabel="搜索未学单词"
              sort={sort}
              sortOptions={[
                { value: 'order', label: '词库顺序' },
                { value: 'alpha', label: '字母 A-Z' },
                { value: 'familiarity', label: '不熟悉度' },
                { value: 'due', label: '到期时间' },
              ]}
              onSortChange={setSort}
              selectedCount={selected.length}
              total={candidates.length}
              onSelectAll={() => void selectAllManual()}
              onInvert={() => void invertManual()}
              onClear={() => setSelected([])}
              extra={
                <select
                  className="mm-input bulk-toolbar-select"
                  aria-label="选择单元"
                  value={chapter}
                  onChange={(event) => setChapter(event.target.value)}
                >
                  <option value="">全部单元</option>
                  {chapters.map((item) => (
                    <option key={item.chapter} value={item.chapter}>
                      {item.chapter}（{item.newCount} 未学）
                    </option>
                  ))}
                </select>
              }
            />
            <div className="mm-list add-word-candidates">
              {candidates.map((word) => (
                <label className="mm-row" key={word.id}>
                  <span className="mm-row-main">
                    <span className="mm-row-title">{word.headword}</span>
                    <span className="mm-row-sub">
                      {word.meanings.map((meaning) => meaning.cn).slice(0, 2).join('；')}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`选择 ${word.headword}`}
                    checked={selected.includes(word.id)}
                    onChange={() => toggle(word.id)}
                  />
                </label>
              ))}
            </div>
          </>
        ) : (
          <div className="mm-input-row">
            <label className="mm-caption" htmlFor="add-word-count">
              数量
            </label>
            <input
              id="add-word-count"
              className="mm-input"
              type="number"
              min={1}
              max={999}
              value={countInput}
              inputMode="numeric"
              onChange={(event) => setCountInput(event.target.value)}
              onBlur={commitCount}
              onKeyDown={(event) => {
                if (event.key === 'Enter') commitCount()
              }}
            />
          </div>
        )}
      </Dialog>
      <Dialog
        open={planOpen}
        title="已有今日计划"
        onClose={() => setPlanOpen(false)}
        actions={
          <button type="button" className="mm-btn" disabled={busy} onClick={() => setPlanOpen(false)}>
            取消
          </button>
        }
      >
        <div className="mm-caption">今日计划已有内容，请选择处理方式（{planHasWords ? '已学词/复习词不会删除' : ''}）：</div>
        <div className="mm-list">
          <button type="button" className="mm-row" disabled={busy} onClick={() => void doAppend('keep')}>
            保留今日计划并追加
          </button>
          <button type="button" className="mm-row" disabled={busy} onClick={() => void doAppend('remove-then-add')}>
            移除今天未学的自动新词后追加
          </button>
          <button type="button" className="mm-row" disabled={busy} onClick={() => void doAppend('remove-only')}>
            仅移除未学的自动新词
          </button>
        </div>
      </Dialog>
    </>
  )
}
