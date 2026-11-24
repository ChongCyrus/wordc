import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-308 SQLite M1 自检 UI', () => {
  it('health/integrity 结果 JSON、复制、导出下载', () => {
    expect(me).toContain('SQLite M1 自检')
    expect(me).toContain("method: 'health'")
    expect(me).toContain("method: 'integrity'")
    expect(me).toContain('sqlite-m1-selftest.json')
    expect(me).toContain('已复制 SQLite 自检 JSON')
  })
})
