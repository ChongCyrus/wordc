import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { ToastProvider } from '../../src/app/toast'
import { SenseMnemonicPanel, senseMnemonicLabel } from '../../src/ui/study/components/SenseMnemonicPanel'
import { SenseMnemonicBatchPanel } from '../../src/ui/study/components/SenseMnemonicBatchPanel'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'

const noop = () => undefined
const source = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

describe('task-200 本义助记', () => {
  it('文案区分映射助记；面板/批量面板可渲染', () => {
    expect(senseMnemonicLabel(2, '边缘')).toContain('本义助记·本义2「边缘」')
    const panel = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(SenseMnemonicPanel, {
          open: true,
          wordId: 'deck:margin',
          word: 'margin',
          onClose: noop,
        }),
      ),
    )
    expect(panel).toContain('本义助记 · margin')
    expect(panel).toContain('AI 生成所选')
    expect(panel).toContain('批量生成')
    expect(panel).toContain('该词暂无本义数据')
    const batch = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(SenseMnemonicBatchPanel, {
          open: true,
          currentWordId: 'deck:margin',
          onClose: noop,
        }),
      ),
    )
    expect(batch).toContain('批量生成本义助记')
    expect(batch).toContain('当前词')
    expect(batch).toContain('今日计划')
    expect(batch).toContain('当前词库')
    expect(batch).toContain('覆盖已有 AI 助记')
    expect(batch).toContain('并发数')
  })

  it('注释面渲染本义助记与按钮，与映射助记分区', () => {
    const html = renderToStaticMarkup(
      createElement(AnnotationStage, {
        headword: 'margin',
        phonetic: '',
        showPhonetic: false,
        coreSenses: [{ label: '边缘', note: '本义说明' }],
        senseMnemonics: [{ coreSenseIndex: 1, label: '边缘', text: 'margin=边缘', source: 'ai' }],
        onOpenSenseMnemonicPanel: noop,
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
    expect(html).toContain('AI 本义助记')
    expect(html).toContain('本义助记·本义1「边缘」')
    expect(html).toContain('margin=边缘')
    expect(html).toContain('core-sense-mnemonic')
  })

  it('StudyPage 接 listSenseMnemonicViews/SenseMnemonicPanel；AI 调用 generate/apply', () => {
    const page = source('ui/study/StudyPage.tsx')
    expect(page).toContain('listSenseMnemonicViews')
    expect(page).toContain('SenseMnemonicPanel')
    const panel = source('ui/study/components/SenseMnemonicPanel.tsx')
    expect(panel).toContain('generateSenseMnemonicBatch')
    expect(panel).toContain('applySenseMnemonicSuggestions')
    // task-203：并发生成/取消/逐项状态/点击行编辑
    expect(panel).toContain('onProgress')
    expect(panel).toContain('AbortController')
    expect(panel).toContain('取消生成')
    expect(panel).toContain('sense-mnemonic-row--clickable')
    expect(panel).toContain('本义助记内容')
    expect(panel).toContain('生成中…')
    expect(panel).toContain('正在加载本义助记…')
    expect(panel).toContain('本义已变化：旧助记')
    expect(panel).toContain('覆盖已有 AI 助记')
    const batch = source('ui/study/components/SenseMnemonicBatchPanel.tsx')
    expect(batch).toContain('generateSenseMnemonicBatch')
    expect(batch).toContain('onProgress')
    expect(batch).toContain('skippedManual')
    expect(batch).toContain('stale')
  })
})
