import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const page = src('ui/decks/AdvancedFilterPage.tsx')
const study = src('ui/study/StudyPage.tsx')
const deck = src('ui/decks/DeckDetailPage.tsx')

describe('task-283 B1 高级筛选器', () => {
  it('属性组/条件/排序/分组/全选/索引集', () => {
    expect(page).toContain('组内 OR')
    expect(page).toContain('组内 AND')
    expect(page).toContain("value=\"and\">AND（全部组满足）")
    expect(page).toContain('不常考状态')
    expect(page).toContain('词根词源状态')
    expect(page).toContain('不熟悉度')
    expect(page).toContain('到期时间')
    expect(page).toContain('按单元分组')
    expect(page).toContain('全选')
    expect(page).toContain('反选')
    expect(page).toContain('取消全选')
    expect(page).toContain('saveFilterSet')
    expect(page).toContain('listSavedFilterSets')
    expect(page).toContain('renameFilterSet')
    expect(page).toContain('advanced-filter-chips')
    expect(page).toContain('saved-filter-card')
    expect(page).toContain('saved-filter-actions')
    expect(page).toContain("updateCondition(gi, ci, { op: 'in', value: next })")
    expect(page).toContain('setSort(set.sort)')
    expect(page).toContain('wordIds: snapshotWordIdsToSave')
    expect(page).toContain('deleteFilterSet')
    expect(src('app/router.tsx')).toContain("path: 'decks/:deckId/filter'")
    expect(deck).toContain('高级筛选')
  })

  it('移除三点 AI 补充内容入口', () => {
    expect(study).not.toContain('AI 补内容（当前词/当前 c）')
  })
})
