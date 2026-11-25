import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const dbg = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/DebugPage.tsx', import.meta.url)),
  'utf8',
)

describe('task-336 0.14 内容存储调试 UI 骨架', () => {
  it('只读展示 contentWriteSource/迁移状态/counts/revision', () => {
    expect(dbg).toContain('getContentWriteSource')
    expect(dbg).toContain('CONTENT_MIGRATION_STATE_KEY')
    expect(dbg).toContain('readContentCounts')
    expect(dbg).toContain('contentState?.source')
    expect(dbg).toContain('迁移状态')
    expect(dbg).toContain('revision')
  })

  it('只读状态/刷新/可展开，动作已收敛', () => {
    expect(dbg).toContain('refreshContentState')
    expect(dbg).toContain("momo:content-backup-updated")
    expect(dbg).toContain('读取失败/未知')
    expect(dbg).toContain('内容 counts / 错误详情（可展开）')
    expect(dbg).not.toContain("persistContentWriteSource('idb')")
    expect(dbg).toContain('window.confirm')
  })
})
