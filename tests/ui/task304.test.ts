import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const study = src('ui/study/StudyPage.tsx')
const me = src('ui/me/MePage.tsx')

describe('task-304 0.10.0 数据安全 UI 骨架', () => {
  it('评分后保存状态：保存中/已保存/失败重试', () => {
    expect(study).toContain('progressSaveState')
    expect(study).toContain("'saved'")
    expect(study).toContain('已保存 ✓')
    expect(study).toContain('保存失败，点此重试')
    expect(study).toContain('study-save-status')
  })

  it('立即保存/检查点恢复/救援入口', () => {
    expect(me).toContain('立即保存进度')
    expect(me).toContain('从检查点恢复')
    expect(me).toContain('flushProgressCheckpoint')
    expect(me).toContain('restoreProgressCheckpointIfEmpty')
    expect(me).toContain('createPreBackup')
    expect(me).toContain('仅空库自动恢复')
    expect(me).toContain('restoreCheckpoint')
    expect(study).toContain('从最新可靠备份恢复')
    expect(study).toContain('保存失败')
    expect(study).toContain('去我的→数据恢复')
    expect(me).toContain('setAutoBackups(listAutoBackupsForUi())')
    expect(me).toContain('autoRestoreListLoading')
    expect(me).toContain('window.setTimeout(refresh, 300)')
    expect(study).toContain('/me?restoreCheckpoint=1')
  })
})
