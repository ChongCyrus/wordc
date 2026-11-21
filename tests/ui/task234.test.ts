import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)

describe('task-234 多行提示纵向避让右上控件', () => {
  it('core-only hint 有 top offset，提示 top ≥ 控件 bottom+8', () => {
    expect(css).toContain('.memory-stage--with-top-controls')
    expect(css).toContain('justify-content: flex-start')
    expect(css).toContain('padding-top: 20px')
    expect(css).toContain('overflow-y: auto')
    expect(css).toContain('margin: 0 118px 6px 16px')
  })
})
