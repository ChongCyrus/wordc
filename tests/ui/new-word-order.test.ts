import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/data', () => ({
  updateSettings: vi.fn().mockResolvedValue({}),
}))

import { updateSettings } from '../../src/data'
import {
  hasNewWordOrderSetting,
  NEW_WORD_ORDER_HINT,
  NEW_WORD_ORDER_OPTIONS,
  parseNewWordOrder,
  readNewWordOrder,
  saveNewWordOrder,
} from '../../src/app/hooks/newWordOrder'
import { NewWordOrderSetting } from '../../src/ui/me/NewWordOrderSetting'

const updateMock = vi.mocked(updateSettings)

describe('新词顺序设置（task-48）', () => {
  beforeEach(() => {
    updateMock.mockClear()
    updateMock.mockResolvedValue({} as never)
  })

  it('两选项：词库顺序（默认）/ 随机乱序', () => {
    expect(NEW_WORD_ORDER_OPTIONS.map((option) => option.value)).toEqual(['order', 'random'])
    expect(NEW_WORD_ORDER_OPTIONS.map((option) => option.label)).toEqual([
      '词库顺序',
      '随机乱序',
    ])
    expect(parseNewWordOrder(undefined)).toBe('random')
    expect(parseNewWordOrder('random')).toBe('random')
    expect(parseNewWordOrder('order')).toBe('order')
    expect(parseNewWordOrder('bogus')).toBe('random')
  })

  it('读取：key 未落地时 has=false（设置页不渲染）；落地后按值读取', () => {
    const withoutKey = {} as never
    expect(hasNewWordOrderSetting(withoutKey)).toBe(false)
    expect(hasNewWordOrderSetting(null)).toBe(false)
    const withKey = { 'study.newWordOrder': 'random' } as unknown as never
    expect(hasNewWordOrderSetting(withKey)).toBe(true)
    expect(readNewWordOrder(withKey)).toBe('random')
    expect(readNewWordOrder({ 'study.newWordOrder': 'order' } as unknown as never)).toBe('order')
  })

  it('点击后调用 updateSettings 写 study.newWordOrder', async () => {
    expect(await saveNewWordOrder('random')).toBe('random')
    expect(updateMock).toHaveBeenCalledWith({ 'study.newWordOrder': 'random' })
    expect(await saveNewWordOrder('order')).toBe('order')
    expect(updateMock).toHaveBeenLastCalledWith({ 'study.newWordOrder': 'order' })
  })

  it('非法值不写设置且抛错', async () => {
    await expect(saveNewWordOrder('shuffle')).rejects.toThrow('不合法')
    await expect(saveNewWordOrder('')).rejects.toThrow('不合法')
    expect(updateMock).not.toHaveBeenCalled()
  })

  it('文案说明：当天顺序固定、改学习量保持同一随机序列', () => {
    expect(NEW_WORD_ORDER_HINT).toContain('默认：随机乱序')
    expect(NEW_WORD_ORDER_HINT).toContain('当天')
    expect(NEW_WORD_ORDER_HINT).toContain('顺序固定')
    expect(NEW_WORD_ORDER_HINT).toContain('改学习量')
    expect(NEW_WORD_ORDER_HINT).toContain('随机序列')
  })

  it('渲染：标题/两个选项/说明文案；默认选中「随机乱序」', () => {
    const html = renderToStaticMarkup(
      createElement(NewWordOrderSetting, { value: 'random', onChange: () => undefined }),
    )
    expect(html).toContain('新词顺序')
    expect(html).toContain('词库顺序')
    expect(html).toContain('随机乱序')
    expect(html).toContain('当天计划创建后顺序固定')
    expect(html).toContain('is-active')
    // 默认 random 选中（is-active 在「随机乱序」按钮上）
    expect(html).toContain('is-active" aria-pressed="true">随机乱序')
  })
})
