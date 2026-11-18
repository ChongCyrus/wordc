import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'
import { CoreSenseAIPanel } from '../../src/ui/study/components/CoreSenseAIPanel'

const noop = () => undefined
const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const css = src('ui/study/styles/study.css')

describe('task-217 只记本义页助记/例句/词组 + AI 面板', () => {
  it('MemoryStage core-only 显示本义助记/例句，普通 props 不含则隐藏', () => {
    const base = {
      headword: 'denounce',
      meaningCn: '公开宣告',
      count: 1,
      total: 3,
      phraseLines: [{ en: 'denounce the plan', cn: '公开宣布计划' }],
      showPhrases: true,
      fontScale: 1,
      cardSize: 1,
      onTap: noop,
    }
    const core = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...base,
        coreSenseMnemonic: 'de(向下)+nounce(宣布)',
        coreSenseExamples: [{ en: 'He denounced the plan.', cn: '他公开宣布了该计划。' }],
      } as never),
    )
    expect(core).toContain('本义助记')
    expect(core).toContain('de(向下)+nounce(宣布)')
    expect(core).toContain('本义例句')
    expect(core).toContain('He denounced the plan.')
    const normal = renderToStaticMarkup(
      createElement(MemoryStage, { ...base, examples: [{ en: 'c example', cn: 'c 例句' }] } as never),
    )
    expect(normal).not.toContain('本义助记')
    expect(normal).not.toContain('本义例句')
  })

  it('设置 0–3、AI 按钮仅 core-only、数量 0 按钮置灰说明', () => {
    const settings = src('ui/me/SettingsPage.tsx')
    expect(settings).toContain('本义例句数量')
    expect(settings).toContain('本义词组数量')
    expect(settings).toContain("'memory.coreSenseExampleCount'")
    expect(settings).toContain("'memory.coreSensePhraseCount'")
    const page = src('ui/study/StudyPage.tsx')
    expect(page).toContain('core-sense-ai-btn')
    expect(page).toContain('isMemory && study.activeCoreSense')
    const panel = renderToStaticMarkup(
      createElement(CoreSenseAIPanel, {
        open: true,
        wordId: 'deck:denounce',
        word: 'denounce',
        coreSenseIndex: 1,
        label: '公开宣告',
        exampleCount: 0,
        phraseCount: 0,
        onClose: noop,
      }),
    )
    expect(panel).toContain('AI 生成本义助记')
    expect(panel).toContain('AI 生成本义例句')
    expect(panel).toContain('AI 生成本义词组')
    expect(panel).toContain('例句数量为 0（可在设置调整）')
    expect(panel).toContain('词组数量为 0（可在设置调整）')
    expect(css).toContain('.core-sense-ai-btn')
    expect(css).toContain('top: 94px')
    expect(css).toContain('.wc-info-core-mnemonic')
  })

  it('AI 服务预览后保存；注释面不展示本义例句', () => {
    const panel = src('ui/study/components/CoreSenseAIPanel.tsx')
    expect(panel).toContain('generateCoreSenseExamples')
    expect(panel).toContain('generateCoreSensePhrases')
    expect(panel).toContain('saveCoreSenseExamples')
    expect(panel).toContain('saveCoreSensePhrases')
    expect(panel).toContain('AI 结果先预览')
    const annotation = src('ui/study/components/AnnotationStage.tsx')
    expect(annotation).not.toContain('coreSenseExamples')
  })
})
