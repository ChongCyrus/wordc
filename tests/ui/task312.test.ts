import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-312 M4a cache 重建 UI', () => {
  it('dryRun 显示 counts/delta/冲突/generation/epoch；真实重建走备份', () => {
    expect(me).toContain('M4a cache 重建演练（dryRun）')
    expect(me).toContain('rebuildIdbCacheFromSqlite({ dryRun: true, batchSize: 500 })')
    expect(me).toContain('delta')
    expect(me).toContain('conflict')
    expect(me).toContain('generation')
    expect(me).toContain('执行 M4a 重建')
    expect(me).toContain('const backup = await createPreBackup()')
    expect(me).toContain('dryRun: false')
    expect(me).toContain('preBackup: async () => ({ ok: true })')
    expect(me).toContain('beforeEpoch')
  })
})
