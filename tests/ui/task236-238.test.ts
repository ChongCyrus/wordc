import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'

const noop = () => undefined
const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const panel = src('ui/study/components/SenseMnemonicPanel.tsx')
const overviewEditor = src('ui/study/components/CoreSenseOverviewEditDialog.tsx')
const page = src('ui/study/StudyPage.tsx')
const css = src('ui/study/styles/study.css')

describe('task-236 目标选择', () => {
  it('目标复选框 + 全选/反选/取消 + 空选禁用', () => {
    expect(panel).toContain('sense-targets')
    expect(panel).toContain('本义串联记忆')
    expect(panel).toContain('全选')
    expect(panel).toContain('反选')
    expect(panel).toContain('取消全选')
    expect(panel).toContain("disabled={busy || selectedTargets.size === 0}")
    expect(panel).toContain('AI 生成所选')
    expect(panel).toContain('generateAll({')
    expect(panel).toContain('indexes,')
    expect(panel).toContain('overview: selectedTargets.has(\'overview\')')
  })
})

describe('task-237 串联段落点击编辑', () => {
  it('注释面 overview 可点 + aria；编辑窗保存/清空/AI/取消、层级 testid', () => {
    const html = renderToStaticMarkup(
      createElement(AnnotationStage, {
        headword: 'denounce',
        phonetic: '',
        showPhonetic: false,
        coreSenses: [{ label: '公开宣告' }],
        coreSenseOverview: '串联段落',
        onEditCoreSenseOverview: noop,
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
    expect(html).toContain('core-sense-overview is-editable')
    expect(html).toContain('aria-label="编辑本义串联记忆"')
    expect(overviewEditor).toContain('saveCoreSenseOverview')
    expect(overviewEditor).toContain('clearCoreSenseOverview')
    expect(overviewEditor).toContain('generateCoreSenseOverview')
    expect(overviewEditor).toContain('mm-mask--above-rating-edit')
    expect(overviewEditor).toContain('testId="core-overview-edit-dialog"')
    expect(page).toContain('CoreSenseOverviewEditDialog')
    expect(page).toContain('setOverviewEditOpen(true)')
  })
})

describe('task-238 提示上移+右侧 margin', () => {
  it('core-only padding-top 20、right margin 118（≤360 104）', () => {
    expect(css).toContain('padding-top: 20px')
    expect(css).toContain('margin: 0 118px 6px 16px')
    expect(css).toContain('margin-right: 104px')
    expect(panel).toContain('AI 生成所选')
  })
})
