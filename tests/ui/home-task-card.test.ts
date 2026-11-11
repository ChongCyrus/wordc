import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HomeTaskCard } from '../../src/ui/home/HomeTaskCard'
import type { HomeStateLike } from '../../src/ui/home/home-state-view'

function render(
  state: HomeStateLike,
  todayReviewed = 8,
  dailyGoal = 30,
  extra?: {
    breakdown?: { reviewLearned: number; newLearned: number }
    onOpenTodayWords?: () => void
  },
  cap?: { reviewBacklog?: number; reviewCap?: number },
): string {
  return renderToStaticMarkup(
    createElement(HomeTaskCard, {
      state,
      todayReviewed,
      dailyGoal,
      onAction: () => undefined,
      ...extra,
      ...cap,
    }),
  )
}

describe('首页今日任务卡（6 态渲染）', () => {
  it('fresh 态：待复习/待新学 KPI + 开始学习按钮 + 进度', () => {
    const html = render({ kind: 'fresh', pendingReview: 12, pendingNew: 18 })
    expect(html).toContain('待复习')
    expect(html).toContain('待新学')
    expect(html).toContain('12')
    expect(html).toContain('18')
    expect(html).toContain('开始学习')
    expect(html).toContain('今日 8 / 30')
  })

  it('ongoing 态：固定三 KPI + 状态说明「已学 x / 共 y · 还剩 z」+ 继续学习', () => {
    const html = render({ kind: 'ongoing', remaining: 30, index: 20, total: 50 }, 20, 30)
    expect(html).toContain('待复习')
    expect(html).toContain('待新学')
    expect(html).toContain('今日已学')
    expect(html).toContain('已学 20 / 共 50 · 还剩 30')
    expect(html).toContain('继续学习')
  })

  it('done-with-overdue 态：固定三 KPI + 状态说明/继续学习按钮', () => {
    const html = render(
      { kind: 'done-with-overdue', overdue: 7 },
      20,
      30,
      { breakdown: { reviewLearned: 15, newLearned: 5 } },
    )
    expect(html).toContain('待复习')
    expect(html).toContain('待新学')
    expect(html).toContain('今日已学')
    expect(html).toContain('还有 7 个到期复习')
    expect(html).toContain('继续学习（还有 7 个到期复习）')
  })

  it('三态（fresh/ongoing/done）KPI 均为固定三项且数值取 props', () => {
    const cases = [
      { state: { kind: 'fresh', pendingReview: 12, pendingNew: 18 } as const, review: 12, neww: 18, reviewed: 0 },
      { state: { kind: 'ongoing', remaining: 30, index: 20, total: 50 } as const, review: 4, neww: 6, reviewed: 20 },
      { state: { kind: 'done' } as const, review: 0, neww: 0, reviewed: 30 },
    ]
    for (const item of cases) {
      const html = render(item.state, item.reviewed, 30, {
        breakdown: { reviewLearned: item.review, newLearned: item.neww },
        onOpenTodayWords: () => undefined,
      })
      expect(html).toContain('待复习')
      expect(html).toContain('待新学')
      expect(html).toContain('今日已学')
      expect(html).toContain(`复习 ${item.review} · 新学 ${item.neww}`)
    }
  })

  it('done 态：今日已完成 + 查看今日', () => {
    const html = render({ kind: 'done' })
    expect(html).toContain('今日已完成')
    expect(html).toContain('查看今日')
  })

  it('no-deck / no-words 态：给去词库入口，且不显示学习按钮文字冲突', () => {
    const noDeck = render({ kind: 'no-deck' })
    expect(noDeck).toContain('去添加词库')
    const noWords = render({ kind: 'no-words' })
    expect(noWords).toContain('去词库')
  })

  it('今日已学拆分（task-50）：复习 a · 新学 b + 「查看今日单词」入口', () => {
    const html = render(
      { kind: 'fresh', pendingReview: 1, pendingNew: 1 },
      8,
      30,
      { breakdown: { reviewLearned: 5, newLearned: 3 }, onOpenTodayWords: () => undefined },
    )
    expect(html).toContain('复习 5 · 新学 3')
    expect(html).toContain('查看今日单词 ›')
  })

  it('无 breakdown 数据时不渲染拆分行与入口（兼容数据未就绪）', () => {
    const html = render({ kind: 'fresh', pendingReview: 1, pendingNew: 1 })
    expect(html).not.toContain('复习 5')
    expect(html).not.toContain('查看今日单词')
  })

  it('复习上限 backlog（task-52）：>0 时显示「另有 X 个到期复习…将顺延」', () => {
    const html = render(
      { kind: 'fresh', pendingReview: 50, pendingNew: 0 },
      0,
      30,
      { breakdown: { reviewLearned: 0, newLearned: 0 } },
      { reviewBacklog: 409, reviewCap: 50 },
    )
    expect(html).toContain('另有 409 个到期复习')
    expect(html).toContain('今日上限 50 个')
    expect(html).toContain('将顺延')
  })

  it('backlog=0 / 不限时显示对应文案（不限）', () => {
    const none = render({ kind: 'fresh', pendingReview: 1, pendingNew: 1 }, 0, 30, undefined, {
      reviewBacklog: 0,
      reviewCap: 0,
    })
    expect(none).not.toContain('另有')

    const unlimited = render(
      { kind: 'fresh', pendingReview: 1, pendingNew: 1 },
      0,
      30,
      undefined,
      { reviewBacklog: 3, reviewCap: 0 },
    )
    expect(unlimited).toContain('另有 3 个到期复习')
    expect(unlimited).toContain('今日上限 不限')
  })

  it('进度百分比按 今日已学 / dailyGoal 计算并 clamp', () => {
    expect(render({ kind: 'fresh', pendingReview: 1, pendingNew: 1 }, 15, 30)).toContain('50%')
    expect(render({ kind: 'fresh', pendingReview: 1, pendingNew: 1 }, 60, 30)).toContain('100%')
    expect(render({ kind: 'fresh', pendingReview: 1, pendingNew: 1 }, 0, 0)).toContain('0%')
  })
})
