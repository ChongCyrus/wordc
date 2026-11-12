import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ContentPackList,
  packExportFileName,
  type ContentPackRow,
} from '../../src/ui/me/ContentPackManagerSection'

const rows: ContentPackRow[] = [
  { id: 'p1', name: 'AI 生成', kind: 'examples', items: 12, applied: 10, source: 'ai', createdAt: 1 },
]

describe('内容包管理（task-86）', () => {
  it('列表渲染名称/kind/条数/已应用/来源 + 导出/删除/全部', () => {
    const html = renderToStaticMarkup(
      createElement(ContentPackList, {
        rows,
        onExport: () => undefined,
        onExportAll: () => undefined,
        onDelete: () => undefined,
      }),
    )
    expect(html).toContain('AI 生成')
    expect(html).toContain('examples · 12 条（已应用 10）')
    expect(html).toContain('来源 ai')
    expect(html).toContain('导出')
    expect(html).toContain('删除')
    expect(html).toContain('导出全部')
  })

  it('空态提示', () => {
    const html = renderToStaticMarkup(
      createElement(ContentPackList, {
        rows: [],
        onExport: () => undefined,
        onExportAll: () => undefined,
        onDelete: () => undefined,
      }),
    )
    expect(html).toContain('还没有导入过内容包')
    expect(html).not.toContain('导出全部')
  })

  it('导出文件名：安全字符 + 日期 + .pack.json', () => {
    expect(packExportFileName('AI/生成', 'examples', '2026-11-12')).toBe('AI-生成-2026-11-12.pack.json')
    expect(packExportFileName('', 'phrases', '2026-11-12')).toBe('phrases-2026-11-12.pack.json')
  })
})
