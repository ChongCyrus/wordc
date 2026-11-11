import { describe, expect, it } from 'vitest'
import { selectGenerateTargets, targetKey } from '../../../src/data/ai'
import type { TargetSourceWord } from '../../../src/data/ai'

const WORDS: TargetSourceWord[] = [
  {
    wordId: 'deck:embrace',
    headword: 'Embrace',
    meanings: [
      { id: 'deck:embrace#M1', pos: 'n.', cn: '拥抱' },
      { id: 'deck:embrace#M2', pos: 'vt.', cn: '包含' },
    ],
    examples: [],
    phrases: [{ en: 'warm embrace', cn: '拥抱' }],
    mnemonics: [],
  },
  {
    wordId: 'deck:dog',
    headword: 'dog',
    meanings: [{ id: 'deck:dog#M1', pos: 'n.', cn: '狗' }],
    examples: [
      { en: 'a', cn: 'a' },
      { en: 'b', cn: 'b' },
    ],
    phrases: [],
    mnemonics: [],
  },
]

describe('ai/targets · 范围与排除（纯函数）', () => {
  it('targetKey：词级 = headwordLower；含义级 = headwordLower#index', () => {
    expect(targetKey('embrace')).toBe('embrace')
    expect(targetKey('embrace', 2)).toBe('embrace#2')
  })

  it('默认 onlyMissing：已有内容达到 limit 的词跳过（v1 只补缺）', () => {
    const targets = selectGenerateTargets(WORDS, { kind: 'examples' })
    expect(targets.map((t) => t.headwordLower)).toEqual(['embrace']) // dog 已有 2 条 = limit
    expect(targets[0]!.existing).toEqual({ examples: 0, phrases: 1, mnemonics: 0 })
  })

  it('onlyMissing=false：全部词都生成', () => {
    const targets = selectGenerateTargets(WORDS, { kind: 'examples', onlyMissing: false })
    expect(targets.map((t) => t.headwordLower)).toEqual(['embrace', 'dog'])
  })

  it('不同 kind 的已有计数分开判断（词组：embrace 已有 1 < 3，保留）', () => {
    const targets = selectGenerateTargets(WORDS, { kind: 'phrases' })
    expect(targets.map((t) => t.headwordLower)).toEqual(['embrace', 'dog'])
  })

  it('排除 rejectedKeys 与自定义 limits', () => {
    expect(
      selectGenerateTargets(WORDS, { kind: 'examples', rejectedKeys: ['embrace'] }).map((t) => t.headwordLower),
    ).toEqual([])
    expect(
      selectGenerateTargets(WORDS, { kind: 'examples', limits: { examples: 3 } }).map((t) => t.headwordLower),
    ).toEqual(['embrace', 'dog'])
  })

  it('meaningIndex：只生成该含义；越界返回空', () => {
    const [t] = selectGenerateTargets(WORDS, { kind: 'phrases', meaningIndex: 2 })
    expect(t!.meaningIndex).toBe(2)
    expect(t!.meanings).toHaveLength(2)
    expect(selectGenerateTargets(WORDS, { kind: 'phrases', meaningIndex: 9 })).toEqual([])
  })

  it('maxTargets 截断；headwordLower 规范化（大小写）', () => {
    const targets = selectGenerateTargets(WORDS, { kind: 'examples', onlyMissing: false, maxTargets: 1 })
    expect(targets).toHaveLength(1)
    expect(targets[0]!.headword).toBe('Embrace')
    expect(targets[0]!.headwordLower).toBe('embrace')
  })

  it('meaningIndex 的 rejected key 也生效', () => {
    const targets = selectGenerateTargets(WORDS, {
      kind: 'phrases',
      meaningIndex: 1,
      rejectedKeys: ['embrace#1', 'dog#1'],
    })
    expect(targets).toHaveLength(0)
  })
})
