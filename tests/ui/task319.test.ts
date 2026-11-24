import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-319 M6 0.10 回退包 UI', () => {
  it('build cache→migration JSON→下载→步骤/delta', () => {
    expect(me).toContain('生成 0.10 回退包')
    expect(me).toContain('createPreBackup()')
    expect(me).toContain('buildIdbRollbackCache({')
    expect(me).toContain('buildRollbackMigrationText()')
    expect(me).toContain('momo-0.10-rollback.json')
    expect(me).toContain('detectIdbDeltaSinceSqlite')
    expect(me).toContain('回退步骤')
    expect(me).toContain('安装 0.10 APK')
  })
})
