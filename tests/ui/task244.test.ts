import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'

const noop = () => undefined
const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const gen = src('ui/study/components/GenerativeMemoryStage.tsx')
const css = src('ui/study/styles/study.css')
const base = {
  headword: 'denounce',
  meaningCn: '公开宣告',
  count: 1,
  total: 3,
  phraseLines: [],
  showPhrases: false,
  fontScale: 1,
  cardSize: 1,
  rootLabel: 'fixture本义',
  examples: [{ en: 'He denounced the plan.', cn: '他公开宣布了计划。' }],
  mnemonics: [{ type: '联想', text: '助记文本' }],
  onTap: noop,
}

describe('task-244 hidden 词性 + ↓ ?', () => {
  it('hidden 显示当前 pos + ↓ + ?，中文/注释仍隐藏，aria 不泄露', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...base,
        meaningPos: '动',
        memoryPhase: 'hidden',
        showMeaning: false,
        derivation: { steps: ['本义步骤', '引申步骤'] },
      } as never),
    )
    expect(html).toContain('[动]')
    expect(html).toContain('wc-hidden-arrow')
    expect(html).toContain('?')
    expect(html.indexOf('wc-word')).toBeLessThan(html.indexOf('wc-hidden-arrow'))
    expect(html.indexOf('wc-hidden-arrow')).toBeLessThan(html.indexOf('wc-hidden-question-row'))
    expect(html).not.toContain('公开宣告')
    expect(html).not.toContain('fixture本义')
    expect(html).not.toContain('derivation-chain')
    expect(html).not.toContain('他公开宣布了计划')
    expect(html).not.toContain('助记文本')
  })

  it('final-hidden 去重 pos 列表 + ↓ ? + 满圈，无中文', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...base,
        memoryPhase: 'final-hidden',
        showMeaning: false,
        summaryEntries: [
          { meaningId: 'M1', kind: 'meaning', pos: '动', cn: '谴责' },
          { meaningId: 'M2', kind: 'meaning', pos: '动', cn: '告发' },
          { meaningId: 'M3', kind: 'meaning', pos: '名', cn: '谴责' },
        ],
      } as never),
    )
    expect(html).toContain('[动]')
    expect(html).toContain('[名]')
    expect((html.match(/\[动\]/g) ?? []).length).toBe(1)
    expect(html).toContain('↓')
    expect(html).toContain('?')
    expect(html).not.toContain('谴责')
    expect(html).not.toContain('告发')
  })

  it('生成式阶段2 hidden 有 ↓ ?，无生成元/映射；CSS 断言', () => {
    expect(gen).toContain('!phase2ShowMeaning')
    expect(gen).toContain('wc-hidden-arrow')
    expect(gen).toContain('wc-hidden-question')
    expect(css).toContain('.wc-hidden-question-row')
    expect(css).toContain('.wc-hidden-arrow')
    expect(css).toContain('.wc-hidden-question')
    expect(css).toContain('font-size: 38px')
    expect(css).toContain('align-items: baseline')
  })
})
