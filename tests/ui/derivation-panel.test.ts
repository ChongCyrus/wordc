import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DerivationPanel,
  DerivationTextView,
  DerivationUsageDialog,
  DERIVATION_USAGE_TEXT,
  MermaidPreview,
} from '../../src/ui/study/components/DerivationPanel'
import { sidePanelSwipeAction } from '../../src/ui/study/lib/use-side-panel-swipe'

const noop = () => undefined

describe('F8 生成元引申副页（task-147）', () => {
  it('关闭不渲染；文本模式完整换行展示', () => {
    expect(
      renderToStaticMarkup(
        createElement(DerivationPanel, {
          open: false,
          headword: 'bank',
          content: { mode: 'text', text: 'x', mermaid: '' },
          onClose: noop,
          onSave: noop,
        }),
      ),
    ).toBe('')

    const text = '本义：河岸\\n→ 场景：金融\\n→ 含义：银行（n.）'
    const html = renderToStaticMarkup(createElement(DerivationTextView, { text }))
    expect(html).toContain('derivation-map-text')
    expect(html).toContain('河岸')
    expect(html).toContain('银行（n.）')
  })

  it('Mermaid 无源显示占位（task-150）', () => {
    const html = renderToStaticMarkup(createElement(MermaidPreview, { source: '' }))
    expect(html).toContain('尚无 Mermaid 内容')
    expect(html).toContain('编辑')
  })

  it('Mermaid 模式：渲染器不可用时回退显示源码（不阻塞）', () => {
    const source = 'mindmap\\n  root((bank))\\n    河岸'
    const html = renderToStaticMarkup(createElement(MermaidPreview, { source }))
    expect(html).toContain('mindmap')
    expect(html).toContain('河岸')
    expect(html).toContain('derivation-mermaid-fallback')
  })

  it('面板含模式切换/编辑/保存；提供 onAiGenerate 时才显示 AI 按钮', () => {
    const base = {
      open: true,
      headword: 'bank',
      content: { mode: 'text' as const, text: '生成元 → 含义', mermaid: '' },
      onClose: noop,
      onSave: noop,
    }
    const html = renderToStaticMarkup(createElement(DerivationPanel, base))
    expect(html).toContain('生成元 → 含义')
    expect(html).toContain('文字')
    expect(html).toContain('Mermaid')
    expect(html).toContain('编辑')
    expect(html).toContain('保存')
    expect(html).not.toContain('AI 生成')

    const withAi = renderToStaticMarkup(
      createElement(DerivationPanel, { ...base, onAiGenerate: noop }),
    )
    expect(withAi).toContain('AI 生成')
  })

  it('「用法」弹层：完整文案、可滚动、可关闭（task-151）', () => {
    const html = renderToStaticMarkup(
      createElement(DerivationUsageDialog, { open: true, onClose: noop }),
    )
    expect(html).toContain('用法：把生成元代入例句')
    expect(html).toContain('生成元直接作为含义代入各个实际含义的例句')
    expect(html).toContain('真实指代')
    expect(html).toContain('derivation-usage-body')
    expect(html).toContain('知道了')
    expect(DERIVATION_USAGE_TEXT).toContain('实例化到该场景下的具体指代事物')
    // 面板底部有「用法」按钮
    const panel = renderToStaticMarkup(
      createElement(DerivationPanel, {
        open: true,
        headword: 'bank',
        content: { mode: 'text' as const, text: 'x', mermaid: '' },
        onClose: noop,
        onSave: noop,
      }),
    )
    expect(panel).toContain('用法')
  })

  it('滑动判定：左滑开、右滑收、纵向/小位移不触发', () => {
    expect(sidePanelSwipeAction({ dx: -80, dy: 5, open: false })).toBe('open')
    expect(sidePanelSwipeAction({ dx: 80, dy: 5, open: true })).toBe('close')
    expect(sidePanelSwipeAction({ dx: -80, dy: 5, open: true })).toBeNull()
    expect(sidePanelSwipeAction({ dx: 80, dy: 5, open: false })).toBeNull()
    expect(sidePanelSwipeAction({ dx: -20, dy: 2, open: false })).toBeNull()
    expect(sidePanelSwipeAction({ dx: -80, dy: 90, open: false })).toBeNull()
  })
})
