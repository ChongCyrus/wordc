import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const unit = src('ui/decks/UnitDetailPage.tsx')
const deck = src('ui/decks/DeckDetailPage.tsx')
const ranking = src('ui/stats/RankingPage.tsx')
const addWords = src('ui/home/AddTodayWordsDialog.tsx')
const toolbar = src('ui/components/BulkSelectToolbar.tsx')

describe('task-268 列表/排序/选择/记忆', () => {
  it('单元点击复用 StudyPage detailWord，与词库一致', () => {
    expect(unit).toContain('/study?detailWord=')
    expect(unit).toContain('returnTo=')
  })

  it('所有多词排序支持升降序', () => {
    expect(toolbar).toContain('onDirectionChange')
    expect(toolbar).toContain('排序方向')
    expect(toolbar).toContain('升序')
    expect(unit).toContain('direction={direction}')
    expect(deck).toContain('direction={selectDirection}')
    expect(ranking).toContain('direction={direction}')
    expect(addWords).toContain('direction={direction}')
  })

  it('词库列表每行不熟悉度 + 选择前N + 添加模式记忆', () => {
    expect(deck).toContain('不熟悉')
    expect(deck).toContain('familiarityMap')
    expect(toolbar).toContain('选择前 N 个')
    for (const file of [unit, deck, ranking, addWords]) {
      expect(file).toContain('onSelectFirstN')
    }
    expect(addWords).toContain("study.addWordMode")
    expect(addWords).toContain("study.addWordCount")
    expect(addWords).toContain('patchSettings')
  })

  it('临时复习复用 StudyPage 全流程（tempWords/recordMode/practice 下一个）', () => {
    const study = src('ui/study/StudyPage.tsx')
    const temp = src('ui/study/TempReviewPage.tsx')
    expect(temp).toContain('Navigate')
    expect(temp).toContain('tempWords=')
    expect(study).toContain('tempWordIds')
    expect(study).toContain('tempRecordMode')
    expect(study).toContain('onPracticeAssess=')
  })

  it('detail 返回兜底：超时错误态/loading 均可返回来源', () => {
    const hook = src('ui/study/hooks/useStudySession.ts')
    const study = src('ui/study/StudyPage.tsx')
    expect(hook).toContain('加载详情超时，请返回重试')
    expect(hook).toContain('withTimeout')
    expect(study).toContain("detailMode || tempMode ? '返回'")
    expect(study).toContain('detailReturnTo')
    expect(study).toContain('tempReturnTo')
    const home = src('ui/home/HomePage.tsx')
    expect(home).toContain("settings?.['study.newWordSource'] === 'auto' ? study.newCount : 0")
  })

  it('单元首帧不渲染空态：loading guard', () => {
    expect(unit).toContain('useState(true)')
    expect(unit).toContain('setLoading(true)')
    expect(unit).toContain('正在加载单元单词')
    expect(unit.indexOf('正在加载单元单词')).toBeLessThan(unit.lastIndexOf('EmptyState'))
    expect(ranking).toContain('正在加载排行')
  })
})
