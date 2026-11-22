import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const indicator = src('ui/components/GeneratedSeedIndicator.tsx')
const hook = src('app/hooks/useGeneratedSeedStatus.ts')
const me = src('ui/me/MePage.tsx')
const shell = src('app/layout/AppShell.tsx')
const css = src('app/styles/global.css')

describe('task-272 预装内容导入可视化', () => {
  it('全局轻提示：running 显示 x/y、完成/失败 toast、AppShell 挂载', () => {
    expect(hook).toContain('getGeneratedSeedStatus')
    expect(hook).toContain('forceImportDefaultGeneratedData')
    expect(indicator).toContain('预装内容导入中')
    expect(indicator).toContain('本义助记')
    expect(indicator).toContain('下次启动重试')
    expect(indicator).toContain("status.state !== 'running'")
    expect(shell).toContain('GeneratedSeedIndicator')
    expect(css).toContain('.generated-seed-indicator')
  })

  it('数据页预装内容状态行：Web 提示/未开始/导入中/完成/失败立即导入', () => {
    expect(me).toContain('预装内容')
    expect(me).toContain('浏览器版不含预装数据')
    expect(me).toContain('导入中')
    expect(me).toContain('已完成：本义助记')
    expect(me).toContain('立即导入')
    expect(me).toContain('useGeneratedSeedStatus')
  })
})
