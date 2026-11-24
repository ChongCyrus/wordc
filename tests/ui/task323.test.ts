import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-323 备份计数文案拆分', () => {
  it('SQLite facts 保留7 + 旧 JSON legacy，不静默删旧', () => {
    expect(me).toContain('保留 7 份')
    expect(me).toContain('份（legacy）')
    expect(me).toContain('旧 JSON 自动备份（legacy）')
    expect(me).toContain('不会静默删除')
    expect(me).toContain('SQLite facts 备份 ${sqliteBackups.length} 份（保留 7 份）')
  })
})
