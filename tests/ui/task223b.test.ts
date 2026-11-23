import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'

const noop = () => undefined
const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

describe('task-223 本义解释/串联记忆', () => {
  it('只记本义页显示解释小字与串联记忆；无则不显示', () => {
    const base = {
      headword: 'denounce',
      meaningCn: '公开宣告',
      count: 0,
      total: 2,
      phraseLines: [],
      showPhrases: false,
      fontScale: 1,
      cardSize: 1,
      onTap: noop,
    }
    const shown = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...base,
        coreSenseGloss: '当众斥其非',
        coreSenseOverview: '本义串联段落',
      } as never),
    )
    expect(shown).toContain('当众斥其非')
    expect(shown).toContain('本义串联记忆')
    expect(shown).toContain('本义串联段落')
    const none = renderToStaticMarkup(createElement(MemoryStage, base as never))
    expect(none).not.toContain('本义串联记忆')
  })

  it('注释面顶部显示串联记忆', () => {
    const html = renderToStaticMarkup(
      createElement(AnnotationStage, {
        headword: 'denounce',
        phonetic: '',
        showPhonetic: false,
        coreSenses: [{ label: '公开宣告', note: '当众斥其非' }],
        coreSenseOverview: '注释面串联段落',
        meanings: [],
        examples: [],
        mnemonics: [],
        phrases: [],
        showPhrases: false,
        speaking: false,
        onSpeak: noop,
        onMarkMeaning: noop,
      } as never),
    )
    expect(html).toContain('本义串联记忆')
    expect(html).toContain('注释面串联段落')
  })

  it('串联与 AI 助记共用生成入口：无独立按钮，apply 一并保存；单条重生成不触碰 overview', () => {
    const panel = src('ui/study/components/SenseMnemonicPanel.tsx')
    expect(panel).not.toContain('>AI 生成本义串联记忆<')
    expect(panel).toContain('generateCoreSenseOverview(source, config)')
    expect(panel).toContain('saveCoreSenseOverview')
    expect(panel).toContain("本义串联记忆{overviewSuggestion ? '（AI 建议）' : ''}")
    expect(panel).toContain('applySenseMnemonicSuggestions')
    // 单条重新生成只写 senseMnemonics；串联只在生成全部时调用一次
    expect(panel).toContain('generateSenseMnemonic(source, config)')
    expect((panel.match(/generateCoreSenseOverview\(/g) ?? []).length).toBeGreaterThanOrEqual(1)
    const editorRegenerate = panel.slice(panel.indexOf('重新生成'))
    expect(editorRegenerate).toContain('generateSenseMnemonic(source, config)')
    expect(editorRegenerate).not.toContain('generateCoreSenseOverview(')
    const page = src('ui/study/StudyPage.tsx')
    expect(page).toContain('getCoreSenseOverview')
    expect(page).toContain('coreSenseOverview={coreSenseOverview}')
  })
})
