import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { phrasesForMeaning } from '../../src/ui/study/lib/memory-phrases'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'

const PHRASES = [
  { en: 'abandon ship', cn: '弃船', meaningId: 'w#M1' },
  { en: 'abandon hope', cn: '放弃希望', meaningId: 'w#M1' },
  { en: 'with abandon', cn: '放纵地', meaningId: 'w#M2' },
  { en: 'abandon oneself to', cn: '沉溺于', meaningId: null },
  { en: 'abandonment', cn: '遗弃（词级）' },
]

describe('w-c 词组按当前含义过滤（task-43）', () => {
  it('只保留 meaningId === 当前含义的词组', () => {
    const m1 = phrasesForMeaning(PHRASES, 'w#M1')
    expect(m1.map((phrase) => phrase.en)).toEqual(['abandon ship', 'abandon hope'])
    expect(m1.every((phrase) => !phrase.en.includes('with abandon'))).toBe(true)
  })

  it('切换 c（M1 → M2）后词组即时变化，只显示新 c 的', () => {
    expect(phrasesForMeaning(PHRASES, 'w#M2').map((phrase) => phrase.en)).toEqual([
      'with abandon',
    ])
    expect(phrasesForMeaning(PHRASES, 'w#M1').map((phrase) => phrase.en)).not.toContain(
      'with abandon',
    )
  })

  it('meaningId 为 null / 缺失的词组（词级）在 w-c 不显示，也不硬猜', () => {
    const m1 = phrasesForMeaning(PHRASES, 'w#M1').map((phrase) => phrase.en)
    expect(m1).not.toContain('abandon oneself to')
    expect(m1).not.toContain('abandonment')
    // 当前含义为 null / 不存在 → 整块为空
    expect(phrasesForMeaning(PHRASES, null)).toEqual([])
    expect(phrasesForMeaning(PHRASES, undefined)).toEqual([])
    expect(phrasesForMeaning(PHRASES, 'w#M9')).toEqual([])
  })

  it('最多 3 条；limit=0 返回空', () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      en: `phrase ${index}`,
      cn: `词组${index}`,
      meaningId: 'w#M1',
    }))
    expect(phrasesForMeaning(many, 'w#M1')).toHaveLength(3)
    expect(phrasesForMeaning(many, 'w#M1', 0)).toEqual([])
    expect(phrasesForMeaning(many, 'w#M1', 5)).toHaveLength(5)
  })

  it('无匹配时 MemoryStage 不渲染词组块（整块隐藏）', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryStage, {
        headword: 'abandon',
        meaningCn: '放弃',
        count: 0,
        total: 3,
        phraseLines: phrasesForMeaning(PHRASES, 'w#M9'),
        showPhrases: true,
        fontScale: 1,
        cardSize: 1,
        onTap: () => undefined,
      }),
    )
    expect(html).not.toContain('wc-phrases')
  })

  it('有匹配时 MemoryStage 只渲染当前 c 的词组；开关关闭则全隐藏', () => {
    const lines = phrasesForMeaning(PHRASES, 'w#M1')
    const html = renderToStaticMarkup(
      createElement(MemoryStage, {
        headword: 'abandon',
        meaningCn: '放弃',
        count: 1,
        total: 3,
        phraseLines: lines,
        showPhrases: true,
        fontScale: 1,
        cardSize: 1,
        onTap: () => undefined,
      }),
    )
    expect(html).toContain('abandon ship — 弃船')
    expect(html).toContain('abandon hope — 放弃希望')
    expect(html).not.toContain('with abandon')
    expect(html).not.toContain('abandonment')

    const off = renderToStaticMarkup(
      createElement(MemoryStage, {
        headword: 'abandon',
        meaningCn: '放弃',
        count: 1,
        total: 3,
        phraseLines: lines,
        showPhrases: false,
        fontScale: 1,
        cardSize: 1,
        onTap: () => undefined,
      }),
    )
    expect(off).not.toContain('wc-phrases')
    expect(off).not.toContain('abandon ship')
  })
})
