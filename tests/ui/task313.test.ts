import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-313 M4a plan 修复 UI', () => {
  it('dryRun 显示 plan 数/字段；执行接备份；重启提示', () => {
    expect(me).toContain('M4a plan 修复演练（dryRun）')
    expect(me).toContain('repairMigratedPlans({ dryRun: true })')
    expect(me).toContain('wouldChange')
    expect(me).toContain('completed_at=0→null')
    expect(me).toContain('执行 plan 修复')
    expect(me).toContain('const backup = await createPreBackup()')
    expect(me).toContain('repairMigratedPlans({\n        dryRun: false')
    expect(me).toContain('preBackup: async () => ({ ok: true })')
    expect(me).toContain('172/700')
  })
})
