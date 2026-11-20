import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { appendWordsToTodayPlan, getWordsByChapter } from '../../data'
import type { WordWithFamiliarity } from '../../data'
import { useToast } from '../../app/toast'
import { PageShell } from '../components/PageShell'
import { Dialog } from '../components/Dialog'
import { EmptyState } from '../components/EmptyState'

const PAGE_SIZE = 50
type Filter = 'all' | 'learned' | 'new'

export default function UnitDetailPage() {
  const { deckId = '', chapter = '' } = useParams()
  const chapterName = decodeURIComponent(chapter)
  const toast = useToast()
  const [filter, setFilter] = useState<Filter>('all')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<WordWithFamiliarity[]>([])
  const [total, setTotal] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void getWordsByChapter({ deckId, chapter: chapterName, filter, query, page, pageSize: PAGE_SIZE }).then(
      (result) => {
        if (!alive) return
        setRows(result.words)
        setTotal(result.total)
      },
    )
    return () => {
      alive = false
    }
  }, [deckId, chapterName, filter, query, page])

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))

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
    <PageShell title={chapterName} backTo={`/decks/${deckId}/units`}>
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
      <div className="mm-caption">共 {total} 词 · 已选 {selected.length}</div>
      {rows.length === 0 ? (
        <EmptyState title="没有单词" description="换个筛选或搜索词试试。" />
      ) : (
        <div className="mm-list">
          {rows.map(({ word, state, familiarity }) => (
            <label className="mm-row" key={word.id}>
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
              <input
                type="checkbox"
                aria-label={`选择 ${word.headword}`}
                checked={selected.includes(word.id)}
                onChange={() => toggle(word.id)}
              />
            </label>
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
      {selected.length > 0 ? (
        <div className="unit-pick-bar">
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => setConfirmOpen(true)}>
            抽这些词复习（{selected.length}）
          </button>
        </div>
      ) : null}
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
