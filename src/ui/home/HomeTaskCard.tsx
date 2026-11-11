import { Button } from '../components/Buttons'
import { Card } from '../components/SectionBand'
import type { HomeActionTarget, HomeStateLike } from './home-state-view'
import { homeActionView } from './home-state-view'

export interface HomeTaskBreakdown {
  /** 今日已学中的复习词数 */
  reviewLearned: number
  /** 今日已学中的新学词数 */
  newLearned: number
}

export interface HomeTaskCardProps {
  state: HomeStateLike
  /** 今日剩余到期复习数（= getHomeStudyData().dueCount；固定 KPI，始终显示） */
  pendingReview?: number
  /** 今日待新学数（= plan 内未学新词 remaining；无 plan 时 newBudget；固定 KPI） */
  pendingNew?: number
  todayReviewed: number
  dailyGoal: number
  /** 今日已学拆分（task-50；数据未就绪时不传，不渲染该行） */
  breakdown?: HomeTaskBreakdown
  /** 今日到期超出复习上限而顺延的数量（task-52；>0 时显示提示） */
  reviewBacklog?: number
  /** 今日复习上限（0=不限） */
  reviewCap?: number
  /** 次级入口「查看今日单词 ›」→ /today */
  onOpenTodayWords?: () => void
  onAction: (target: HomeActionTarget) => void
}

function percentOf(done: number, goal: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(goal) || goal <= 0) return 0
  return Math.min(100, Math.round((done / goal) * 100))
}

/**
 * 首页「今日任务」卡：SPEC-v2 §6.2 六态（无词库/无单词/开始学习/继续学习/完成但有逾期/已完成）。
 * 数据来自 plan 的事实（task-30 接线后由 getHomeStudyData + deriveHomeState 提供），
 * 本组件只做文案与按钮的展示分支。
 */
export function HomeTaskCard({
  state,
  pendingReview,
  pendingNew,
  todayReviewed,
  dailyGoal,
  breakdown,
  reviewBacklog,
  reviewCap,
  onOpenTodayWords,
  onAction,
}: HomeTaskCardProps) {
  const view = homeActionView(state)
  const pct = percentOf(todayReviewed, dailyGoal)
  const showLearnButton = view.target === 'study'
  const isDone = state.kind === 'done' || state.kind === 'done-with-overdue'

  return (
    <Card>
      {/* task-50：KPI 行固定三项（待复习/待新学/今日已学），不随 6 态变化 */}
      <div className="mm-kpi-row">
        <div className="mm-kpi">
          <span className="mm-kpi-value mm-kpi-value--primary">
            {pendingReview ?? (state.kind === 'fresh' ? state.pendingReview : 0)}
          </span>
          <span className="mm-kpi-label">待复习</span>
        </div>
        <div className="mm-kpi">
          <span className="mm-kpi-value">
            {pendingNew ?? (state.kind === 'fresh' ? state.pendingNew : 0)}
          </span>
          <span className="mm-kpi-label">待新学</span>
        </div>
        <div className="mm-kpi" style={{ marginLeft: 'auto', alignItems: 'flex-end' }}>
          <span className="mm-kpi-value">{todayReviewed}</span>
          <span className="mm-kpi-label">今日已学</span>
        </div>
      </div>

      {reviewBacklog != null && reviewBacklog > 0 ? (
        <div className="mm-caption">
          另有 {reviewBacklog} 个到期复习，今日上限{' '}
          {reviewCap != null && reviewCap > 0 ? `${reviewCap} 个` : '不限'}，将顺延
        </div>
      ) : null}

      {breakdown ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
          }}
        >
          <span className="mm-caption">
            复习 {breakdown.reviewLearned} · 新学 {breakdown.newLearned}
          </span>
          {onOpenTodayWords ? (
            <button
              type="button"
              onClick={onOpenTodayWords}
              style={{
                border: 0,
                background: 'transparent',
                padding: '4px 0',
                minHeight: 32,
                color: 'var(--mm-primary-text)',
                fontSize: 'var(--mm-text-caption)',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              查看今日单词 ›
            </button>
          ) : null}
        </div>
      ) : null}

      <div>
        <div className="mm-progress">
          <div className="mm-progress-fill" style={{ width: `${pct}%` }} />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span className="mm-caption">
            今日 {todayReviewed} / {dailyGoal}
          </span>
          <span className="mm-caption">{pct}%</span>
        </div>
      </div>

      <div className="mm-row-sub" style={{ fontSize: 'var(--mm-text-body-sm)' }}>
        {view.subtitle}
        {isDone && state.kind === 'done' ? '，也可以去词库手动加学新词。' : ''}
      </div>

      {showLearnButton ? (
        <Button
          variant="primary"
          size="lg"
          block
          onClick={() => onAction(view.target)}
        >
          {view.buttonLabel}
        </Button>
      ) : (
        <div className="mm-btn-row">
          <Button variant="primary" onClick={() => onAction(view.target)}>
            {view.buttonLabel}
          </Button>
          {state.kind === 'no-deck' || state.kind === 'no-words' ? (
            <Button onClick={() => onAction('study')}>开始学习</Button>
          ) : null}
        </div>
      )}
    </Card>
  )
}
