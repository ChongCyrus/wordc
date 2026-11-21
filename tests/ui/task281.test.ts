import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const choice = src('ui/components/ReviewChoiceDialog.tsx')
const hook = src('ui/study/hooks/useStudySession.ts')
const study = src('ui/study/StudyPage.tsx')
const action = src('ui/study/components/ActionBar.tsx')
const summary = src('ui/study/components/TempReviewSummaryView.tsx')

describe('task-281 临时复习自动重现/三键/应用DHP', () => {
  it('抽词弹窗允许自动重现并传 autoRequeue', () => {
    expect(choice).toContain('允许自动重现')
    expect(choice).toContain('autoRequeue')
    expect(study).toContain('tempAutoRequeue')
    expect(hook).toContain('autoRequeue: tempAutoRequeue === true')
    expect(hook).toContain('advanceTempReviewBatch')
  })

  it('practice 三键自评无跳过；rate/rate-only 三键', () => {
    expect(action).toContain('onPracticeAssess')
    expect(action).not.toContain('跳过')
    expect(study).not.toContain('onNext={tempMode')
    expect(study).toContain("hideRating={detailMode || (tempMode && tempRecordMode === 'practice')}")
    expect(study).toContain("tempMode && tempRecordMode === 'practice' ? (rating) => actions.tempAssess")
    expect(hook).toContain('advanceTempReviewBatch(session, {')
  })

  it('TempReviewPage 转发 autoRequeue 到 StudyPage', () => {
    const temp = src('ui/study/TempReviewPage.tsx')
    expect(temp).toContain("params.get('autoRequeue')")
    expect(temp).toContain("'&autoRequeue=1'")
  })

  it('汇总：出现次数/应用DHP；rate 已应用不显示按钮', () => {
    expect(summary).toContain('本批出现')
    expect(summary).toContain('根据本批次调整日后复习计划')
    expect(summary).toContain("summary.recordMode !== 'rate' && onApply")
    expect(summary).toContain('已影响日后复习计划')
    expect(hook).toContain('applyTempReviewToDhp')
  })
})
