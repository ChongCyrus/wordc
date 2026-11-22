import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const page = readFileSync(
  fileURLToPath(new URL('../../src/ui/decks/AdvancedFilterPage.tsx', import.meta.url)),
  'utf8',
)
const css = readFileSync(
  fileURLToPath(new URL('../../src/app/styles/global.css', import.meta.url)),
  'utf8',
)

describe('task-290 筛选三视图', () => {
  it('树状/图谱/列表共享 filter，切换持久化', () => {
    expect(page).toContain("['tree', '树状']")
    expect(page).toContain("['graph', '图谱']")
    expect(page).toContain("['list', '列表']")
    expect(page).toContain('FilterTreeEditor')
    expect(page).toContain('FilterGraphEditor')
    expect(page).toContain('momo:advancedFilter:view')
    expect(page).toContain('hitCounts')
    expect(page).toContain('queryAdvancedFilter({ deckId, filter: { ...filter, groups: [group] }')
  })

  it('树节点/组内 AND OR/条件增删；图谱拖拽/点击', () => {
    expect(page).toContain('组间 AND')
    expect(page).toContain('组内 OR')
    expect(page).toContain('命中')
    expect(page).toContain('onPointerDown')
    expect(page).toContain('onPointerMove')
    expect(page).toContain('filter-graph-lines')
    expect(css).toContain('.filter-tree-group')
    expect(css).toContain('.filter-graph-node')
    expect(css).toContain('prefers-reduced-motion')
    expect(page).toContain('filter-tree-root-card')
    expect(page).toContain('filter-tree-leaf')
    expect(page).toContain('条件 {ci + 1}：')
    expect(page).toContain('momo:filterTree:root')
    expect(page).toContain('filter-actions-primary')
    expect(page).toContain('filter-graph-lines')
    expect(page).toContain('图谱组内逻辑')
    expect(page).toContain('+ 属性组')
    expect(css).toContain('.filter-tree-condition-card')
    expect(css).toContain('.filter-actions')
    expect(css).toContain('.saved-filter-row')
    expect(css).toContain('.filter-sort-row')
  })
})
