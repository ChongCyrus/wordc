import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const ai = src('ui/ai/AiGeneratePanel.tsx')
const jobs = src('ui/me/GenerationJobsPage.tsx')

describe('task-287 每请求单词数 + 多对象任务', () => {
  it('AI 页 1–20 配置，多对象按 batchSize 调用并写 job', () => {
    expect(ai).toContain('每请求单词数')
    expect(ai).toContain('multiObjectSize')
    expect(ai).toContain('Math.max(1, Math.min(20')
    expect(ai).toContain('runMultiObjectGeneration')
    expect(ai).toContain('createGenerationJob')
    expect(ai).toContain('batchSize: multiObjectSize')
    expect(ai).toContain('jobId: job.id')
    expect(ai).toContain('updateGenerationJob')
    expect(jobs).toContain('listGenerationJobs')
  })
})
