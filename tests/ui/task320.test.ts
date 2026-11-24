import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-320 M3 迁移 60s 超时', () => {
  it('Promise.race 超时 60s，失败可重试', () => {
    expect(me).toContain('迁移超时（60 秒），可再次点击重试')
    expect(me).toContain('60_000')
    expect(me).toContain('Promise.race([')
    expect(me).toContain('dryRun: false')
  })
})
