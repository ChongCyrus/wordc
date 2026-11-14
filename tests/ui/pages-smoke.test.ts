/**
 * 页面渲染冒烟测试（node SSR）：
 * 在 MemoryRouter 中把 8 条路由各渲染一次，确保页面组件不抛错、静态骨架可渲染。
 * 数据 hook 在 SSR 下返回 undefined（loading 态），因此不会真正读 IndexedDB。
 */
import 'fake-indexeddb/auto'

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
import { BRAND } from '../../src/app/brand'
import { AppProviders } from '../../src/app/providers'
import { AppRoutes } from '../../src/app/router'

function renderRoute(path: string): string {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [path] },
      createElement(AppProviders, null, createElement(AppRoutes, null)),
    ),
  )
}

describe('页面渲染冒烟（8 条路由）', () => {
  it('首页：显示「今日」与加载态，不抛错', () => {
    const html = renderRoute('/')
    expect(html).toContain('今日')
    expect(html).toContain('tabbar')
    expect(html).toContain('首页')
  })

  it('学习页：全屏沉浸式（无底部 Tab），初始加载文案', () => {
    const html = renderRoute('/study')
    expect(html).toContain('study-page')
    expect(html).toContain('正在加载今日学习')
    expect(html).not.toContain('class="tabbar"')
  })

  it('词库页：标题 + 新建/导入入口', () => {
    const html = renderRoute('/decks')
    expect(html).toContain('词库')
    expect(html).toContain('新建词库')
    expect(html).toContain('导入词库')
  })

  it('词库详情页：返回按钮 + 加载态', () => {
    const html = renderRoute('/decks/test-deck')
    expect(html).toContain('正在加载词库')
    expect(html).toContain('aria-label="返回"')
  })

  it('今日单词页：标题 + 加载态（task-50）', () => {
    const html = renderRoute('/today')
    expect(html).toContain('今日单词')
    expect(html).toContain('正在加载今日单词')
  })

  it('统计页：标题 + 加载态', () => {
    const html = renderRoute('/stats')
    expect(html).toContain('统计')
    expect(html).toContain('正在统计数据')
  })

  it('我的页：头像卡 + 设置/关于入口 + 深色模式开关', () => {
    const html = renderRoute('/me')
    expect(html).toContain('学习者')
    expect(html).toContain('aria-label="深色模式"')
    expect(html).toContain('设置')
    expect(html).toContain('关于')
  })

  it('我的页使用说明：含「从最共性本义出发」引导段（task-145）', () => {
    const html = renderRoute('/me')
    expect(html).toContain('使用说明')
    expect(html).toContain('最共性的本义出发')
    expect(html).toContain('生成元')
    expect(html).toContain('按场景/作用对象/词性引申')
    expect(html).toContain('usage-guide-note')
    const start = html.lastIndexOf('<p', html.indexOf('每次回忆时'))
    const block = html.slice(start, html.indexOf('</p>', start) + 4)
    expect(block).toContain('usage-guide-note')
    expect(block).not.toContain('mm-row-sub')
    expect(block).toContain('-webkit-line-clamp:unset')
  })

  it('设置页：返回 + 加载态', () => {
    const html = renderRoute('/me/settings')
    expect(html).toContain('正在加载设置')
    expect(html).toContain('aria-label="返回"')
  })

  it('关于页：版本 / 算法说明 / 词库说明（D11/D30，task-62 按 BRAND 条件断言）', () => {
    const html = renderRoute('/me/about')
    expect(html).toContain('同源 MM/DHP 调度模型')
    expect(html).toContain('开源许可')
    if (BRAND.deckNotice) {
      // 私版：完整第三方词库版权说明
      expect(html).toContain(BRAND.deckNotice)
    } else {
      // 公开版：省略第三方说明字段 → 通用合规文案，且不出现受限词表名
      expect(html).toContain('FEATURES-COMPLIANCE')
      expect(html).toContain('THIRD-PARTY-NOTICES')
      expect(html).not.toContain('受限商业词表')
    }
  })

  it('未知路由：404 页兜底', () => {
    const html = renderRoute('/not-exist')
    expect(html).toContain('页面不存在')
  })
})
