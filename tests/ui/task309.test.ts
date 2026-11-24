import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const shell = readFileSync(
  fileURLToPath(new URL('../../src/app/layout/AppShell.tsx', import.meta.url)),
  'utf8',
)

describe('task-309 M2 只读缓存启动接线', () => {
  it('ensureBuiltinDecks 后、bootstrapM2ReadCache，失败不阻塞写 diag', () => {
    expect(shell).toContain('bootstrapM2ReadCache')
    expect(shell.indexOf('bootstrapM2ReadCache')).toBeGreaterThan(0)
    expect(shell.indexOf('ensureBuiltinDecks')).toBeGreaterThan(0)
    expect(shell).toContain('momo:m2-bootstrap-diag')
    expect(shell).toContain('await bootstrapM2ReadCache()')
  })
})
