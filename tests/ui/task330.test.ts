import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const home = src('ui/home/HomePage.tsx')
const toggle = src('ui/components/ThemeToggleButton.tsx')
const me = src('ui/me/MePage.tsx')
const settings = src('ui/me/SettingsPage.tsx')
const stage = src('ui/study/components/RootAffixStage.tsx')

describe('task-330 0.11.1 UI 三项', () => {
  it('首页太阳切换深浅+长按跟随系统，不导航设置', () => {
    expect(home).toContain('ThemeToggleButton')
    expect(home).not.toContain('to="/me/settings"')
    expect(toggle).toContain("setMode(resolved === 'dark' ? 'light' : 'dark')")
    expect(toggle).toContain("setMode('system')")
    expect(toggle).toContain('onContextMenu')
    expect(toggle).toContain("setMode('system')")
  })

  it('我的/设置搜索 + 调试入口默认隐藏', () => {
    expect(me).toContain('<SearchFilterBar')
    expect(settings).toContain('<SearchFilterBar')
    expect(me).toContain('label="调试"')
    expect(me).toContain("navigate('/me/debug')")
    expect(src('app/router.tsx')).toContain("path: 'me/debug'")
  })

  it('根缀卡 compact/standard 设置', () => {
    expect(settings).toContain('词根缀卡片样式')
    expect(settings).toContain("study.rootAffixCardStyle")
    expect(stage).toContain('cardStyle')
    expect(stage).toContain('is-standard')
  })
})
