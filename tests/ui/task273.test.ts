import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

describe('task-273 DeckDetail 死循环回归', () => {
  it('loading 空数组引用稳定；familiarity effect 不无限跑', () => {
    const deck = src('ui/decks/DeckDetailPage.tsx')
    expect(deck).toContain('const EMPTY_WORDS: Word[] = []')
    expect(deck).toContain('page?.words ?? EMPTY_WORDS')
    expect(deck).toContain('if (words.length === 0) return')
    expect(deck).toContain('changed ? next : prev')
    expect(deck).not.toContain('page?.words ?? []')
  })
})
