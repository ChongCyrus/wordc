import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  ContentPackList,
  countDuplicatePacks,
  dedupeSummary,
  packSourceLabel,
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
        onRecheckBuiltin: () => undefined,
        onResetSemantics: () => undefined,
      }),
    )
    expect(html).toContain('AI 生成')
    expect(html).toContain('examples · 已应用 10 / 总 12')
    expect(html).toContain('来源 ai')
    expect(html).toContain('导出')
    expect(html).toContain('删除')
    expect(html).toContain('导出全部')
    expect(html).toContain('重新检查内置内容')
    expect(html).toContain('重置本义数据')
  })

  it('N<M 时显示「重新应用」入口；相等时不显示', () => {
    const withReapply = renderToStaticMarkup(
      createElement(ContentPackList, {
        rows,
        onExport: () => undefined,
        onExportAll: () => undefined,
        onDelete: () => undefined,
        onReapply: () => undefined,
      }),
    )
    expect(withReapply).toContain('重新应用')

    const complete = renderToStaticMarkup(
      createElement(ContentPackList, {
        rows: [{ ...rows[0]!, applied: 12 }],
        onExport: () => undefined,
        onExportAll: () => undefined,
        onDelete: () => undefined,
        onReapply: () => undefined,
      }),
    )
    expect(complete).not.toContain('重新应用')
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

  it('重复包检测（task-93）：同名/kind/条目数计重复', () => {
    expect(countDuplicatePacks(rows)).toBe(0)
    expect(countDuplicatePacks([...rows, { ...rows[0]!, id: 'p2' }])).toBe(1)
    const html = renderToStaticMarkup(
      createElement(ContentPackList, {
        rows: [...rows, { ...rows[0]!, id: 'p2' }],
        onExport: () => undefined,
        onExportAll: () => undefined,
        onDelete: () => undefined,
        onDedupe: () => undefined,
      }),
    )
    expect(html).toContain('检测到 1 个重复内容包')
    expect(html).toContain('清理重复内容包')
  })

  it('来源标签与草稿过滤辅助（task-116）', () => {
    expect(packSourceLabel('builtin')).toBe('内置')
    expect(packSourceLabel('ai')).toBe('AI')
    expect(packSourceLabel('import')).toBe('手工')
    expect(packSourceLabel('ai', true)).toBe('草稿')
  })

  it('清理结果文案（task-93）', () => {
    expect(dedupeSummary(3, 1)).toBe('已清理 3 个重复内容包（保留 1 个）')
  })

  it('导出文件名：安全字符 + 日期 + .pack.json', () => {
    expect(packExportFileName('AI/生成', 'examples', '2026-11-12')).toBe('AI-生成-2026-11-12.pack.json')
    expect(packExportFileName('', 'phrases', '2026-11-12')).toBe('phrases-2026-11-12.pack.json')
  })
})
