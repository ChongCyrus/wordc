import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { appendWordsToTodayPlan, getRankingWordIds, getWordFamiliarityRanking } from '../../data'
import type { WordFamiliarityRankingItem, WordListSort } from '../../data'
import { useSettings } from '../../app/hooks/useSettings'
import { useToast } from '../../app/toast'
import { PageShell } from '../components/PageShell'
import { Dialog } from '../components/Dialog'
import { EmptyState } from '../components/EmptyState'
import { BulkSelectToolbar } from '../components/BulkSelectToolbar'
import { ReviewChoiceDialog } from '../components/ReviewChoiceDialog'

const PAGE_SIZE = 50

export default function RankingPage() {
  const navigate = useNavigate()
  const toast = useToast()
  const { settings } = useSettings()
  const deckId = settings?.['data.selectedDeckId'] ?? ''
  const [order, setOrder] = useState<'unfamiliar' | 'familiar'>('unfamiliar')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<WordListSort>('familiarity')
  const [direction, setDirection] = useState<'asc' | 'desc'>('asc')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<WordFamiliarityRankingItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState<string[]>([])
  const [detail, setDetail] = useState<WordFamiliarityRankingItem | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [choiceOpen, setChoiceOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!deckId) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void getWordFamiliarityRanking({ deckId, order, query, sort, direction, page, pageSize: PAGE_SIZE }).then(
      (result) => {
        if (!alive) return
        setItems(result.items)
        setTotal(result.total)
        setLoading(false)
      },
    )
    return () => {
      alive = false
    }
  }, [deckId, order, query, sort, direction, page])

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]))

  const selectAll = async () => {
    const ids = await getRankingWordIds({ deckId, order, query, max: 999 })
    setSelected(ids)
    if (total > 999) toast.error('最多批量选择 999 个词')
  }

  const invert = async () => {
    const ids = await getRankingWordIds({ deckId, order, query, max: 999 })
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

  const pickTop = () => {
    const ids = items.slice(0, 20).map((item) => item.word.id)
    if (ids.length === 0) {
      toast.error('暂无排行数据')
      return
    }
    setSelected(ids)
    setConfirmOpen(true)
  }

  return (
    <PageShell title="不熟悉度排行" backTo="/stats">
      <div className="mm-btn-row ranking-modes">
        <button
          type="button"
          className={`mm-btn mm-btn--sm${order === 'unfamiliar' ? ' mm-btn--primary' : ''}`}
          onClick={() => {
            setOrder('unfamiliar')
            setPage(1)
          }}
        >
          最不熟
        </button>
        <button
          type="button"
          className={`mm-btn mm-btn--sm${order === 'familiar' ? ' mm-btn--primary' : ''}`}
          onClick={() => {
            setOrder('familiar')
            setPage(1)
          }}
        >
          最熟
        </button>
      </div>
      <BulkSelectToolbar
        query={query}
        onQueryChange={(value) => {
          setQuery(value)
          setPage(1)
        }}
        searchLabel="搜索排行单词"
        sort={sort}
        sortOptions={[
          { value: 'familiarity', label: '不熟悉度' },
          { value: 'order', label: '词库顺序' },
          { value: 'alpha', label: '字母 A-Z' },
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
        selectedCount={selected.length}
        total={total}
        onSelectAll={() => void selectAll()}
        onInvert={() => void invert()}
        onClear={() => setSelected([])}
        onSelectFirstN={async (n) => {
          setSelected(await getRankingWordIds({ deckId, order, query, max: n }))
        }}
        extra={
          <button type="button" className="mm-btn mm-btn--sm" onClick={pickTop}>
            最不熟前 20 一键
          </button>
        }
      />
      {!deckId ? (
        <EmptyState title="未选择词库" description="请先在词库页选择当前词库。" />
      ) : loading ? (
        <div className="mm-loading">正在加载排行…</div>
      ) : items.length === 0 ? (
        <EmptyState title="暂无排行" description="学过的词会按不熟悉度出现在这里。" />
      ) : (
        <div className="mm-list">
          {items.map((item) => (
            <div className="mm-row" key={item.word.id}>
              <input
                type="checkbox"
                aria-label={`选择 ${item.word.headword}`}
                checked={selected.includes(item.word.id)}
                onChange={() => toggle(item.word.id)}
              />
              <button type="button" className="mm-row-main ranking-row" onClick={() => setDetail(item)}>
                <span className="mm-row-title">{item.word.headword}</span>
                <span className="mm-row-sub">
                  {item.familiarity != null ? `不熟悉 ${Math.round(item.familiarity * 100)}%` : '暂无数据'}
                  {' · '}
                  {item.word.meanings.map((meaning) => meaning.cn).slice(0, 2).join('；')}
                </span>
              </button>
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
      {selected.length > 0 ? (
        <div className="unit-pick-bar">
          <button type="button" className="mm-btn mm-btn--primary" onClick={() => setChoiceOpen(true)}>
            抽这些词复习（{selected.length}）
          </button>
        </div>
      ) : null}
      <Dialog
        open={detail != null}
        title={detail?.word.headword ?? '单词详情'}
        onClose={() => setDetail(null)}
        actions={
          <button type="button" className="mm-btn" onClick={() => setDetail(null)}>
            关闭
          </button>
        }
      >
        {detail ? (
          <div className="mm-list">
            {detail.word.meanings.map((meaning) => (
              <div className="mm-row" key={meaning.id}>
                <span className="mm-row-main">
                  <span className="mm-row-title">
                    {meaning.pos ? `[${meaning.pos}] ` : ''}
                    {meaning.cn}
                  </span>
                </span>
              </div>
            ))}
            <div className="mm-caption">
              {detail.familiarity != null ? `平均不熟悉 ${Math.round(detail.familiarity * 100)}%` : '暂无不熟悉度数据'}
            </div>
          </div>
        ) : null}
      </Dialog>
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
          navigate(`/temp-review?words=${selected.join(',')}&recordMode=${mode}&returnTo=${encodeURIComponent('/stats/ranking')}`)
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
        <div className="mm-caption">追加到今日计划末尾，不改每日学习量；计划已完成时追加后可继续学习。</div>
      </Dialog>
    </PageShell>
  )
}
