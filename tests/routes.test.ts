import { describe, expect, it } from 'vitest'
import { ALL_PATHS, NAV_ITEMS, TAB_ITEMS, tabForPath } from '../src/app/routes'

describe('路由骨架（SPEC §8.1 / D38）', () => {
  it('覆盖全部页面路由（含详情页）', () => {
    expect(ALL_PATHS).toEqual([
      '/',
      '/study',
      '/today',
      '/decks',
      '/decks/:deckId',
      '/stats',
      '/me',
      '/me/settings',
      '/me/about',
    ])
  })

  it('底部 tab 栏是 4 个主入口：首页/词库/统计/我的（D38）', () => {
    expect(TAB_ITEMS.map((item) => item.path)).toEqual(['/', '/decks', '/stats', '/me'])
    expect(TAB_ITEMS.every((item) => item.inTabBar)).toBe(true)
  })

  it('学习页是沉浸式全屏，不占底部 tab', () => {
    expect(TAB_ITEMS.some((item) => item.path === '/study')).toBe(false)
    const study = NAV_ITEMS.find((item) => item.path === '/study')
    expect(study).toBeDefined()
    expect(study?.inTabBar).toBe(false)
  })

  it('每个导航项都有非空文案与标题', () => {
    for (const item of NAV_ITEMS) {
      expect(item.label.length).toBeGreaterThan(0)
      expect(item.title.length).toBeGreaterThan(0)
      expect(item.path.startsWith('/')).toBe(true)
    }
  })

  it('tab 激活判断：首页精确匹配、词库详情归属词库 tab、学习页无 tab', () => {
    expect(tabForPath('/')?.path).toBe('/')
    expect(tabForPath('/decks')?.path).toBe('/decks')
    expect(tabForPath('/decks/test-deck')?.path).toBe('/decks')
    expect(tabForPath('/stats')?.path).toBe('/stats')
    expect(tabForPath('/me')?.path).toBe('/me')
    expect(tabForPath('/me/settings')).toBeUndefined()
    expect(tabForPath('/study')).toBeUndefined()
  })
})
