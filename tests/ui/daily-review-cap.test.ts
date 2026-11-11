import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/data', () => ({ updateSettings: vi.fn().mockResolvedValue({}) }))

import { updateSettings } from '../../src/data'
import {
  DAILY_REVIEW_CAP_HINT,
  DAILY_REVIEW_CAP_PRESETS,
  dailyReviewCapLabel,
  hasDailyReviewCapSetting,
  normalizeDailyReviewCap,
  parseDailyReviewCapInput,
  readDailyReviewCap,
  saveDailyReviewCap,
} from '../../src/app/hooks/dailyReviewCap'

const updateMock = vi.mocked(updateSettings)

describe('每日复习上限（task-52）', () => {
  beforeEach(() => {
    updateMock.mockClear()
    updateMock.mockResolvedValue({} as never)
  })

  it('预设：不限(0)/50/100/200；0 表示不限', () => {
    expect([...DAILY_REVIEW_CAP_PRESETS]).toEqual([0, 50, 100, 200])
    expect(dailyReviewCapLabel(0)).toBe('不限')
    expect(dailyReviewCapLabel(50)).toBe('50 个')
  })

  it('读取/规范化：缺失/非法 → 0（不限）', () => {
    expect(normalizeDailyReviewCap(undefined)).toBe(0)
    expect(normalizeDailyReviewCap('abc')).toBe(0)
    expect(normalizeDailyReviewCap(-1)).toBe(0)
    expect(normalizeDailyReviewCap(10000)).toBe(0)
    expect(normalizeDailyReviewCap(120)).toBe(120)
    const withKey = { 'study.dailyReviewCap': 50 } as unknown as never
    expect(hasDailyReviewCapSetting(withKey)).toBe(true)
    expect(readDailyReviewCap(withKey)).toBe(50)
    expect(hasDailyReviewCapSetting({} as never)).toBe(false)
  })

  it('自定义输入：0 与 9999 合法；空/负数/小数/超界非法', () => {
    expect(parseDailyReviewCapInput('0')).toEqual({ ok: true, value: 0 })
    expect(parseDailyReviewCapInput('9999')).toEqual({ ok: true, value: 9999 })
    expect(parseDailyReviewCapInput('123').ok).toBe(true)
    for (const bad of ['', '-1', '1.5', 'abc', '10000']) {
      expect(parseDailyReviewCapInput(bad).ok).toBe(false)
    }
  })

  it('保存走 updateSettings；非法值不写', async () => {
    expect(await saveDailyReviewCap(50)).toBe(50)
    expect(updateMock).toHaveBeenCalledWith({ 'study.dailyReviewCap': 50 })
    await expect(saveDailyReviewCap(1.5)).rejects.toThrow('不合法')
    await expect(saveDailyReviewCap(-1)).rejects.toThrow('不合法')
    expect(updateMock).toHaveBeenCalledTimes(1)
  })

  it('说明文案：顺延不丢失 + 新学预算口径', () => {
    expect(DAILY_REVIEW_CAP_HINT).toContain('0 = 不限')
    expect(DAILY_REVIEW_CAP_HINT).toContain('顺延')
    expect(DAILY_REVIEW_CAP_HINT).toContain('不丢失')
    expect(DAILY_REVIEW_CAP_HINT).toContain('新学预算')
  })
})
