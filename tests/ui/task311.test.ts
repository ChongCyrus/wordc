import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-311 M3 真实迁移入口', () => {
  it('二次确认→dryRun→preBackup→migrate dryRun:false→前后 counts/epoch', () => {
    expect(me).toContain('执行 M3 真实迁移')
    expect(me).toContain("window.confirm('执行真实 M3 迁移？")
    expect(me).toContain('const dryRun = await migrateIdbToSqlite({ dryRun: true')
    expect(me).toContain('const backup = await createPreBackup()')
    expect(me).toContain('dryRun: false')
    expect(me).toContain('preBackup: async () => ({ ok: true })')
    expect(me).toContain('beforeEpoch')
    expect(me).toContain('afterHealth')
    expect(me).toContain('migrationState')
  })
})
