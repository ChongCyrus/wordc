import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-324 修复学习写源 UI', () => {
  it('二次确认 → repairLearningWriteSource → 前后写源/counts/错误真实提示', () => {
    expect(me).toContain('修复学习写源')
    expect(me).toContain('repairLearningWriteSource')
    expect(me).toContain('const before = getLearningWriteSource()')
    expect(me).toContain('const after = getLearningWriteSource()')
    expect(me).toContain('before, after, result')
    expect(me).toContain('学习写源已修复')
    expect(me).toContain('修复失败：')
  })
})
