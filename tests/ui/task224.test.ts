import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)
const panel = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/SenseMnemonicPanel.tsx', import.meta.url)),
  'utf8',
)

describe('task-224 本义助记面板底部按钮不被评分栏遮挡', () => {
  it('遮罩 z-index 高于评分栏（30），内容滚动、操作区固定', () => {
    expect(panel).toContain('overlayClassName="mm-mask--above-rating"')
    expect(css).toContain('.mm-mask.mm-mask--above-rating')
    expect(css).toContain('z-index: 58')
    expect(css).toContain('padding: calc(56px + env(safe-area-inset-top, 0px)) 16px')
    expect(css).toContain('flex-direction: column')
    expect(css).toContain('max-height: 100%')
    expect(css).toContain('overflow-y: auto')
    expect(css).toContain('.mm-mask.mm-mask--above-rating .mm-dialog-actions')
    expect(css).toContain('position: sticky')
  })

  it('生成全部（串联 textarea+建议）时 body 独立滚动、操作区不被裁切', () => {
    expect(panel).toContain('本义串联记忆')
    expect(css).toContain('flex: 1 1 auto')
    expect(css).toContain('min-height: 0')
    expect(css).toContain('flex: 0 0 auto')
  })
})
