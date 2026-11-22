import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { MemoryRouter } from 'react-router-dom'
import { AppProviders } from '../../src/app/providers'
import { AppRoutes } from '../../src/app/router'

const source = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)
const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/me.css', import.meta.url)),
  'utf8',
)

describe('task-228 本义助记导出/导入', () => {
  it('数据页并列入口、文案区分', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/me'] },
        createElement(AppProviders, null, createElement(AppRoutes, null)),
      ),
    )
    expect(html).toContain('导出本义助记')
    expect(html).toContain('导入本义助记')
    expect(html).toContain('导出学习进度')
    expect(source).toContain('buildCoreSenseMnemonicExport')
    expect(source).toContain('exportCoreSenseMnemonicJson')
    expect(source).toContain('previewCoreSenseMnemonicImport')
    expect(source).toContain('applyCoreSenseMnemonicImport')
  })

  it('导出四项统计、当前词库禁用提示', () => {
    expect(source).toContain('词数')
    expect(source).toContain('已有助记')
    expect(source).toContain('待生成')
    expect(source).toContain('disabled={coreExportBusy || !currentDeckId}')
    expect(source).toContain('未选择当前词库')
    expect(source).toContain("buildCoreSenseMnemonicExport(")
  })

  it('导入默认合并、覆盖二次警告、stale/结果报告、错误不清空', () => {
    expect(source).toContain('默认合并：不覆盖已有 AI/手改')
    expect(source).toContain('确认导入（合并）')
    expect(source).toContain('确认覆盖导入')
    expect(source).toContain('我确认覆盖已有助记')
    expect(source).toContain('stale')
    expect(source).toContain('coreOverwriteConfirmed')
    expect(source).toContain('已有数据未清空')
    expect(css).toContain('.core-io-dialog')
    expect(css).toContain('.core-io-strategy')
    expect(css).toContain('.core-io-warning')
  })
})
