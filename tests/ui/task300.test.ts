import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const page = readFileSync(
  fileURLToPath(new URL('../../src/ui/decks/GeneratePage.tsx', import.meta.url)),
  'utf8',
)
const jobs = readFileSync(
  fileURLToPath(new URL('../../src/ui/me/GenerationJobsPage.tsx', import.meta.url)),
  'utf8',
)

describe('task-300 0.6.1 暂停/继续/重启续跑', () => {
  it('暂停轮询→abort 当前 runner；继续→GeneratePage(jobId) 自动续跑', () => {
    expect(page).toContain('abortRef')
    expect(page).toContain('pausedRef')
    expect(page).toContain("next.status === 'paused' || next.status === 'canceled'")
    expect(page).toContain('abortRef.current?.abort()')
    expect(page).toContain('runGenerationJob')
    expect(page).toContain('deps: { signal: controller.signal }')
    expect(page).toContain('autoStartedRef')
    expect(page).toContain('void startUnified()')
    expect(page).toContain('runGenerationJob')
    expect(jobs).toContain('resumeGenerationJob')
    expect(jobs).toContain('pauseGenerationJob')
    expect(jobs).toContain('cancelGenerationJob')
    expect(jobs).toContain('getGenerationJobProgress')
    expect(jobs).toContain('progressMap')
    expect(jobs).toContain('/generate?jobId=')
    expect(jobs).toContain('旧任务无目标快照')
  })
})
