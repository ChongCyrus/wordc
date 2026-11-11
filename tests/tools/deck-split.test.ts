import { describe, expect, it } from 'vitest'

// @ts-expect-error 项目未装 @types/node（仅测试读取本地词库 JSON）
import { readFileSync } from 'node:fs'

// @ts-expect-error tools/lib 为 .mjs 纯 helper，无 TS 类型
import { decodeDeckWords, splitMeanings } from '../../tools/lib/deck-words.mjs'

const readDeck = (name: string) => JSON.parse(readFileSync(`src/data/builtin/${name}.deck.json`, 'utf8'))

/** 紧凑词库解码结果（显式类型，避免 tools helper 无 d.ts 导致的 implicit any） */
interface DecodedDeckWord {
  headword: string
  chapter: string
  meanings: Array<{ cn: string }>
}

const decodeDeck = (name: string): DecodedDeckWord[] => decodeDeckWords(readDeck(name)) as DecodedDeckWord[]

describe('内置词库含义拆分口径（受限商业词表/大纲）', () => {
  it('先按换行、再按 ；/; 拆；、/，/| 不拆（同义并列）', () => {
    expect(splitMeanings('n. 拥抱\nvt. 拥抱；信奉，皈依；包含')).toEqual(['n. 拥抱', 'vt. 拥抱', '信奉，皈依', '包含'])
    expect(splitMeanings('a、b；c')).toEqual(['a、b', 'c'])
  })

  it('受限商业词表：6702 词 / 28777 c；必考词 1893 词 / 8845 c', () => {
    const words = decodeDeck('kaoyan-2027-dagang')
    expect(words).toHaveLength(6702)
    expect(words.reduce((n, w) => n + w.meanings.length, 0)).toBe(28777)
    const bikao = words.filter((w) => w.chapter.includes('必考词'))
    expect(bikao).toHaveLength(1893)
    expect(bikao.reduce((n, w) => n + w.meanings.length, 0)).toBe(8845)
  })

  it('大纲：5528 词 / 5530 c（无释义词用 headword 兜底 1 个 c）', () => {
    const words = decodeDeck('kaoyan-2027-dagang')
    expect(words).toHaveLength(5528)
    expect(words.reduce((n, w) => n + w.meanings.length, 0)).toBe(5530)
  })

  it('无释义词不丢：兜底 c 的 cn = headword', () => {
    const words = decodeDeck('kaoyan-2027-dagang')
    const noMeaning = words.filter((w) => w.meanings.length === 1 && w.meanings[0]!.cn === w.headword)
    expect(noMeaning.length).toBeGreaterThan(0)
  })
})
