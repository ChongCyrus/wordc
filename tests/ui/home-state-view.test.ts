import { describe, expect, it } from 'vitest'
import { homeActionView } from '../../src/ui/home/home-state-view'
import type { HomeStateLike } from '../../src/ui/home/home-state-view'

describe('首页 6 态文案与按钮（SPEC-v2 §6.2）', () => {
  it('no-deck：去添加词库', () => {
    const view = homeActionView({ kind: 'no-deck' })
    expect(view.buttonLabel).toBe('去添加词库')
    expect(view.target).toBe('decks')
    expect(view.subtitle).toContain('还没有词库')
  })

  it('no-words：去词库', () => {
    const view = homeActionView({ kind: 'no-words' })
    expect(view.buttonLabel).toBe('去词库')
    expect(view.target).toBe('decks')
  })

  it('fresh：显示待复习/待新学 + 开始学习', () => {
    const view = homeActionView({ kind: 'fresh', pendingReview: 12, pendingNew: 18 })
    expect(view.subtitle).toBe('待复习 12 · 待新学 18')
    expect(view.buttonLabel).toBe('开始学习')
    expect(view.buttonKind).toBe('start')
    expect(view.target).toBe('study')
  })

  it('ongoing：继续学习 + 已学 index / 共 total · 还剩 N', () => {
    const view = homeActionView({ kind: 'ongoing', remaining: 30, index: 20, total: 50 })
    expect(view.subtitle).toBe('已学 20 / 共 50 · 还剩 30')
    expect(view.buttonLabel).toBe('继续学习')
    expect(view.buttonKind).toBe('continue')
    expect(view.target).toBe('study')
  })

  it('done-with-overdue：继续学习（还有 N 个到期复习）', () => {
    const view = homeActionView({ kind: 'done-with-overdue', overdue: 7 })
    expect(view.buttonLabel).toBe('继续学习（还有 7 个到期复习）')
    expect(view.subtitle).toContain('还有 7 个到期复习')
    expect(view.target).toBe('study')
  })

  it('done：查看今日', () => {
    const view = homeActionView({ kind: 'done' })
    expect(view.buttonLabel).toBe('查看今日')
    expect(view.buttonKind).toBe('done')
    expect(view.target).toBe('stats')
    expect(view.subtitle).toContain('今日已完成')
  })

  it('六态均有非空文案（穷举）', () => {
    const states: HomeStateLike[] = [
      { kind: 'no-deck' },
      { kind: 'no-words' },
      { kind: 'fresh', pendingReview: 0, pendingNew: 30 },
      { kind: 'ongoing', remaining: 1, index: 0, total: 1 },
      { kind: 'done-with-overdue', overdue: 1 },
      { kind: 'done' },
    ]
    for (const state of states) {
      const view = homeActionView(state)
      expect(view.title.length).toBeGreaterThan(0)
      expect(view.subtitle.length).toBeGreaterThan(0)
      expect(view.buttonLabel.length).toBeGreaterThan(0)
      expect(['study', 'decks', 'stats']).toContain(view.target)
    }
  })
})
