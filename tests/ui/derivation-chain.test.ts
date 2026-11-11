import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DerivationChain } from '../../src/ui/study/components/DerivationChain'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'

const noop = () => undefined
const meaningBase = {
  meaningId: 'w#M1',
  pos: 'n.',
  cn: '公司',
  clicks: 0,
  encounters: 1,
  familiarity: 0,
}

function annotation(meanings: unknown[]): string {
  return renderToStaticMarkup(
    createElement(AnnotationStage, {
      headword: 'company',
      phonetic: '',
      showPhonetic: false,
      meanings: meanings as never,
      examples: [],
      mnemonics: [],
      phrases: [],
      showPhrases: false,
      speaking: false,
      onSpeak: noop,
      onMarkMeaning: noop,
    }),
  )
}

describe('本义→引申链（task-77）', () => {
  it('渲染「本义① 「…」→ …」；AI 来源追加推演提示', () => {
    const html = renderToStaticMarkup(
      createElement(DerivationChain, {
        steps: ['一起吃面包的人', '一起做事的人', '公司'],
        aiGenerated: true,
      }),
    )
    expect(html).toContain('本义① 「一起吃面包的人」')
    expect(html).toContain('→ 一起做事的人')
    expect(html).toContain('→ 公司')
    expect(html).toContain('AI 推演，仅供参考')
    expect(html).toContain('derivation-chain')
  })

  it('无映射不显示；非 AI 不显示 AI 标识', () => {
    expect(
      renderToStaticMarkup(createElement(DerivationChain, { steps: [] })),
    ).toBe('')
    const html = renderToStaticMarkup(
      createElement(DerivationChain, { steps: ['本义', '引申'] }),
    )
    expect(html).toContain('本义')
    expect(html).not.toContain('AI 推演')
  })

  it('注释面：每个含义行独立显示链；无 mapping 的含义不显示', () => {
    const html = annotation([
      {
        ...meaningBase,
        derivation: { steps: ['一起吃面包的人', '一起做事的人', '公司'], aiGenerated: true },
      },
      { ...meaningBase, meaningId: 'w#M2', cn: '陪伴', pos: 'n.' },
    ])
    expect(html).toContain('本义① 「一起吃面包的人」')
    expect(html).toContain('AI 推演，仅供参考')
    // 第二个 c 无链 → 只出现一次
    expect(html.match(/本义①/g)?.length).toBe(1)
  })

  it('w-c：当前 c 的链随 c 切换更新；长文本使用可换行样式', () => {
    const base = {
      headword: 'company',
      count: 1,
      total: 3,
      phraseLines: [],
      showPhrases: false,
      fontScale: 1,
      cardSize: 1,
      onTap: noop,
    }
    const first = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...base,
        meaningCn: '公司',
        derivation: { steps: ['一起吃面包的人', '公司'] },
      }),
    )
    expect(first).toContain('一起吃面包的人')
    expect(first).toContain('derivation-chain')

    const second = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...base,
        meaningCn: '陪伴',
        derivation: { steps: ['陪伴', '同伴'], aiGenerated: true },
      }),
    )
    expect(second).toContain('陪伴')
    expect(second).not.toContain('一起吃面包的人')
    expect(second).toContain('AI 推演，仅供参考')

    const long = renderToStaticMarkup(
      createElement(DerivationChain, {
        steps: ['很长的本义'.repeat(20), '很长的引申'.repeat(20)],
      }),
    )
    expect(long).toContain('derivation-chain')
  })
})
