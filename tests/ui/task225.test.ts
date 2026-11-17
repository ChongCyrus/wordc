import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'

const noop = () => undefined
const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)
const html = renderToStaticMarkup(
  createElement(MemoryStage, {
    headword: 'denounce',
    meaningCn: '公开宣告',
    count: 0,
    total: 3,
    phraseLines: [],
    showPhrases: false,
    fontScale: 1,
    cardSize: 1,
    rootLabel: 'fixture本义',
    onTap: noop,
  } as never),
)

describe('task-225 w-c 记忆页顶部提示', () => {
  it('memory 页显示提示，位于卡片/root 行之前且不挡内容', () => {
    expect(html).toContain('请记忆下述映射，并记忆一个相关词组及其意象')
    const reminder = html.indexOf('wc-memory-reminder')
    const root = html.indexOf('wc-root-row')
    const card = html.indexOf('wc-card')
    expect(reminder).toBeGreaterThan(-1)
    expect(reminder).toBeLessThan(root)
    expect(reminder).toBeLessThan(card)
  })

  it('core-only 顶部控件存在时提示预留右侧安全区', () => {
    const withControls = renderToStaticMarkup(
      createElement(MemoryStage, {
        headword: 'denounce',
        meaningCn: '公开宣告',
        count: 0,
        total: 3,
        phraseLines: [],
        showPhrases: false,
        fontScale: 1,
        cardSize: 1,
        hasTopControls: true,
        onTap: noop,
      } as never),
    )
    expect(withControls).toContain('wc-memory-reminder--with-controls')
    expect(css).toContain('.wc-memory-reminder--with-controls')
    expect(css).toContain('padding-right: 118px')
    expect(css).toContain('text-align: left')
  })

  it('样式 12px 浅色、自动换行、不溢出', () => {
    expect(css).toContain('.wc-memory-reminder')
    expect(css).toContain('font-size: 12px')
    expect(css).toContain('color: var(--mm-text-3)')
    expect(css).toContain('white-space: normal')
    expect(css).toContain('overflow-wrap: anywhere')
  })
})
