import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const studyCss = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)

describe('学习页布局/长文本 CSS 回归', () => {
  it('助记完整换行不夹断（B1）', () => {
    const block = studyCss.slice(studyCss.indexOf('.meaning-mnemonic'), studyCss.indexOf('.meaning-mnemonic') + 220)
    expect(block).toContain('white-space: normal')
    expect(block).toContain('-webkit-line-clamp: unset')
    expect(studyCss).toContain('.mm-review-line')
  })

  it('本义链完整换行不裁切（B4）', () => {
    const block = studyCss.slice(studyCss.indexOf('.derivation-chain'), studyCss.indexOf('.derivation-chain') + 220)
    expect(block).toContain('white-space: normal')
    expect(block).toContain('overflow: visible')
  })

  it('本义区左右 ≥16px 防裁字（B5）', () => {
    const block = studyCss.slice(studyCss.indexOf('.core-senses'), studyCss.indexOf('.core-senses') + 220)
    expect(block).toContain('padding-left: 16px')
    expect(block).toContain('padding-right: 16px')
  })

  it('白板面含义多时可滚动、从顶部排布（task-144 F4/F7）', () => {
    const stage = studyCss.slice(studyCss.indexOf('.board-stage'), studyCss.indexOf('.board-stage') + 260)
    expect(stage).toContain('overflow-y: auto')
    const main = studyCss.slice(studyCss.indexOf('.board-main'), studyCss.indexOf('.board-main') + 400)
    expect(main).toContain('justify-content: flex-start')
    expect(main).not.toContain('margin-top: -6vh')
  })

  it('F9 分栏：宽度变量/拖拽把手/全屏/无溢出（task-154）', () => {
    const panel = studyCss.slice(studyCss.indexOf('.derivation-panel {'), studyCss.indexOf('.derivation-panel {') + 700)
    expect(panel).toContain('width: var(--derivation-panel-width')
    expect(panel).toContain('overflow-x: hidden')
    expect(panel).toContain('overflow-y: auto')
    expect(studyCss).toContain('.study-page--side-full .derivation-panel')
    const full = studyCss.slice(
      studyCss.indexOf('.study-page--side-full .derivation-panel'),
      studyCss.indexOf('.study-page--side-full .derivation-panel') + 140,
    )
    expect(full).toContain('width: 100%')
    const handle = studyCss.slice(studyCss.indexOf('.derivation-resize-handle {'), studyCss.indexOf('.derivation-resize-handle {') + 400)
    expect(handle).toContain('width: 12px')
    expect(handle).toContain('touch-action: none')
    const viewer = studyCss.slice(studyCss.indexOf('.mermaid-viewer {'), studyCss.indexOf('.mermaid-viewer {') + 500)
    expect(viewer).toContain('position: fixed')
    expect(viewer).toContain('inset: 0')
    expect(studyCss).toContain('.study-annotation-wrap.is-side')
    const left = studyCss.slice(studyCss.indexOf('.study-annotation-wrap.is-side {'), studyCss.indexOf('.study-annotation-wrap.is-side {') + 300)
    expect(left).toContain('width: calc(100% - var(--derivation-panel-width')
    expect(left).toContain('overflow-x: hidden')
    expect(studyCss).toContain('min-width: max-content')
    expect(studyCss).toContain('.mermaid-viewer-canvas')
    expect(studyCss).toContain('touch-action: none')
    expect(studyCss).toContain('white-space: pre-wrap')
  })
})
