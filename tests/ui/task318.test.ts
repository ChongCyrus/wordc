import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const me = src('ui/me/MePage.tsx')
const shell = src('app/layout/AppShell.tsx')

describe('task-318 M5 SQLite backup/checkpoint UI', () => {
  it('bridge 注册/pagehide flush；manifest/备份/恢复列表/counts', () => {
    expect(shell).toContain('setSqliteFactsCheckpointBridge')
    expect(shell).toContain('flushSqliteFactsCheckpointAuto')
    expect(me).toContain('SQLite facts 备份')
    expect(me).toContain('createSqliteFactsBackup')
    expect(me).toContain('getSqliteFactsManifest')
    expect(me).toContain('listSqliteBackupFiles')
    expect(me).toContain('getSqliteBackupManifest')
    expect(me).toContain('restoreSqliteFactsBackup')
    expect(me).toContain('createPreBackup')
    expect(me).toContain('SQLite facts 恢复')
    expect(me).toContain('旧 JSON 备份包')
    expect(me).toContain('getSqliteCheckpointStatus')
    expect(me).toContain('SQLite 检查点')
  })
})
