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

function annotation(meanings: unknown[], coreSenses: Array<{ label: string; note?: string; origin?: string }> = []): string {
  return renderToStaticMarkup(
    createElement(AnnotationStage, {
      headword: 'company',
      phonetic: '',
      showPhonetic: false,
      coreSenses,
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

  it('v4 label 与 steps 分离（task-110）：括号显示 label，不显示 steps[0]', () => {
    const html = renderToStaticMarkup(
      createElement(DerivationChain, {
        label: '技术',
        steps: ['tekhnē 为技艺', '加 -ical 为技术的'],
      }),
    )
    expect(html).toContain('本义① 「技术」')
    expect(html).not.toContain('本义① 「tekhnē 为技艺」')
    expect(html).toContain('→ tekhnē 为技艺')
    // v3 回退：无 label 时 steps[0] 作为本义
    const legacy = renderToStaticMarkup(
      createElement(DerivationChain, { steps: ['一起吃面包的人', '公司'] }),
    )
    expect(legacy).toContain('本义① 「一起吃面包的人」')
  })

  it('本义序号（task-111）：c 归属 coreSenseIndex 渲染 ①②③④/(N)，缺省回退 ①', () => {
    const c2 = renderToStaticMarkup(
      createElement(DerivationChain, { label: '专门', coreSenseIndex: 2, steps: ['加 -ist 表人'] }),
    )
    expect(c2).toContain('本义② 「专门」')
    expect(c2).not.toContain('本义①')

    for (const [index, expected] of [
      [3, '本义③'],
      [4, '本义④'],
      [7, '本义(7)'],
    ] as const) {
      const html = renderToStaticMarkup(
        createElement(DerivationChain, { label: '基础', coreSenseIndex: index, steps: [] }),
      )
      expect(html).toContain(expected)
    }
    const fallback = renderToStaticMarkup(
      createElement(DerivationChain, { label: '技术', steps: [] }),
    )
    expect(fallback).toContain('本义①')
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

  it('注释面顶部列出本义1~n（task-98/101）；三层渲染 + 无 coreSenses 不显示', () => {
    const two = annotation(
      [{ ...meaningBase, derivation: { steps: ['车间', '研讨会'] } }],
      [
        { label: '基础', note: '事物的根本或起点', origin: '希腊 basis=基础' },
        { label: '同伴' },
      ],
    )
    expect(two).toContain('本义1「基础」')
    expect(two).toContain('本义2「同伴」')
    expect(two).toContain('事物的根本或起点')
    expect(two).toContain('词源：希腊 basis=基础')
    // 每个 c 行链保留，不折叠
    expect(two).toContain('本义① 「车间」')

    const single = annotation([meaningBase], [{ label: '公司' }])
    expect(single).toContain('本义1「公司」')
    expect(single).not.toContain('本义2')

    const none = annotation([meaningBase])
    expect(none).not.toContain('core-senses')

    // 旧 v3 违规 label 兜底
    const legacy = annotation([meaningBase], [{ label: '看是否指图纸' }])
    expect(legacy).toContain('本义待重新生成')
    expect(legacy).toContain('原标签：看是否指图纸')
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
