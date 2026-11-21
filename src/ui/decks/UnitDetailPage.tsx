import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  appendWordsToTodayPlan,
  getChapterWordIds,
  getWordsByChapter,
} from '../../data'
import type { WordWithFamiliarity, WordListSort } from '../../data'
import { useToast } from '../../app/toast'
import { PageShell } from '../components/PageShell'
import { Dialog } from '../components/Dialog'
import { BulkSelectToolbar } from '../components/BulkSelectToolbar'
import { ReviewChoiceDialog } from '../components/ReviewChoiceDialog'
import { AiGeneratePanel } from '../ai/AiGeneratePanel'
import { BatchDerivationPanel } from '../me/BatchDerivationPanel'
import { EmptyState } from '../components/EmptyState'

const PAGE_SIZE = 50
type Filter = 'all' | 'learned' | 'new'

export default function UnitDetailPage() {
  const { deckId = '', chapter = '' } = useParams()
  const chapterName = decodeURIComponent(chapter)
  const navigate = useNavigate()
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<WordListSort>('order')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<WordWithFamiliarity[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [selectMode, setSelectMode] = useState(false)
  const [choiceOpen, setChoiceOpen] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [derivationOpen, setDerivationOpen] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void getWordsByChapter({ deckId, chapter: chapterName, filter, query, sort, direction, page, pageSize: PAGE_SIZE }).then(
      (result) => {
        if (!alive) return
        setRows(result.words)
        setTotal(result.total)
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [deckId, chapterName, filter, query, sort, direction, page])

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))

  const selectAll = async () => {
    const ids = await getChapterWordIds({ deckId, chapter: chapterName, filter, query, sort, direction, max: 999 })
    setSelected(ids)
    if (total > 999) toast.error('最多批量选择 999 个词')
  }

  const invert = async () => {
    const ids = await getChapterWordIds({ deckId, chapter: chapterName, filter, query, sort, direction, max: 999 })
    setSelected(ids.filter((id) => !selected.includes(id)))
  }

  const append = async () => {
    setBusy(true)
    try {
      const result = await appendWordsToTodayPlan({ wordIds: selected, source: 'manual' })
      toast.success(`已追加 ${result.added} 个词到今日计划${result.plan.index >= result.plan.wordIds.length ? '，可继续学习' : ''}`)
      setSelected([])
      setConfirmOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '追加失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <PageShell
      title={chapterName}
      backTo={`/decks/${deckId}/units`}
      actions={
        <button
          type="button"
          className="mm-btn mm-btn--sm"
          onClick={() => {
            setSelectMode((value) => !value)
            setSelected([])
          }}
        >
          {selectMode ? '完成' : '选择'}
        </button>
      }
    >
      {selectMode ? (
        <BulkSelectToolbar
          query={query}
          onQueryChange={(value) => {
            setQuery(value)
            setPage(1)
          }}
          searchLabel="搜索单元单词"
          sort={sort}
          sortOptions={[
            { value: 'order', label: '词库顺序' },
            { value: 'alpha', label: '字母 A-Z' },
            { value: 'familiarity', label: '不熟悉度' },
            { value: 'due', label: '到期时间' },
          ]}
          onSortChange={(value) => {
            setSort(value)
            setPage(1)
          }}
          direction={direction}
          onDirectionChange={(value) => {
            setDirection(value)
            setPage(1)
          }}
          filter={filter}
          filterOptions={[
            { value: 'all', label: '全部' },
            { value: 'learned', label: '已学' },
            { value: 'new', label: '未学' },
          ]}
          onFilterChange={(value) => {
            setFilter(value as Filter)
            setPage(1)
          }}
          selectedCount={selected.length}
          total={total}
          onSelectAll={() => void selectAll()}
          onInvert={() => void invert()}
          onClear={() => setSelected([])}
          onSelectFirstN={async (n) => {
            setSelected(await getChapterWordIds({ deckId, chapter: chapterName, filter, query, sort, direction, max: n }))
          }}
        />
      ) : (
        <>
          <div className="mm-input-row">
            <input
              className="mm-input"
              aria-label="搜索单元单词"
              placeholder="搜索英文/中文"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
            />
          </div>
          <div className="mm-btn-row unit-filter">
            {(
              [
                ['all', '全部'],
                ['learned', '已学'],
                ['new', '未学'],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`mm-btn mm-btn--sm${filter === value ? ' mm-btn--primary' : ''}`}
                onClick={() => {
                  setFilter(value)
                  setPage(1)
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      )}

      {loading ? (
        <div className="mm-loading">正在加载单元单词…</div>
      ) : (
        <>
      <div className="mm-caption">共 {total} 词 · 已选 {selected.length}</div>
      {rows.length === 0 ? (
        <EmptyState title="没有单词" description="换个筛选或搜索词试试。" />
      ) : (
        <div className="mm-list">
          {rows.map(({ word, state, familiarity }) => (
            <div
              className="mm-row"
              key={word.id}
              role={selectMode ? undefined : 'button'}
              tabIndex={selectMode ? undefined : 0}
              onClick={() => {
                if (selectMode) toggle(word.id)
                else
                  navigate(
                    `/study?detailWord=${word.id}&returnTo=${encodeURIComponent(`/decks/${deckId}/units/${encodeURIComponent(chapterName)}`)}&deck=${deckId}`,
                  )
              }}
            >
              <span className="mm-row-main">
                <span className="mm-row-title">{word.headword}</span>
                <span className="mm-row-sub">
                  {word.meanings.map((meaning) => meaning.cn).slice(0, 3).join('；')}
                </span>
              </span>
              <span className="mm-caption">
                {state && state.phase !== 'new' ? '已学' : '未学'}
                {familiarity != null ? ` · ${Math.round(familiarity * 100)}%` : ''}
              </span>
              {selectMode ? (
                <input
                  type="checkbox"
                  aria-label={`选择 ${word.headword}`}
                  checked={selected.includes(word.id)}
                  onChange={() => toggle(word.id)}
                  onClick={(event) => event.stopPropagation()}
                />
              ) : null}
            </div>
          ))}
        </div>
      )}
      <div className="mm-btn-row unit-pager">
        <button type="button" className="mm-btn mm-btn--sm" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
          上一页
        </button>
        <span className="mm-caption">
          {page}/{Math.max(1, Math.ceil(total / PAGE_SIZE))}
        </span>
        <button
          type="button"
          className="mm-btn mm-btn--sm"
          disabled={page >= Math.ceil(total / PAGE_SIZE)}
          onClick={() => setPage((value) => value + 1)}
        >
          下一页
        </button>
      </div>
        </>
      )}
      {selectMode && selected.length > 0 ? (
        <div className="unit-pick-bar">
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => setChoiceOpen(true)}>
            抽这些词复习（{selected.length}）
          </button>
          <button type="button" className="mm-btn" onClick={() => setAiOpen(true)}>
            AI 生成选中词
          </button>
          <button type="button" className="mm-btn" onClick={() => setDerivationOpen(true)}>
            生成引申图
          </button>
        </div>
      ) : null}
      <AiGeneratePanel
        open={aiOpen}
        initialScope="custom"
        initialSelectedWordIds={selected}
        onClose={() => setAiOpen(false)}
      />
      <BatchDerivationPanel
        open={derivationOpen}
        initialWordIds={selected}
        onClose={() => setDerivationOpen(false)}
      />
      <ReviewChoiceDialog
        open={choiceOpen}
        count={selected.length}
        busy={busy}
        onClose={() => setChoiceOpen(false)}
        onAddToPlan={() => {
          setChoiceOpen(false)
          setConfirmOpen(true)
        }}
        onStartTemp={(mode) => {
          setChoiceOpen(false)
          navigate(
            `/temp-review?words=${selected.join(',')}&recordMode=${mode}&returnTo=${encodeURIComponent(`/decks/${deckId}/units/${encodeURIComponent(chapterName)}`)}`,
          )
        }}
      />
      <Dialog
        open={confirmOpen}
        title="抽这些词复习？"
        onClose={() => setConfirmOpen(false)}
        actions={
          <>
            <button type="button" className="mm-btn" disabled={busy} onClick={() => setConfirmOpen(false)}>
              取消
            </button>
            <button type="button" className="mm-btn mm-btn--primary" disabled={busy} onClick={() => void append()}>
              {busy ? '追加中…' : `追加 ${selected.length} 词`}
            </button>
          </>
        }
      >
        <div className="mm-caption">将把所选 {selected.length} 个词追加到今日计划末尾，不改每日学习量。</div>
      </Dialog>
    </PageShell>
  )
}
