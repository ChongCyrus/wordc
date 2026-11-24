import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const service = src('app/utils/auto-backup-service.ts')
const settings = src('ui/me/SettingsPage.tsx')
const me = src('ui/me/MePage.tsx')

describe('task-307 清空数据检查点安全', () => {
  it('清空前删 checkpoint；备份恢复后 flush', () => {
    expect(service).toContain('clearProgressCheckpoints')
    expect(service).toContain('checkpoint-(latest|')
    expect(settings).toContain('clearProgressCheckpoints')
    expect(settings).toContain('clearAllData({')
    expect(settings).toContain('createFactsPreBackup')
    expect(settings).toContain('检查点删除失败')
    expect(service).toContain('remaining === 0')
    expect(service).toContain('listValidatedAutoBackupsForUi')
    expect(service).toContain("parsed.format !== 'momo-migration'")
    expect(me).toContain('await flushProgressCheckpoint().catch')
    expect(me).toContain('仅空库自动恢复')
  })
})
