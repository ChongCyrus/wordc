import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const study = src('ui/study/StudyPage.tsx')
const hook = src('ui/study/hooks/useStudySession.ts')
const deck = src('ui/decks/DeckDetailPage.tsx')
const unit = src('ui/decks/UnitDetailPage.tsx')
const ai = src('ui/ai/AiGeneratePanel.tsx')
const deriv = src('ui/me/BatchDerivationPanel.tsx')
const temp = src('ui/study/TempReviewPage.tsx')
const choice = src('ui/components/ReviewChoiceDialog.tsx')

describe('task-263 A：词详情=完整注释面（detailMode）', () => {
  it('detailWord 参数、单词语义 session、live 查询、无评分、返回详情', () => {
    expect(src('app/router.tsx')).toContain("path: 'study'")
    expect(deck).toContain('detailWord=')
    expect(study).toContain('detailWordId')
    expect(study).toContain("hideRating={detailMode || (tempMode && tempRecordMode === 'practice')}")
    expect(study).toContain("closeLabel={tempMode ? '退出临时复习' : detailMode ? '返回详情'")
    expect(hook).toContain('getWordSemanticSessionData')
    expect(hook).toContain('getWordDetailBundle')
    expect(hook).toContain('useLiveQuery')
    expect(hook).toContain('setMeaningStats(liveDetailBundle')
    expect(hook).toContain('recordMeaningEncounters(detail.word.id, detailMeaningIds)')
    expect(hook).toContain('详情进入注释面按学习页同等口径记录一次 encounters')
  })
})

describe('task-263 B：默认点击详情 + 选择模式 + 批量 AI', () => {
  it('选择按钮默认无复选框；批量 AI/引申图预选', () => {
    expect(unit).toContain("selectMode ? '完成' : '选择'")
    expect(unit).toContain('{selectMode ? (')
    expect(unit).toContain('initialSelectedWordIds={selected}')
    expect(unit).toContain('initialWordIds={selected}')
    expect(deck).toContain("selectMode ? '完成' : '选择'")
    expect(deck).toContain('initialSelectedWordIds={selected}')
    expect(deck).toContain('initialWordIds={selected}')
    expect(deck).toContain('BulkSelectToolbar')
    expect(deck).toContain('getDeckWordIds')
    expect(deck).toContain('最多批量选择 999 个词')
    expect(deck).toContain('onSelectAll={() => void selectAllDeck()}')
    expect(ai).toContain('initialSelectedWordIds')
    expect(ai).toContain("setScope('custom')")
    expect(deriv).toContain('initialWordIds')
    expect(deriv).toContain('wordIds: presetIds')
  })
})

describe('task-263 追加：临时复习选择/记录方式', () => {
  it('加入今日计划/立即复习三模式 + temp 页面 rateTempReview', () => {
    expect(choice).toContain('加入今日计划')
    expect(choice).toContain('立即复习')
    expect(choice).toContain('只练不记录')
    expect(choice).toContain('rate-only')
    expect(unit).toContain('ReviewChoiceDialog')
    expect(unit).toContain('/temp-review?words=')
    expect(temp).toContain('tempWords=')
    expect(temp).toContain('tempRecordMode=')
    expect(study).toContain('tempWordIds')
    expect(study).toContain("tempRecordMode === 'practice'")
    expect(hook).toContain('tempNext:')
    expect(hook).toContain('rateTempReview')
    expect(src('app/router.tsx')).toContain("path: 'temp-review'")
  })
})
