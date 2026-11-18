import { describe, expect, it } from 'vitest'
import {
  SWIPE_BACK_THRESHOLD,
  shouldTriggerSwipeBack,
  swipeDragOffset,
} from '../../src/ui/study/lib/swipe-back'

describe('单词卡右滑回退手势（task-30）', () => {
  it('阈值 64px：向右滑 ≥64 才触发', () => {
    expect(SWIPE_BACK_THRESHOLD).toBe(64)
    expect(shouldTriggerSwipeBack({ x: 100, y: 100 }, { x: 163, y: 100 })).toBe(false)
    expect(shouldTriggerSwipeBack({ x: 100, y: 100 }, { x: 164, y: 100 })).toBe(true)
    expect(shouldTriggerSwipeBack({ x: 100, y: 100 }, { x: 200, y: 105 })).toBe(true)
  })

  it('方向：向左滑不触发', () => {
    expect(shouldTriggerSwipeBack({ x: 200, y: 100 }, { x: 100, y: 100 })).toBe(false)
  })

  it('纵向为主时不触发（避免和滚动冲突）', () => {
    expect(shouldTriggerSwipeBack({ x: 100, y: 100 }, { x: 180, y: 200 })).toBe(false)
    expect(shouldTriggerSwipeBack({ x: 100, y: 100 }, { x: 150, y: 120 })).toBe(false)
  })

  it('拖动位移带阻尼：仅向右且水平为主，最多 96px', () => {
    expect(swipeDragOffset({ x: 100, y: 100 }, { x: 50, y: 100 })).toBe(0)
    expect(swipeDragOffset({ x: 100, y: 100 }, { x: 140, y: 220 })).toBe(0)
    expect(swipeDragOffset({ x: 100, y: 100 }, { x: 200, y: 100 })).toBeCloseTo(60)
    expect(swipeDragOffset({ x: 0, y: 0 }, { x: 400, y: 0 })).toBe(96)
  })

  it('NaN/Infinity 输入安全返回 false/0', () => {
    expect(shouldTriggerSwipeBack({ x: Number.NaN, y: 0 }, { x: 100, y: 0 })).toBe(false)
    expect(swipeDragOffset({ x: 0, y: 0 }, { x: Number.POSITIVE_INFINITY, y: 0 })).toBe(0)
  })
})
