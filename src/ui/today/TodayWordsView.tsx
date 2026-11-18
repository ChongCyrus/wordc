import { EmptyState } from '../components/EmptyState'
import type { TodayBreakdownView, TodayWordView } from './today-types'
import { groupsOf, wordTags } from './today-types'

export interface TodayWordsViewProps {
  breakdown: TodayBreakdownView
  /** 今日到期超出复习上限而顺延的数量（task-52；>0 时复习区显示说明） */
  reviewBacklog?: number
  /** 点击某词 → 查看单词详情弹层 */
  onSelectWord: (word: TodayWordView) => void
}

function CategorySection({
  title,
  stats,
  words,
  onSelectWord,
}: {
  title: string
  stats: { planned: number; learned: number; remaining: number }
  words: TodayWordView[]
  onSelectWord: (word: TodayWordView) => void
}) {
  return (
    <>
      <div className="mm-section-band">
        <span>
          {title}（{stats.planned}）
        </span>
        <span className="mm-caption">
          已学 {stats.learned} · 未学 {stats.remaining}
        </span>
      </div>
      {words.length === 0 ? (
        <div className="mm-card mm-card--flat">
          <span className="mm-caption">本区暂无单词</span>
        </div>
      ) : (
        <div className="mm-list">
          {words.map((word) => (
            <button
              key={word.wordId}
              type="button"
              className="mm-row"
              onClick={() => onSelectWord(word)}
            >
              <span className="mm-row-main">
                <span className="mm-row-title">{word.headword}</span>
              </span>
              <span className="mm-row-value" style={{ display: 'flex', gap: 6 }}>
                {wordTags(word).map((tag) => (
                  <span
                    key={`${tag.kind}-${tag.label}`}
                    className={`mm-badge${
                      tag.kind === 'rating'
                        ? ' mm-badge--soft'
                        : tag.kind === 'extra'
                          ? ' mm-badge--soft'
                          : ' mm-badge--muted'
                    }`}
                  >
                    {tag.label}
                  </span>
                ))}
              </span>
              <span className="mm-chevron">›</span>
            </button>
          ))}
        </div>
      )}
    </>
  )
}

/** 「今日单词」页展示层（纯展示，便于 SSR 单测；深色主题由 tokens 自动适配） */
export function TodayWordsView({
  breakdown,
  reviewBacklog,
  onSelectWord,
}: TodayWordsViewProps) {
  const groups = groupsOf(breakdown)
  if (breakdown.totalPlanned === 0 && breakdown.items.length === 0) {
    return (
      <EmptyState
        title="今天还没有学习记录"
        description="开始今日学习后，这里会按「复习 / 新学」列出今天遇到的单词。"
      />
    )
  }
  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="mm-card mm-card--flat">
        <div className="mm-kpi-row">
          <div className="mm-kpi">
            <span className="mm-kpi-value mm-kpi-value--primary">{breakdown.totalLearned}</span>
            <span className="mm-kpi-label">今日已学</span>
          </div>
          <div className="mm-kpi">
            <span className="mm-kpi-value">{breakdown.review.learned}</span>
            <span className="mm-kpi-label">复习已学</span>
          </div>
          <div className="mm-kpi">
            <span className="mm-kpi-value">{breakdown.new.learned}</span>
            <span className="mm-kpi-label">新学已学</span>
          </div>
        </div>
      </div>
      {reviewBacklog != null && reviewBacklog > 0 ? (
        <div className="mm-caption" style={{ padding: '0 2px 8px' }}>
          其余 {reviewBacklog} 个到期复习将在之后复习（每日复习上限）
        </div>
      ) : null}
      <CategorySection
        title="复习"
        stats={breakdown.review}
        words={groups.review}
        onSelectWord={onSelectWord}
      />
      <CategorySection
        title="新学"
        stats={breakdown.new}
        words={groups.new}
        onSelectWord={onSelectWord}
      />
    </div>
  )
}
