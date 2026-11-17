import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MarkdownText } from '../../src/ui/study/components/DerivationMarkdown'
import { DerivationPanel, DerivationTextView } from '../../src/ui/study/components/DerivationPanel'
import {
  hasDerivationMarkdownSetting,
  readDerivationMarkdown,
} from '../../src/ui/study/lib/derivation-markdown'
import type { SettingsMap } from '../../src/core'

const noop = () => undefined

describe('F10 右页文字安全 Markdown（task-162）', () => {
  it('支持标题/加粗/斜体/行内代码/无序/有序列表/换行', () => {
    const text = '# 生成元\n\n本义是 **装载**，也可 *引申* 为 `load`。\n\n- 场景一\n- 场景二\n\n1. 对象\n2. 词性'
    const html = renderToStaticMarkup(createElement(MarkdownText, { text }))
    expect(html).toContain('<h1')
    expect(html).toContain('生成元')
    expect(html).toContain('<strong>装载</strong>')
    expect(html).toContain('<em>引申</em>')
    expect(html).toContain('<code>load</code>')
    expect(html).toContain('<ul>')
    expect(html).toContain('<li>场景一</li>')
    expect(html).toContain('<ol>')
    expect(html).toContain('<li>对象</li>')
  })

  it('不渲染原始 HTML（XSS 防护）；脚本/图片按纯文本显示', () => {
    const text = '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>'
    const html = renderToStaticMarkup(createElement(MarkdownText, { text }))
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<script')
    expect(html).toContain('&lt;img')
    expect(html).toContain('&lt;script')
  })

  it('开关关闭回退纯文本（pre-wrap），编辑源码不被解析', () => {
    const text = '**不应加粗**\n- 不是列表'
    const off = renderToStaticMarkup(createElement(DerivationTextView, { text, markdown: false }))
    expect(off).toContain('<pre')
    expect(off).toContain('**不应加粗**')
    expect(off).not.toContain('<strong>')

    const on = renderToStaticMarkup(createElement(DerivationTextView, { text, markdown: true }))
    expect(on).not.toContain('<pre')
    expect(on).toContain('<strong>不应加粗</strong>')
    expect(on).toContain('<ul>')
  })

  it('右页面板 markdown 开关生效', () => {
    const content = { mode: 'text' as const, text: '**重点**', mermaid: '' }
    const on = renderToStaticMarkup(
      createElement(DerivationPanel, {
        open: true,
        headword: 'load',
        content,
        markdown: true,
        onClose: noop,
        onSave: noop,
      }),
    )
    expect(on).toContain('<strong>重点</strong>')

    const off = renderToStaticMarkup(
      createElement(DerivationPanel, {
        open: true,
        headword: 'load',
        content,
        markdown: false,
        onClose: noop,
        onSave: noop,
      }),
    )
    expect(off).toContain('**重点**')
  })

  it('设置键读取：缺失/默认开，显式 false 关闭', () => {
    expect(hasDerivationMarkdownSetting(null)).toBe(false)
    expect(hasDerivationMarkdownSetting({} as unknown as SettingsMap)).toBe(false)
    expect(readDerivationMarkdown(null)).toBe(true)
    expect(readDerivationMarkdown({ 'derivation.markdown': true } as unknown as SettingsMap)).toBe(true)
    expect(readDerivationMarkdown({ 'derivation.markdown': false } as unknown as SettingsMap)).toBe(false)
  })
})
