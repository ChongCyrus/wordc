import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)

describe('task-246 hidden/final 垂直居中', () => {
  it('hidden/final-hidden/final-summary flex center，覆盖 core-only flex-start', () => {
    const block = css.slice(css.indexOf('/* task-246'))
    expect(block).toContain('.memory-stage--hidden,')
    expect(block).toContain('.memory-stage--final-hidden,')
    expect(block).toContain('.memory-stage--final-summary')
    expect(block).toContain('justify-content: center')
    expect(block).toContain('padding-top: 20px')
    expect(block).toContain('.memory-stage--final-summary { overflow-y: auto; }')
  })
})
