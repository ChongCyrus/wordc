import { Link, useNavigate } from 'react-router-dom'
import { addDays, localDateKey } from '../../core'
import type { DailyStatPoint } from '../../core'
import { PageShell } from '../components/PageShell'
import { SectionBand } from '../components/SectionBand'
import { Card } from '../components/SectionBand'
import { Button } from '../components/Buttons'
import { HomeTaskCard } from './HomeTaskCard'
import type { HomeStateLike } from './home-state-view'
import { SettingsIcon } from '../components/icons'
import { useSettings } from '../../app/hooks/useSettings'
import { useDailyStats, useStatsOverview } from '../../app/hooks/useStats'
import { useStudyProgress } from '../../app/hooks/useStudyProgress'
import { useHomeStudy } from '../../app/hooks/useHomeStudy'
import { resolvePendingNew, resolvePendingReview } from './home-kpi'
import { readDailyReviewCap } from '../../app/hooks/dailyReviewCap'
import { useLearningEfficiency } from '../../app/hooks/useLearningEfficiency'
import { secondsToMinutes } from '../../core'

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

interface WeekDay {
  date: string
  label: string
  reviewed: number
  isToday: boolean
}

/** 最近 7 天（含今天，按日期升序） */
function buildWeek(points: DailyStatPoint[]): WeekDay[] {
  const map = new Map(points.map((point) => [point.date, point]))
  const now = Date.now()
  const days: WeekDay[] = []
  for (let offset = 6; offset >= 0; offset -= 1) {
    const timestamp = addDays(now, -offset)
    const date = localDateKey(timestamp)
    const weekday = new Date(timestamp).getDay()
    days.push({
      date,
      label: WEEKDAY_LABELS[weekday] ?? '',
      reviewed: map.get(date)?.reviewed ?? 0,
      isToday: offset === 0,
    })
  }
  return days
}

/**
 * 首页「今日任务仪表盘」（D19，SPEC §8.3 / 03-ui §4.1）：
 * 今日任务（待复习/待新学/进度/开始学习）+ 当前词库 + 连续打卡。
 */
export default function HomePage() {
  const navigate = useNavigate()
  const { settings, loading: settingsLoading } = useSettings()
  const { data: homeData, homeState: realHomeState } = useHomeStudy()
  const study = useStudyProgress()
  const { overview } = useStatsOverview()
  const { points } = useDailyStats(7)

  const loading = settingsLoading || study.loading
  const todayReviewed = overview?.todayReviewed ?? 0
  const dailyGoal = study.dailyGoal
  const week = buildWeek(points)
  const deck = study.deck
  const hasDecks = study.decks.length > 0
  // plan 驱动的 6 态（SPEC-v2 §6.2）：data 事实 → core.deriveHomeState；加载完成前用旧队列事实兜底
  const deckHasWords = (deck?.wordCount ?? 0) > 0
  const fallbackHomeState: HomeStateLike = !hasDecks
    ? { kind: 'no-deck' }
    : !deckHasWords
      ? { kind: 'no-words' }
      : study.totalPlanned > 0
        ? { kind: 'fresh', pendingReview: study.dueCount, pendingNew: study.newCount }
        : { kind: 'done' }
  const homeState: HomeStateLike = (realHomeState as HomeStateLike | null) ?? fallbackHomeState
  const homeTodayReviewed = homeData?.todayReviewed ?? todayReviewed
  const homeDailyGoal = homeData?.dailyGoal ?? dailyGoal
  // task-50：今日已学拆分（task-49 的 HomeStudyData.breakdown；未就绪时 undefined，不渲染该行）
  const rawBreakdown = (
    homeData as unknown as
      | {
          breakdown?: {
            review?: { learned?: number }
            new?: { learned?: number }
          }
        }
      | null
  )?.breakdown
  const homeBreakdown =
    rawBreakdown != null
      ? {
          reviewLearned: rawBreakdown.review?.learned ?? 0,
          newLearned: rawBreakdown.new?.learned ?? 0,
        }
      : undefined
  // task-50：固定三项 KPI；待新学 = plan 内未学新词（**无 plan 用 newBudget**）
  // 注意：无 plan 时 data 的 emptyBreakdown.new.remaining = 0（非 null），不能用 ?? 直接回退。
  const homeHasPlan = homeData?.plan != null
  const breakdownRemaining = (
    homeData as unknown as
      | { breakdown?: { new?: { remaining?: number } } }
      | null
  )?.breakdown?.new?.remaining
  const homePendingReview = resolvePendingReview(homeData?.dueCount, study.dueCount)
  // task-52：超出复习上限而顺延的到期复习数
  const homeReviewBacklog = (
    homeData as unknown as { reviewBacklog?: number } | null
  )?.reviewBacklog
  const homeReviewCap = settings ? readDailyReviewCap(settings) : 0
  const homePendingNew = resolvePendingNew({
    hasPlan: homeHasPlan,
    breakdownRemaining,
    newBudget: homeData?.newBudget,
    fallbackNewCount: study.newCount,
  })

  const learningEfficiency = useLearningEfficiency({
    learnedWords: homeTodayReviewed,
    remainingWords: homePendingReview + homePendingNew,
  })
  const avgSeconds = learningEfficiency.averageSecondsPerWord
  const remainingMinutes = secondsToMinutes(learningEfficiency.estimatedRemainingSeconds)

  return (
    <PageShell
      title="今日"
      hero
      actions={
        <Link to="/me/settings" className="mm-icon-btn" aria-label="设置">
          <SettingsIcon size={22} />
        </Link>
      }
    >
      {loading ? <div className="mm-loading">正在加载今日任务…</div> : null}

      {!loading ? (
        <>
          <SectionBand title="今日任务" />
          <HomeTaskCard
            state={homeState}
            pendingReview={homePendingReview}
            pendingNew={homePendingNew}
            reviewBacklog={homeReviewBacklog}
            reviewCap={homeReviewCap}
            todayReviewed={homeTodayReviewed}
            dailyGoal={homeDailyGoal}
            breakdown={homeBreakdown}
            onOpenTodayWords={() => navigate('/today')}
            onAction={(target) =>
              navigate(target === 'study' ? '/study' : target === 'decks' ? '/decks' : '/stats')
            }
          />

          <div className="mm-caption" style={{ paddingTop: 10 }}>
            学习效率：平均记住一个单词{' '}
            {avgSeconds == null ? '—' : `${Math.max(1, Math.round(avgSeconds))} 秒`} · 预计还需{' '}
            {remainingMinutes == null ? '—' : `${Math.max(1, Math.round(remainingMinutes))} 分钟`}
            {avgSeconds == null && homeTodayReviewed > 0 ? '（今日样本不足，再学 1 个词后显示）' : null}
          </div>

          {hasDecks ? (
            <>
              <SectionBand title="当前词库" />
          <Card onClick={() => (deck ? navigate(`/decks/${deck.id}`) : undefined)}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ flex: '1 1 auto', minWidth: 0 }}>
                <div className="mm-row-title">{deck?.name ?? '未选择词库'}</div>
                <div className="mm-row-sub">
                  {deck?.wordCount ?? 0} 词 · 已学 {study.progress?.studiedCount ?? 0} ·{' '}
                  {Math.round((study.progress?.progress ?? 0) * 100)}%
                </div>
              </div>
              <span className="mm-chevron">›</span>
            </div>
            <div className="mm-progress mm-progress--thin">
              <div
                className="mm-progress-fill"
                style={{ width: `${Math.round((study.progress?.progress ?? 0) * 100)}%` }}
              />
            </div>
            <div className="mm-caption">
              今天到期 {study.progress?.dueCount ?? 0} 个 · 点此查看词库详情
            </div>
          </Card>

          <SectionBand title="连续打卡" />
          <Card>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <span className="mm-kpi-value mm-kpi-value--primary">
                {overview?.streakDays ?? 0}
              </span>
              <span className="mm-kpi-label">天连续打卡</span>
              <span className="mm-badge mm-badge--soft" style={{ marginLeft: 'auto' }}>
                {todayReviewed > 0 ? '今日已打卡' : '今日未打卡'}
              </span>
            </div>
            <div className="mm-week" aria-label="最近 7 天打卡">
              {week.map((day) => (
                <div className="mm-week-day" key={day.date}>
                  <span
                    className={`mm-week-dot${day.reviewed > 0 ? ' is-done' : ''}${
                      day.isToday ? ' is-today' : ''
                    }`}
                  />
                  <span>{day.label}</span>
                </div>
              ))}
            </div>
            <div className="mm-caption">
              今日已学 {todayReviewed} 个 · 累计已学 {overview?.totalLearned ?? 0} 个
            </div>
          </Card>

              {study.dueCount > study.reviewCount ? (
                <div className="mm-caption" style={{ paddingTop: 12 }}>
                  另有 {study.dueCount - study.reviewCount} 个到期单词超出今日学习量，明天继续。
                </div>
              ) : null}
            </>
          ) : null}
        </>
      ) : null}


      {!loading && hasDecks && !deck ? (
        <div style={{ paddingTop: 16 }}>
          <Button variant="soft" block onClick={() => navigate('/decks')}>
            选择当前词库
          </Button>
        </div>
      ) : null}
    </PageShell>
  )
}
