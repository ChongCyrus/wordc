import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { AiGenerateView } from '../../src/ui/ai/AiGeneratePanel'

const noop = () => undefined
const globalCss = readFileSync(
  fileURLToPath(new URL('../../src/app/styles/global.css', import.meta.url)),
  'utf8',
)
const gesture = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/lib/use-study-panel-gesture.ts', import.meta.url)),
  'utf8',
)

const props = {
  scope: 'today',
  kinds: ['examples'],
  excludes: ['rejected'],
  targetCount: 12,
  estimateText: '预计 12 条',
  budgetText: '预算充足',
  running: false,
  progress: null,
  summary: null,
  error: null,
  onScope: noop,
  onToggleKind: noop,
  onToggleExclude: noop,
  onStart: noop,
  onCancel: noop,
  onClose: noop,
  batchLimit: 100,
  onBatchLimit: noop,
}

describe('task-202 AI 面板重设计 + modal 手势', () => {
  it('分组卡片/chips 2 列/选中描边，无旧 mm-btn-row 选项', () => {
    const html = renderToStaticMarkup(createElement(AiGenerateView, props as never))
    expect(html).toContain('ai-generate-form')
    expect(html).toContain('ai-section')
    expect(html).toContain('ai-section-title')
    expect(html).toContain('ai-chip-grid')
    expect(html).toContain('ai-chip is-selected')
    expect(html).toContain('ai-generate-actions')
    expect(html).not.toContain('class="mm-btn-row"')
    expect(globalCss).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(globalCss).toContain('font-size: 13px')
    expect(globalCss).toContain('.ai-chip.is-selected')
    expect(globalCss).toContain('box-shadow: inset 0 0 0 1px var(--mm-primary)')
    expect(globalCss).toContain('position: sticky')
  })

  it('draft banner 独立卡片且继续/放弃横排', () => {
    const html = renderToStaticMarkup(
      createElement(AiGenerateView, {
        ...props,
        draftMessage: '已生成 1/2（草稿已保存）',
        onResumeDraft: noop,
        onDiscardDraft: noop,
      } as never),
    )
    expect(html).toContain('ai-draft-card')
    expect(html).toContain('ai-draft-actions')
    expect(html).toContain('继续')
    expect(html).toContain('放弃草稿')
  })

  it('手势 hook 在任何 modal 打开时禁用 pointer/touch', () => {
    expect(gesture).toContain('hasBlockingModal')
    expect(gesture).toContain("'.mm-mask, .mm-dialog, [role=\"dialog\"], .batch-derivation'")
    expect(gesture.indexOf("const onTouchStart = (event: TouchEvent): void => {\n      if (hasBlockingModal()) return"))
      .toBeGreaterThan(-1)
    expect(gesture.indexOf("const onPointerDown = (event: PointerEvent): void => {\n      if (hasBlockingModal()) return"))
      .toBeGreaterThan(-1)
  })
})
