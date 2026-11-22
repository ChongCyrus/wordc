import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const me = src('ui/me/MePage.tsx')
const gate = src('ui/me/AutoBackupStartupGate.tsx')

describe('task-282 自动备份失败/成功可见', () => {
  it('立即备份读取 mode/error：失败 toast 具体 error，成功刷新列表', () => {
    expect(me).toContain("'error' in result && result.error")
    expect(me).toContain('备份失败：${result.error}')
    expect(me).toContain('setAutoBackups(listAutoBackupsForUi())')
    expect(me).toContain('getAutoBackupRunStatus')
    expect(me).toContain('导出中…')
    expect(me).toContain('压缩中…')
    expect(me).toContain('保存中…')
    expect(me).toContain("result.name ? `已创建自动备份：${result.name}`")
  })

  it('启动备份失败 toast 一次 + 成功事件刷新列表', () => {
    expect(gate).toContain('自动备份失败：')
    expect(gate).toContain("mode === 'error'")
    expect(gate).toContain('momo:auto-backup-updated')
    expect(me).toContain("'momo:auto-backup-updated'")
  })
})
