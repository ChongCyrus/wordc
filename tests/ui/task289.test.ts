import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const ai = src('ui/ai/AiGeneratePanel.tsx')
const jobs = src('ui/me/GenerationJobsPage.tsx')
const study = src('ui/study/StudyPage.tsx')
const memory = src('ui/study/components/MemoryStage.tsx')
const edit = src('ui/study/components/RootEtymologyEditDialog.tsx')
const css = src('app/styles/global.css') + '\n' + src('ui/study/styles/study.css')

describe('task-289 0.4.4 UI', () => {
  it('AI 审核预览实底模态/滚动/固定 actions', () => {
    expect(ai).toContain('overlayClassName="mm-mask--ai-review"')
    expect(css).toContain('.mm-mask.mm-mask--ai-review')
    expect(css).toContain('background-color: var(--mm-surface)')
    expect(css).toContain('.mm-dialog-body')
    expect(css).toContain('overflow-y: auto')
  })

  it('任务按钮横排 + 顶部控件纵向栈 + 卡片/workflow 分离', () => {
    expect(jobs).toContain('generation-job-actions')
    expect(css).toContain('.generation-job-actions')
    expect(study).toContain('memory-top-stack')
    expect(memory).toContain('memory-stage-tap')
    expect(memory.indexOf('wc-root-process')).toBeLessThan(memory.indexOf('memory-stage-tap'))
  })

  it('词根编辑字段标签清晰', () => {
    expect(edit).toContain('root-etymology-part-card')
    expect(edit).toContain('部分类型')
    expect(edit).toContain('含义（必填）')
    expect(edit).toContain('词源说明')
    expect(edit).toContain('组合说明')
    expect(css).toContain('.root-etymology-field')
  })
})
