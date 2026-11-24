import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const deck = src('ui/decks/DeckDetailPage.tsx')
const css = src('app/styles/global.css')

describe('task-329 词库选择底部抽词复习可点击', () => {
  it('bar 避开 tabbar，显式 testid', () => {
    expect(deck).toContain('data-testid="temp-review-bar"')
    expect(deck).toContain('data-testid="temp-review-open"')
    expect(deck).toContain('data-testid="deck-word-row"')
    expect(deck).toContain('aria-pressed=')
    expect(css).toContain('.unit-pick-bar')
    expect(css).toContain('var(--mm-tabbar-h)')
    expect(css).toContain('var(--mm-z-tabbar)')
  })
})
