import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { AppProviders } from '../../src/app/providers'
import { AppRoutes } from '../../src/app/router'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const me = src('ui/me/MePage.tsx')
const gate = src('ui/me/AutoBackupStartupGate.tsx')
const shell = src('app/layout/AppShell.tsx')

describe('task-255 自动备份 UI', () => {
  it('数据页自动备份区：最近备份/开关/立即备份/恢复/持久化/Web 手动导出', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/me'] },
        createElement(AppProviders, null, createElement(AppRoutes, null)),
      ),
    )
    expect(html).toContain('自动备份')
    expect(html).toContain('自动备份（每次启动）')
    expect(html).toContain('立即备份')
    expect(html).toContain('从自动备份恢复')
    expect(html).toContain('持久化存储')
    expect(html).toContain('浏览器版请手动导出')
    expect(me).toContain('data.autoBackupEnabled')
    expect(me).toContain('ensurePersistentStorage')
    expect(me).toContain('restoreAutoBackupForUi')
    expect(me).toContain('startupAutoBackup({ force: true })')
    expect(me).toContain('恢复前会先备份当前数据')
  })

  it('启动异常弹窗：只启动检查一次、列备份、恢复/暂不恢复、报告', () => {
    expect(shell).toContain('AutoBackupStartupGate')
    expect(gate).toContain('startupAutoBackup()')
    expect(gate).toContain('检测到学习进度异常')
    expect(gate).toContain('listAutoBackupsForUi()')
    expect(gate).toContain('restoreAutoBackupForUi(name)')
    expect(gate).toContain('暂不恢复')
    expect(gate).toContain('恢复中')
    expect(gate).toContain('started = true')
  })
})
