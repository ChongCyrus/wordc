import { describe, expect, it } from 'vitest'
import {
  DAILY_GOAL_MAX,
  DAILY_GOAL_MIN,
  parseDailyGoalInput,
} from '../../src/ui/me/daily-goal'

describe('每日学习量输入（task-27：任意正整数 1–9999）', () => {
  it('合法边界：1 与 9999', () => {
    expect(parseDailyGoalInput('1')).toEqual({ ok: true, value: 1 })
    expect(parseDailyGoalInput('9999')).toEqual({ ok: true, value: 9999 })
    expect(DAILY_GOAL_MIN).toBe(1)
    expect(DAILY_GOAL_MAX).toBe(9999)
  })

  it('允许 200 以上（不再卡 200）', () => {
    expect(parseDailyGoalInput('201')).toEqual({ ok: true, value: 201 })
    expect(parseDailyGoalInput('500')).toEqual({ ok: true, value: 500 })
    expect(parseDailyGoalInput('1000')).toEqual({ ok: true, value: 1000 })
  })

  it('去除首尾空格后合法', () => {
    expect(parseDailyGoalInput('  30  ')).toEqual({ ok: true, value: 30 })
  })

  it('非法：0 / 负数 / 小数 / 非数字 / 空', () => {
    expect(parseDailyGoalInput('0').ok).toBe(false)
    expect(parseDailyGoalInput('-1').ok).toBe(false)
    expect(parseDailyGoalInput('1.5').ok).toBe(false)
    expect(parseDailyGoalInput('abc').ok).toBe(false)
    expect(parseDailyGoalInput('').ok).toBe(false)
    expect(parseDailyGoalInput('   ').ok).toBe(false)
  })

  it('越界：99999 / 超大数给出中文提示且 value 为空', () => {
    const tooBig = parseDailyGoalInput('99999')
    expect(tooBig.ok).toBe(false)
    expect(tooBig.value).toBeUndefined()
    expect(tooBig.message).toContain('9999')

    const huge = parseDailyGoalInput('999999999999999999999')
    expect(huge.ok).toBe(false)
  })
})
