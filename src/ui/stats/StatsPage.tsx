import { PageShell } from '../components/PageShell'
import { SectionBand, Card } from '../components/SectionBand'
import { BarChart, Legend, StackedBar } from '../components/StatChart'
import { EmptyState } from '../components/EmptyState'
import { useDailyStats, useStatsOverview, useUnfamiliarTop } from '../../app/hooks/useStats'
import { useTodayBreakdown } from '../../app/hooks/useTodayBreakdown'

/** 不熟悉度 5 档色（与学习页同口径，仅展示用） */
function famBand(value: number): 0 | 1 | 2 | 3 | 4 {
  if (value < 0.2) return 0
  if (value < 0.4) return 1
  if (value < 0.6) return 2
  if (value < 0.8) return 3
  return 4
}

function famPercent(value: number): string {
  return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`
}

/**
 * 统计页（SPEC §8.3 / 03-ui §4.6）：
 * 概览三数字 + 今日反馈堆叠条 + 近 14 天学习量（纯 SVG）+ 不熟悉度 Top 5。
 */
export default function StatsPage() {
  const { overview, loading: overviewLoading } = useStatsOverview()
  const { points, loading: dailyLoading } = useDailyStats(14)
  const { items: topItems, loading: topLoading } = useUnfamiliarTop(5)
  const { breakdown: todayBreakdown } = useTodayBreakdown()

  const loading = overviewLoading || dailyLoading || topLoading
  const hasData = (overview?.totalReviews ?? 0) > 0 || (overview?.totalLearned ?? 0) > 0

  const ratingCounts = overview?.ratingCounts ?? { familiar: 0, vague: 0, forgot: 0 }
  const feedbackTotal = ratingCounts.familiar + ratingCounts.vague + ratingCounts.forgot

  const chartData = points.map((point) => {
    const [, month, day] = point.date.split('-')
    return { label: `${month ?? ''}-${day ?? ''}`, value: point.reviewed }
  })

  const totalRecent = points.reduce((sum, point) => sum + point.reviewed, 0)

  return (
    <PageShell title="统计" hero>
      {loading ? <div className="mm-loading">正在统计数据…</div> : null}

      {!loading && !hasData ? (
        <EmptyState
          title="还没有学习记录"
          description="完成一次学习后，这里会显示打卡、学习量与不熟悉度分析。"
        />
      ) : null}

      {!loading && hasData ? (
        <>
          <SectionBand title="概览" />
          <div className="mm-stat-grid">
            <div className="mm-stat-cell">
              <span className="mm-stat-value">{overview?.streakDays ?? 0}</span>
              <span className="mm-stat-label">连续打卡（天）</span>
            </div>
            <div className="mm-stat-cell">
              <span className="mm-stat-value">{overview?.totalLearned ?? 0}</span>
              <span className="mm-stat-label">累计已学</span>
            </div>
            <div className="mm-stat-cell">
              <span className="mm-stat-value">{overview?.todayReviewed ?? 0}</span>
              <span className="mm-stat-label">今日已学</span>
            </div>
          </div>

          <SectionBand title="今日反馈" />
          <Card>
            <StackedBar
              ariaLabel="今日反馈分布"
              segments={[
                { label: '认识', value: ratingCounts.familiar, color: 'var(--mm-chart-known)' },
                { label: '模糊', value: ratingCounts.vague, color: 'var(--mm-chart-vague)' },
                { label: '不认识', value: ratingCounts.forgot, color: 'var(--mm-chart-forgot)' },
              ]}
            />
            <Legend
              items={[
                {
                  label: '认识',
                  value: ratingCounts.familiar,
                  color: 'var(--mm-chart-known)',
                },
                { label: '模糊', value: ratingCounts.vague, color: 'var(--mm-chart-vague)' },
                { label: '不认识', value: ratingCounts.forgot, color: 'var(--mm-chart-forgot)' },
              ]}
            />
            <div className="mm-caption">
              今日共反馈 {feedbackTotal} 次 · 今日新学 {overview?.todayNewLearned ?? 0} 个
            </div>
            <div className="mm-caption">
              今日已学 {todayBreakdown.totalLearned} 个 · 复习 {todayBreakdown.review.learned} · 新学{' '}
              {todayBreakdown.new.learned}
            </div>
          </Card>

          <SectionBand title="学习量（近 14 天）" />
          <Card>
            <div className="mm-caption" style={{ paddingBottom: 8 }}>
              近 14 天共学习 {totalRecent} 个单词（复习 + 新学，按天去重）
            </div>
            <BarChart data={chartData} ariaLabel="近 14 天学习量柱状图" />
          </Card>

          <SectionBand title="不熟悉度 Top 5" />
          <Card>
            {topItems.length === 0 ? (
              <div className="mm-caption">还没有标记过不熟悉的含义。</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                {topItems.map((item) => {
                  const band = famBand(item.familiarity)
                  return (
                    <div key={item.meaningId}>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                        <span className="mm-row-title" style={{ flex: '1 1 auto' }}>
                          {item.headword || item.wordId}
                        </span>
                        <span
                          className="mm-caption"
                          style={{ color: `var(--mm-fam-${band}-text)`, fontWeight: 500 }}
                        >
                          {famPercent(item.familiarity)}
                        </span>
                      </div>
                      <div className="mm-row-sub">
                        {item.pos ? `${item.pos} ` : ''}
                        {item.cn || '（释义缺失）'}
                      </div>
                      <div
                        style={{
                          height: 4,
                          marginTop: 6,
                          borderRadius: 2,
                          backgroundColor: 'var(--mm-fam-track)',
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            height: '100%',
                            width: `${Math.max(2, item.familiarity * 100)}%`,
                            borderRadius: 2,
                            backgroundColor: `var(--mm-fam-${band})`,
                          }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </Card>

          <SectionBand title="复习压力" />
          <Card>
            <div className="mm-kpi-row" style={{ gap: 20 }}>
              <div className="mm-kpi">
                <span className="mm-kpi-value mm-kpi-value--primary">{overview?.dueToday ?? 0}</span>
                <span className="mm-kpi-label">今日到期</span>
              </div>
              <div className="mm-kpi">
                <span className="mm-kpi-value">{overview?.dueTomorrow ?? 0}</span>
                <span className="mm-kpi-label">明天到期</span>
              </div>
              <div className="mm-kpi">
                <span className="mm-kpi-value">{overview?.dueNext7Days ?? 0}</span>
                <span className="mm-kpi-label">未来 7 天</span>
              </div>
            </div>
          </Card>
        </>
      ) : null}
    </PageShell>
  )
}
