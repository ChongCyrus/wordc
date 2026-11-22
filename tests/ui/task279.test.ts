import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const hook = src('ui/study/hooks/useStudySession.ts')
const study = src('ui/study/StudyPage.tsx')
const action = src('ui/study/components/ActionBar.tsx')
const summary = src('ui/study/components/TempReviewSummaryView.tsx')
const choice = src('ui/components/ReviewChoiceDialog.tsx')
const unit = src('ui/decks/UnitDetailPage.tsx')
const deck = src('ui/decks/DeckDetailPage.tsx')
const ranking = src('ui/stats/RankingPage.tsx')
const meaning = src('ui/study/components/MeaningRow.tsx')
const annotation = src('ui/study/components/AnnotationStage.tsx')

describe('task-279 临时复习汇总/自评 + 两种不熟度', () => {
  it('practice 逐词自评只存本次、跳过、汇总', () => {
    expect(action).toContain('onPracticeAssess')
    expect(action).toContain('practice-assess-row')
    expect(study).toContain('study.tempSummary')
    expect(study).toContain('TempReviewSummaryView')
    expect(hook).toContain('captureTempReviewSnapshot')
    expect(hook).toContain('summarizeTempReview')
    expect(hook).toContain('tempRecordsRef.current.push')
    expect(hook).toContain('tempSkippedRef.current += 1')
    expect(hook).toContain('tempAssess: (rating: Rating)')
    expect(summary).toContain('本次')
    expect(summary).toContain('含义不熟')
    expect(summary).toContain('本义不熟')
    expect(summary).toContain('影响复习时间')
  })

  it('抽词包含今日已学/重复允许', () => {
    expect(choice).toContain('包含今日已学/已在计划的词')
    expect(choice).toContain('includeExisting')
    expect(unit).toContain('allowRepeat: includeExisting')
    expect(ranking).toContain('allowRepeat: includeExisting')
    expect(deck).toContain('allowRepeat: includeExisting')
  })

  it('词库/单元/排行维度切换；详情两种标注', () => {
    expect(unit).toContain('dimension={dimension}')
    expect(deck).toContain('dimension={dimension}')
    expect(ranking).toContain('dimension={dimension}')
    expect(unit).toContain("value: 'coreSense', label: '本义不熟悉度'")
    expect(meaning).toContain('含义不熟')
    expect(annotation).toContain('本义不熟')
  })
})
