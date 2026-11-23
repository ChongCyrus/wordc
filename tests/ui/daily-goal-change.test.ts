import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/data', () => ({
  updateDailyGoalAndResync: vi.fn(),
}))

import { updateDailyGoalAndResync } from '../../src/data'
import {
  applyDailyGoalChange,
  buildGoalResyncMessage,
} from '../../src/app/hooks/useDailyGoal'

const resyncMock = vi.mocked(updateDailyGoalAndResync)

function resyncResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    settings: {},
    plan: { id: 'plan' },
    added: 0,
    removed: 0,
    total: 30,
    newBudget: 30,
    reviewCount: 0,
    newCount: 30,
    ...overrides,
  } as never
}

describe('每日学习量变更（task-35）', () => {
  beforeEach(() => {
    resyncMock.mockReset()
    resyncMock.mockResolvedValue(resyncResult())
  })

  it('文案：+N 词 / -N 词 / 词数不变 / 新学为 0 提示', () => {
    expect(buildGoalResyncMessage({ added: 20, removed: 0, total: 50 })).toBe(
      '已按新学习量调整今日计划：+20 词',
    )
    expect(buildGoalResyncMessage({ added: 0, removed: 40, total: 10 })).toBe(
      '已按新学习量调整今日计划：-40 词',
    )
    expect(buildGoalResyncMessage({ added: 10, removed: 2, total: 38 })).toBe(
      '已按新学习量调整今日计划：+8 词',
    )
    expect(buildGoalResyncMessage({ added: 5, removed: 5, total: 30 })).toContain('今日共 30 词')
    expect(buildGoalResyncMessage(null)).toContain('今日暂无计划需要调整')
    expect(
      buildGoalResyncMessage({ added: 0, removed: 12, total: 9, newCount: 0, reviewCount: 9 }),
    ).toContain('（复习已占满目标，今日新学为 0）')
  })

  it('有可续 plan：调用 data resync，返回 +N 文案', async () => {
    resyncMock.mockResolvedValue(resyncResult({ added: 20, removed: 0, total: 50 }))
    const outcome = await applyDailyGoalChange(50)

    expect(resyncMock).toHaveBeenCalledWith(50)
    expect(outcome.ok).toBe(true)
    expect(outcome.resynced).toBe(true)
    expect(outcome.message).toBe('已按新学习量调整今日计划：+20 词')
  })

  it('减小目标：toast 显示 -N 词', async () => {
    resyncMock.mockResolvedValue(resyncResult({ added: 0, removed: 40, total: 10 }))
    const outcome = await applyDailyGoalChange(10)
    expect(outcome.message).toBe('已按新学习量调整今日计划：-40 词')
    expect(outcome.removed).toBe(40)
  })

  it('今日无 plan：只写设置，提示无需调整', async () => {
    resyncMock.mockResolvedValue(resyncResult({ plan: null, total: 0 }))
    const outcome = await applyDailyGoalChange(45)
    expect(resyncMock).toHaveBeenCalledWith(45)
    expect(outcome.resynced).toBe(false)
    expect(outcome.message).toContain('今日暂无计划需要调整')
  })

  it('data 抛错：返回 ok=false + 中文错误（不白屏）', async () => {
    resyncMock.mockRejectedValue(new Error('数据库写入失败'))
    const outcome = await applyDailyGoalChange(70)
    expect(outcome.ok).toBe(false)
    expect(outcome.message).toContain('每日学习量保存失败')
    expect(outcome.message).toContain('数据库写入失败')
  })

  it('非法目标：不调用 data、返回错误文案', async () => {
    for (const bad of [0, -1, 1.5, 10000, Number.NaN]) {
      const outcome = await applyDailyGoalChange(bad)
      expect(outcome.ok).toBe(false)
      expect(outcome.message).toContain('1–9999')
    }
    expect(resyncMock).not.toHaveBeenCalled()
  })

  it('支持注入 resync（测试/降级），不依赖 data', async () => {
    const injected = vi.fn().mockResolvedValue({ added: 3, removed: 0, total: 12 })
    const outcome = await applyDailyGoalChange(12, injected)
    expect(injected).toHaveBeenCalledWith(12)
    expect(outcome.message).toBe('已按新学习量调整今日计划：+3 词')
    expect(resyncMock).not.toHaveBeenCalled()
  })
})
