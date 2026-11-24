import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-316 M4b2 plan 对齐 UI', () => {
  it('dryRun + 真实写入前备份 + 前后字段', () => {
    expect(me).toContain('M4b2 plan 对齐演练（dryRun）')
    expect(me).toContain('reconcileTodayPlanToSqlite({ dryRun: true })')
    expect(me).toContain('before: dryRun')
    expect(me).toContain('result, after')
    expect(me).toContain('执行 M4b2 plan 对齐')
    expect(me).toContain('const backup = await createPreBackup()')
    expect(me).toContain('dryRun: false')
    expect(me).toContain('preBackup: async () => ({ ok: true })')
    expect(me).toContain('172/0')
  })
})
