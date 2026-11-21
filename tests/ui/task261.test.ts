import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const addWords = src('ui/home/AddTodayWordsDialog.tsx')
const wordDetail = src('ui/decks/WordDetailPage.tsx')
const deckDetail = src('ui/decks/DeckDetailPage.tsx')
const unit = src('ui/decks/UnitDetailPage.tsx')
const ranking = src('ui/stats/RankingPage.tsx')
const toolbar = src('ui/components/BulkSelectToolbar.tsx')
const css = src('app/styles/global.css')

describe('task-261 A：数量输入允许清空', () => {
  it('字符串 state + 失焦/提交校验，不每键 clamp', () => {
    expect(addWords).toContain("useState('20')")
    expect(addWords).toContain('const parsedCount')
    expect(addWords).toContain('const commitCount')
    expect(addWords).toContain('onBlur={commitCount}')
    expect(addWords).not.toContain('Number(event.target.value) || 20')
    expect(addWords).toContain("countInput.trim() !== ''")
  })
})

describe('task-261 B：词库单词全屏注释详情', () => {
  it('全屏路由/AnnotationStage/无评分/保留编辑删除', () => {
    expect(src('app/router.tsx')).toContain("path: 'decks/:deckId/words/:wordId'")
    expect(deckDetail).toContain('detailWord=')
    expect(src('ui/study/StudyPage.tsx')).toContain('detailWordId')
    expect(src('ui/study/StudyPage.tsx')).toContain('hideRating={detailMode || tempMode}')
    expect(wordDetail).toContain('AnnotationStage')
    expect(wordDetail).toContain('不提供认识/模糊/不认识评分')
    expect(wordDetail).not.toContain('评分按钮组')
    expect(wordDetail).toContain('编辑')
    expect(wordDetail).toContain('删除')
    expect(wordDetail).toContain('listUserNotes')
    expect(wordDetail).toContain('listUserMnemonics')
    expect(wordDetail).toContain('coreSenses')
  })
})

describe('task-261 C：通用批量选择工具条', () => {
  it('全选/反选/取消/排序/筛选/搜索/999 提示，应用到三处', () => {
    expect(toolbar).toContain('全选')
    expect(toolbar).toContain('反选')
    expect(toolbar).toContain('取消全选')
    expect(toolbar).toContain('排序')
    expect(toolbar).toContain('状态筛选')
    expect(toolbar).toContain('已选')
    expect(toolbar).toContain('筛选')
    expect(unit).toContain('BulkSelectToolbar')
    expect(unit).toContain('getChapterWordIds')
    expect(ranking).toContain('BulkSelectToolbar')
    expect(ranking).toContain('getRankingWordIds')
    expect(addWords).toContain('BulkSelectToolbar')
    expect(addWords).toContain('getManualNewWordCandidateIds')
    expect(unit).toContain('最多批量选择 999 个词')
    expect(ranking).toContain('最多批量选择 999 个词')
    expect(css).toContain('.bulk-toolbar')
    expect(css).toContain('@media (max-width: 360px)')
  })
})
