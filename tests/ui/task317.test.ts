import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const me = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/MePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-317 M4b-2-1 学习写源 UI', () => {
  it('启用/回退/当前写源/readonly 提示', () => {
    expect(me).toContain('启用学习 SQLite 写（M4b-2）')
    expect(me).toContain('createPreBackup()')
    expect(me).toContain('getTodayPlan({')
    expect(me).toContain('expectedPlanWordIds')
    expect(me).toContain('enableLearningSqliteWrite({')
    expect(me).toContain('回退学习写源到 IDB')
    expect(me).toContain('revertLearningWriteSourceToIdb')
    expect(me).toContain('当前学习写源')
    expect(me).toContain("learningWriteSource === 'readonly'")
    expect(me).toContain('只读')
  })
})
