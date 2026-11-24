import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const hook = src('app/hooks/usePlanUpdated.ts')
const home = src('app/hooks/useHomeStudy.ts')
const study = src('app/hooks/useStudyProgress.ts')
const stats = src('app/hooks/useStats.ts')

describe('task-326 momo:plan-updated 重拉首页/计划/统计', () => {
  it('事件监听并作为 liveQuery 依赖', () => {
    expect(hook).toContain("window.addEventListener('momo:plan-updated'")
    expect(hook).toContain('visibilitychange')
    expect(home).toContain('usePlanUpdatedRevision')
    expect(home).toContain('[planRevision]')
    expect(study).toContain('usePlanUpdatedRevision')
    expect(study).toContain('planRevision],')
    expect(stats).toContain('usePlanUpdatedRevision')
  })

  it('清空失败使用真实错误', () => {
    const settings = src('ui/me/SettingsPage.tsx')
    expect(settings).toContain("toast.error(error instanceof Error ? error.message : '清空失败')")
  })
})
