import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const section = src('ui/me/ContentBackupSection.tsx')
const settings = src('ui/me/SettingsPage.tsx')
const shell = src('app/layout/AppShell.tsx')

describe('task-335 0.12 内容备份 UI', () => {
  it('开关/基线/增量/列表/恢复/状态', () => {
    expect(settings).toContain('<ContentBackupSection')
    expect(section).toContain('backup.autoContentEnabled')
    expect(section).toContain('createContentBaseline')
    expect(section).toContain('createContentIncrement')
    expect(section).toContain('listContentBackups')
    expect(section).toContain('restoreContentBackup')
    expect(section).toContain('getContentBackupStatus')
    expect(section).toContain('lastBaseline')
    expect(section).toContain('consecutiveFailures')
    expect(section).toContain('needsFullSnapshot')
    expect(section).toContain('chainBroken')
    expect(shell).toContain('setContentBackupStorage')
    expect(shell).toContain('createContentBackupStorage')
  })

  it('恢复二次确认/busy/增量禁用/真实错误', () => {
    expect(section).toContain('window.confirm')
    expect(section).toContain("setBusy('恢复内容备份中…')")
    expect(section).toContain('item.parentChecksum')
    expect(section).not.toContain("item.kind === 'increment' || !item.valid")
    expect(section).toContain('增量会沿链校验 ancestors/checksum')
    expect(section).toContain('恢复失败：')
    expect(section).toContain("momo:content-backup-updated")
    expect(section).toContain('visibilitychange')
    expect(section).toContain("setBusy('读取内容备份列表…')")
    expect(section).toContain('void refresh().finally')
    expect(section).toContain("window.addEventListener('focus'")
    expect(section).not.toContain('createPreBackup()')
    expect(section).toContain('需要创建新的完整基线')
    expect(section).toContain("status?.needsFullSnapshot ? '需新基线'")
  })
})
