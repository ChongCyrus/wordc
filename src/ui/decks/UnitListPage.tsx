import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { getDeckChapters, getDeckProgressLocation } from '../../data'
import type { DeckChapterSummary, DeckProgressLocation } from '../../data'
import { PageShell } from '../components/PageShell'
import { SectionBand } from '../components/SectionBand'
import { EmptyState } from '../components/EmptyState'

export default function UnitListPage() {
  const { deckId = '' } = useParams()
  const [chapters, setChapters] = useState<DeckChapterSummary[]>([])
  const [location, setLocation] = useState<DeckProgressLocation | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void Promise.all([getDeckChapters(deckId), getDeckProgressLocation(deckId)])
      .then(([list, loc]) => {
        if (!alive) return
        setChapters(list)
        setLocation(loc)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [deckId])

  return (
    <PageShell title="按单元" backTo={`/decks/${deckId}`}>
      {location?.lastLearnedChapter ? (
        <div className="mm-caption unit-location">
          当前：{location.lastLearnedChapter} · 已学 {location.learnedInChapter}/{location.chapterTotal}
        </div>
      ) : null}
      <SectionBand title={`单元（${chapters.length}）`} />
      {loading ? (
        <div className="mm-caption">加载中…</div>
      ) : chapters.length === 0 ? (
        <EmptyState title="暂无单元" description="该词库没有可浏览的单元。" />
      ) : (
        <div className="mm-list">
          {chapters.map((chapter) => (
            <Link
              key={chapter.chapter}
              className="mm-row"
              to={`/decks/${encodeURIComponent(deckId)}/units/${encodeURIComponent(chapter.chapter)}`}
            >
              <span className="mm-row-main">
                <span className="mm-row-title">{chapter.chapter}</span>
                <span className="mm-row-sub">
                  {chapter.total} 词 · 已学 {chapter.learned} · 未学 {chapter.newCount} · 到期 {chapter.dueCount}
                  {chapter.avgFamiliarity != null ? ` · 平均不熟悉 ${Math.round(chapter.avgFamiliarity * 100)}%` : ''}
                </span>
              </span>
            </Link>
          ))}
        </div>
      )}
    </PageShell>
  )
}
