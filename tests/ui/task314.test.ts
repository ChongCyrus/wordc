import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const me = src('ui/me/MePage.tsx')
const shell = src('app/layout/AppShell.tsx')

describe('task-314 M4b-1 settings SQLite 写入口', () => {
  it('AppShell 注入 checkpoint scheduler', () => {
    expect(shell).toContain('setSettingsCheckpointScheduler')
    expect(shell).toContain('scheduleStateCheckpoint(bridge)')
  })

  it('启用/恢复 settings 写：备份+counts 门禁/模式显示', () => {
    expect(me).toContain('启用 M4b-1 settings SQLite 写')
    expect(me).toContain('createPreBackup()')
    expect(me).toContain('getIdbFactCounts()')
    expect(me).toContain('enableSettingsSqliteWrite({')
    expect(me).toContain('expectedCounts')
    expect(me).toContain('恢复 settings IDB 写')
    expect(me).toContain("persistSettingsWriteMode('idb')")
    expect(me).toContain('getSettingsWriteDiagnostics')
    expect(me).toContain('getSettingsWriteMode()')
  })
})
