import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const filter = src('ui/decks/AdvancedFilterPage.tsx')
const generate = src('ui/decks/GeneratePage.tsx')
const jobs = src('ui/me/GenerationJobsPage.tsx')
const router = src('app/router.tsx')
const ai = src('ui/ai/AiGeneratePanel.tsx')

describe('task-293 0.5.0 筛选→AI生成/临时复习/续跑', () => {
  it('筛选底部条：AI/临时复习/保存，N=已选或全部', () => {
    expect(filter).toContain('filter-bottom-bar')
    expect(filter).toContain('AI 生成数据（')
    expect(filter).toContain('临时复习（')
    expect(filter).toContain('momo:filterGenerateSeed')
    expect(filter).toContain('wordIds: snapshotWordIdsToSave')
    expect(filter).toContain('selected.length > 0 ? selected : allIds')
    expect(filter).toContain('/temp-review?words=')
    expect(filter).toContain('const actionIds = selected.length > 0 ? selected : snapshotWordIds')
    expect(filter).toContain('snapshotWordIds')
    expect(filter).toContain('词快照')
  })

  it('生成页读 seed/展示来源/关闭返回筛选', () => {
    expect(router).toContain("path: 'decks/:deckId/generate'")
    expect(generate).toContain('momo:filterGenerateSeed')
    expect(generate).toContain('sourceLabel')
    expect(generate).toContain('统一生成')
    expect(generate).toContain('/filter?restore=1')
    expect(ai).toContain('来源：')
  })

  it('任务中心继续跳 GeneratePage 带 jobId', () => {
    expect(jobs).toContain('useNavigate')
    expect(jobs).toContain('/generate?jobId=')
    expect(generate).toContain('getGenerationJob')
    expect(generate).toContain('jobId')
  })
})
