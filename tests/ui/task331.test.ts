import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const me = src('ui/me/MePage.tsx')
const ie = src('ui/me/ImportExportPage.tsx')
const dbg = src('ui/me/DebugPage.tsx')
const router = src('app/router.tsx')
const search = src('ui/components/SearchFilterBar.tsx')
const settings = src('ui/me/SettingsPage.tsx')

describe('task-331 独立调试/导入导出页 + 搜索', () => {
  it('独立路由/返回/入口，主列表不再铺开', () => {
    expect(router).toContain("path: 'me/debug'")
    expect(router).toContain("path: 'me/import-export'")
    expect(me).toContain("navigate('/me/debug')")
    expect(me).toContain("navigate('/me/import-export')")
    expect(dbg).toContain('backTo="/me"')
    expect(ie).toContain('backTo="/me"')
    expect(ie).toContain('导出学习进度')
    expect(ie).toContain('导入学习进度')
    expect(ie).toContain('导出安全诊断包')
  })

  it('搜索主 return 渲染 + display 过滤（不是 hidden 属性）', () => {
    expect(settings).toContain('<SearchFilterBar placeholder="搜索设置" />')
    expect(me).toContain('<SearchFilterBar')
    expect(search).toContain('row.style.display = match')
    expect(search).not.toContain('row.hidden')
    expect(search).toContain("row.style.display = match ? '' : 'none'")
  })
})
