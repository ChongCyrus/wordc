import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HomeTaskCard } from '../../src/ui/home/HomeTaskCard'
import { resolvePendingNew } from '../../src/ui/home/home-kpi'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

describe('task-274 manual 首页实际计划显示', () => {
  it('manual 有 plan 用 breakdown 剩余；无 plan 为 0', () => {
    expect(
      resolvePendingNew({ manual: true, hasPlan: true, breakdownRemaining: 3, newBudget: 30, fallbackNewCount: 30 }),
    ).toBe(3)
    expect(
      resolvePendingNew({ manual: true, hasPlan: false, breakdownRemaining: 0, newBudget: 30, fallbackNewCount: 30 }),
    ).toBe(0)
  })

  it('添加弹窗不透明 + 首页只有一个添加入口', () => {
    const addWords = src('ui/home/AddTodayWordsDialog.tsx')
    const page = src('ui/home/HomePage.tsx')
    const css = src('app/styles/global.css')
    expect(addWords).toContain('overlayClassName="mm-mask--add-words"')
    expect(css).toContain('.mm-mask.mm-mask--add-words')
    expect(css).toContain('background-color: var(--mm-surface)')
    expect(page).toContain('showHomeAddCardPrimary ? null :')
    expect(page).toContain('manualMode={showHomeAddCardPrimary}')
  })

  it('manual 无 plan：待新学 0、今日 0/0、主按钮添加今日新单词', () => {
    const html = renderToStaticMarkup(
      createElement(HomeTaskCard, {
        state: { kind: 'fresh', pendingReview: 0, pendingNew: 30 },
        pendingReview: 0,
        pendingNew: 0,
        todayReviewed: 0,
        dailyGoal: 30,
        plannedTotal: 0,
        manualMode: true,
        onAddWords: () => undefined,
        onAction: () => undefined,
      }),
    )
    expect(html).toContain('待新学')
    expect(html).toContain('今日 0 / 0')
    expect(html).toContain('添加今日新单词')
    expect(html).not.toContain('开始学习')
    expect(html).toContain('待复习 0 · 待新学 0')
  })

  it('auto 模式仍用 dailyGoal 与开始学习', () => {
    const html = renderToStaticMarkup(
      createElement(HomeTaskCard, {
        state: { kind: 'fresh', pendingReview: 1, pendingNew: 3 },
        pendingReview: 1,
        pendingNew: 3,
        todayReviewed: 0,
        dailyGoal: 10,
        plannedTotal: 10,
        manualMode: false,
        onAction: () => undefined,
      }),
    )
    expect(html).toContain('今日 0 / 10')
    expect(html).toContain('开始学习')
    expect(html).not.toContain('添加今日新单词')
  })

  it('顺序/随机追加成功有可见确认弹窗兜底', () => {
    const addWords = src('ui/home/AddTodayWordsDialog.tsx')
    expect(addWords).toContain('setDoneMessage')
    expect(addWords).toContain('title="添加完成"')
    expect(addWords).toContain('已追加')
  })

  it('HomePage 传入实际 plan 词数/manual', () => {
    const page = src('ui/home/HomePage.tsx')
    expect(page).toContain('plannedTotal={homePlanTotal}')
    expect(page).toContain('onAddWords={showHomeAddCardPrimary ? () => setAddWordsOpen(true) : undefined}')
    expect(page).toContain('homeHasPlan')
  })
})
