import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)
const board = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/BoardStage.tsx', import.meta.url)),
  'utf8',
)

describe('task-221 rare 按钮宽度 + board nc 仅词性', () => {
  it('本义 rare 按钮 fit-content/max-content/nowrap', () => {
    expect(css).toContain('.core-sense-card .rare-toggle-btn')
    expect(css).toContain('align-self: flex-start')
    expect(css).toContain('width: fit-content')
    expect(css).toContain('max-width: max-content')
    expect(css).toContain('white-space: nowrap')
  })

  it('board nc 只输出去重词性，无中文；无 pos 显示词性缺失', () => {
    expect(board).not.toContain('nc：')
    expect(board).toContain('positions.map((pos) => `[${pos}]`).join')
    expect(board).toContain('词性缺失')
    expect(board).toContain("meaning.pos?.trim()")
  })
})
