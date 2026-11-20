import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const deck = src('ui/decks/DeckDetailPage.tsx')
const unit = src('ui/decks/UnitDetailPage.tsx')
const ai = src('ui/ai/AiGeneratePanel.tsx')

describe('task-267 选择模式隐藏旧筛选 + AI 预选计数', () => {
  it('DeckDetail 选择态隐藏搜索/状态筛选，退出恢复；UnitDetail 仅工具条', () => {
    expect(deck).toContain('{!selectMode ? (')
    expect(deck).toContain('SegmentedControl<Filter>')
    expect(deck).toContain('className="mm-search"')
    expect(deck).toContain('{selectMode ? (')
    expect(unit).not.toContain('className="mm-search"')
    expect(unit).not.toContain('unit-filter')
  })

  it('AI 面板预选计数不出现 已选1/共0', () => {
    expect(ai).toContain('Math.max(customTotal, selectedWordIds.length)')
    expect(ai).not.toContain('已选 {selectedWordIds.length} / 共 {customTotal}')
  })
})
