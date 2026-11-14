import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DerivationPanel,
  DerivationTextView,
  DerivationUsageDialog,
  DERIVATION_USAGE_TEXT,
  MermaidPreview,
  MermaidZoomViewer,
  clampMermaidScale,
  nextDoubleTapScale,
} from '../../src/ui/study/components/DerivationPanel'
import { mergeGeneratedDerivation } from '../../src/ui/study/lib/derivation-map'
import {
  clampDerivationPanelWidth,
  derivationWidthFromDrag,
  readDerivationPanelWidth,
} from '../../src/ui/study/lib/derivation-width'
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

  it('全屏按钮/Mermaid 全屏查看器（F9）', () => {
    const panel = renderToStaticMarkup(
      createElement(DerivationPanel, {
        open: true,
        headword: 'bank',
        content: { mode: 'text' as const, text: 'x', mermaid: '' },
        onClose: noop,
        onSave: noop,
        onToggleFullscreen: noop,
      }),
    )
    expect(panel).toContain('全屏')

    const viewer = renderToStaticMarkup(
      createElement(MermaidZoomViewer, { svg: '<svg><text>root</text></svg>', onClose: noop }),
    )
    expect(viewer).toContain('mermaid-viewer')
    expect(viewer).toContain('重置')
    expect(viewer).toContain('关闭')
    expect(viewer).toContain('100%')
  })

  it('缩放/双击/宽度拖拽纯函数边界（F9）', () => {
    expect(clampMermaidScale(0.1)).toBe(0.5)
    expect(clampMermaidScale(9)).toBe(4)
    expect(clampMermaidScale(Number.NaN)).toBe(1)
    expect(nextDoubleTapScale(1)).toBe(2)
    expect(nextDoubleTapScale(2)).toBe(1)
    expect(nextDoubleTapScale(0.5)).toBe(1)

    expect(clampDerivationPanelWidth(10)).toBe(30)
    expect(clampDerivationPanelWidth(90)).toBe(75)
    expect(clampDerivationPanelWidth(75)).toBe(75)
    expect(clampDerivationPanelWidth(30)).toBe(30)
    expect(clampDerivationPanelWidth(Number.NaN)).toBe(46)
    // 把手向左拖 100px（视口 500）：右页变宽 20% → 66%
    expect(derivationWidthFromDrag({ startWidth: 46, dx: -100, viewportWidth: 500 })).toBe(66)
    expect(derivationWidthFromDrag({ startWidth: 46, dx: 1000, viewportWidth: 500 })).toBe(30)
    expect(derivationWidthFromDrag({ startWidth: 46, dx: -145, viewportWidth: 500 })).toBe(75)
    expect(readDerivationPanelWidth(null)).toBe(46)
  })

  it('AI 生成不切模式（task-157）：文字模式保留文字；空结果给占位', () => {
    const textMode = mergeGeneratedDerivation({
      current: { mode: 'text', text: '原文字', mermaid: '' },
      generated: { rootLabel: '生成元', mermaid: 'mindmap\n  root((x))' },
    })
    expect(textMode.mode).toBe('text')
    expect(textMode.text).toBe('原文字')
    expect(textMode.mermaid).toContain('mindmap')
    expect(textMode.source).toBe('ai')

    const mermaidMode = mergeGeneratedDerivation({
      current: { mode: 'mermaid', text: '旧文字', mermaid: '' },
      generated: { rootLabel: '生成元', text: 'AI 文字版' },
    })
    expect(mermaidMode.mode).toBe('mermaid')
    expect(mermaidMode.mermaid).toBe('')
    expect(mermaidMode.source).toBe('ai')

    // 受控模式：文字模式且无文字 → 占位，不显示 Mermaid 图
    const panel = renderToStaticMarkup(
      createElement(DerivationPanel, {
        open: true,
        headword: 'bank',
        mode: 'text',
        onModeChange: noop,
        content: { mode: 'mermaid', text: '', mermaid: 'mindmap\n  root((x))' },
        onClose: noop,
        onSave: noop,
      }),
    )
    expect(panel).toContain('尚无文字内容')
    expect(panel).not.toContain('Mermaid 渲染失败')
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
