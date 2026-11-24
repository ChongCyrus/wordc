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
const css = src('ui/me/me.css')

describe('task-256 存储诊断 + 导出备份到下载', () => {
  it('数据页入口/文案/内部存储说明', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/me/import-export'] },
        createElement(AppProviders, null, createElement(AppRoutes, null)),
      ),
    )
    expect(html).toContain('自动备份（每次启动）')
    expect(html).toContain('每次启动学习时自动备份')
    expect(html).toContain('导出备份到下载')
    expect(html).toContain('自动备份（每次启动）')
    const debugHtml = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/me/debug'] },
        createElement(AppProviders, null, createElement(AppRoutes, null)),
      ),
    )
    expect(debugHtml).toContain('存储诊断')
    expect(me).toContain('readDiagnosticFile')
    expect(me).toContain('exportBackupToDownloads')
    expect(me).toContain('navigator.clipboard.writeText')
    expect(me).toContain('navigator.share')
    expect(me).toContain('当前环境不支持读取内部诊断')
    expect(me).toContain('导出到 Download 目录')
    expect(css).toContain('.mm-mask.mm-mask--storage-diagnostic')
    expect(css).toContain('background: var(--mm-surface)')
    expect(css).toContain('overflow: auto')
  })
})
