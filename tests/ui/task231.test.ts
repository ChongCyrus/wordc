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
const css = src('ui/study/styles/study.css')
const page = src('ui/study/StudyPage.tsx')
const panel = src('ui/study/components/SenseMnemonicPanel.tsx')
const editor = src('ui/study/components/SenseMnemonicEditDialog.tsx')
const me = src('ui/me/MePage.tsx')
const meCss = src('ui/me/me.css')

describe('task-231', () => {
  it('A：多行富文本提示、圆圈列表、memory 页', () => {
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
        onTap: noop,
      } as never),
    )
    expect(html).toContain('词根词缀法记忆流程')
    expect(html).toContain('记忆词根/词缀的含义')
    expect(html).toContain('wc-root-process-list')
    expect(html).toContain('<li>')
        expect(css).toContain('list-style-type: circle')
    expect(css).toContain('font-size: 12px')
    expect(css).toContain('memory-stage--with-top-controls')
    expect(css).toContain('padding-top: 20px')
  })

  it('B/C：注释面点助记段落只开独立编辑窗（不打开面板），编辑层叠于面板之上', () => {
    expect(page).toContain('SenseMnemonicEditDialog')
    expect(page).toContain('setSenseEditDialog({ coreSenseIndex, label, text })')
    const annotationEdit = page.slice(page.indexOf('onEditSenseMnemonic='), page.indexOf('onOpenSenseMnemonicPanel='))
    expect(annotationEdit).not.toContain('setSensePanelOpen(true)')
    expect(editor).toContain('mm-mask--above-rating-edit')
    expect(editor).toContain('testId="sense-edit-dialog"')
    expect(panel).toContain('testId="sense-panel"')
    expect(css).toContain('.mm-mask.mm-mask--above-rating-edit { z-index: 59; }')
  })

  it('D：仅生成串联记忆次要操作，不覆盖单条', () => {
    expect(panel).toContain('仅生成串联记忆（不覆盖单条）')
    expect(panel).toContain('generateOverviewOnly')
    expect(panel).toContain('generateCoreSenseOverview(source, config)')
    expect(panel).toContain('generateSenseMnemonic(source, config)')
  })

  it('E：导入读取/校验中禁用 + 进度/完成提示', () => {
    expect(me).toContain("'读取/校验中…'")
    expect(me).toContain("'导入中…'")
    expect(me).toContain('mm-progress--indeterminate')
    expect(meCss).toContain('mm-indeterminate')
    expect(me).toContain('已有数据未清空')
    expect(me).toContain('applyCoreSenseMnemonicImportParsed')
    expect(me).toContain('previewCoreSenseMnemonicImport(text, {')
    expect(me).toContain('onProgress')
    expect(me).toContain('coreImportProgress')
  })
})
