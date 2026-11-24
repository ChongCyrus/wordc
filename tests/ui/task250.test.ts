import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)

describe('task-250 目标工具按钮不换行', () => {
  it('全选/反选/取消全选等 nowrap、紧凑 padding', () => {
    const block = css.slice(css.indexOf('/* task-250'))
    expect(block).toContain('.sense-overview-targets .mm-btn-row .mm-btn')
    expect(block).toContain('.sense-targets .mm-btn-row .mm-btn')
    expect(block).toContain('white-space: nowrap')
    expect(block).toContain('word-break: keep-all')
    expect(block).toContain('padding-left: 8px')
    expect(block).toContain('font-size: 12px')
  })
})
