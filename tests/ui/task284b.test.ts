import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const page = src('ui/me/GenerationJobsPage.tsx')
const router = src('app/router.tsx')
const me = src('ui/me/MePage.tsx')

describe('task-283 B2 生成任务中心', () => {
  it('列表状态/进度/失败/预算/并发 + 续跑/命名/删除/清理', () => {
    expect(page).toContain('listGenerationJobs')
    expect(page).toContain('resumeGenerationJob')
    expect(page).toContain('renameGenerationJob')
    expect(page).toContain('deleteGenerationJob')
    expect(page).toContain('clearFinishedGenerationJobs')
    expect(page).toContain('排队中')
    expect(page).toContain('进行中')
    expect(page).toContain('已完成')
    expect(page).toContain('失败')
    expect(page).toContain('已花费')
    expect(page).toContain('并发')
    expect(router).toContain("path: 'me/jobs'")
    expect(me).toContain("navigate('/me/jobs')")
  })
})
