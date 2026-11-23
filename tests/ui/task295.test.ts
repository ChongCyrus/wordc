import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const filter = src('ui/decks/AdvancedFilterPage.tsx')
const generate = src('ui/decks/GeneratePage.tsx')

describe('task-295 筛选页返回恢复', () => {
  it('AI/临时前 stash 条件+排序+已选，返回带 restore=1', () => {
    expect(filter).toContain('momo:filterPageStash:')
    expect(filter).toContain('resultTotal')
    expect(filter).toContain("searchParams.get('restore')")
    expect(filter).toContain('setFilter(stash.filter)')
    expect(filter).toContain('setSelected(stash.selected)')
    expect(filter).toContain('queryAdvancedFilter({')
    expect(generate).toContain('/filter?restore=1')
    expect(filter).toContain('/decks/${deckId}/filter?restore=1')
  })

  it('恢复后清理 stash', () => {
    expect(filter).toContain('removeItem(stashKey)')
  })
})
