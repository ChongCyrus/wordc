import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  EMPTY_TODAY_BREAKDOWN,
  groupsOf,
  wordTags,
  type TodayBreakdownView,
  type TodayWordView,
} from '../../src/ui/today/today-types'
import { TodayWordsView } from '../../src/ui/today/TodayWordsView'

const word = (overrides: Partial<TodayWordView>): TodayWordView => ({
  wordId: 'w',
  headword: 'word',
  category: 'review',
  learned: false,
  isExtra: false,
  requeued: false,
  ...overrides,
})

const breakdown: TodayBreakdownView = {
  review: { planned: 3, learned: 2, remaining: 1 },
  new: { planned: 4, learned: 1, remaining: 3 },
  totalPlanned: 7,
  totalLearned: 3,
  items: [
    word({ wordId: 'r1', headword: 'embrace', category: 'review', learned: true, rating: 'familiar' }),
    word({ wordId: 'r2', headword: 'abandon', category: 'review', learned: true, rating: 'vague', requeued: true }),
    word({ wordId: 'r3', headword: 'benefit', category: 'review' }),
    word({ wordId: 'n1', headword: 'cat', category: 'new', learned: true, rating: 'forgot' }),
    word({ wordId: 'n2', headword: 'dog', category: 'new', isExtra: true }),
    word({ wordId: 'n3', headword: 'nose', category: 'new' }),
    word({ wordId: 'n4', headword: 'yellow', category: 'new' }),
  ],
}

describe('今日单词页（task-50）', () => {
  it('两分区渲染：复习（planned/learned）与新学（planned/learned）', () => {
    const html = renderToStaticMarkup(
      createElement(TodayWordsView, { breakdown, onSelectWord: () => undefined }),
    )
    expect(html).toContain('复习（3）')
    expect(html).toContain('新学（4）')
    expect(html).toContain('已学 2 · 未学 1')
    expect(html).toContain('已学 1 · 未学 3')
    // 顶部已学汇总
    expect(html).toContain('复习已学')
    expect(html).toContain('新学已学')
  })

  it('每词标签：评分（认识/模糊/忘记）、未学、加学、回炉', () => {
    const html = renderToStaticMarkup(
      createElement(TodayWordsView, { breakdown, onSelectWord: () => undefined }),
    )
    expect(html).toContain('embrace')
    expect(html).toContain('认识')
    expect(html).toContain('模糊')
    expect(html).toContain('忘记')
    expect(html).toContain('未学')
    expect(html).toContain('加学')
    expect(html).toContain('回炉')
    // 已学词不再显示未学标签
    const embraceRow = html.slice(html.indexOf('embrace'), html.indexOf('abandon'))
    expect(embraceRow).toContain('认识')
    expect(embraceRow).not.toContain('未学')
  })

  it('分组顺序：复习组在左/上，新学组在其后；组内保持 items 顺序', () => {
    const groups = groupsOf(breakdown)
    expect(groups.review.map((item) => item.headword)).toEqual(['embrace', 'abandon', 'benefit'])
    expect(groups.new.map((item) => item.headword)).toEqual(['cat', 'dog', 'nose', 'yellow'])
  })

  it('复习上限 backlog（task-52）：>0 时显示「其余 X 个将在之后复习」', () => {
    const html = renderToStaticMarkup(
      createElement(TodayWordsView, {
        breakdown,
        reviewBacklog: 409,
        onSelectWord: () => undefined,
      }),
    )
    expect(html).toContain('其余 409 个到期复习将在之后复习')

    const none = renderToStaticMarkup(
      createElement(TodayWordsView, { breakdown, reviewBacklog: 0, onSelectWord: () => undefined }),
    )
    expect(none).not.toContain('其余')
  })

  it('空态：无计划/未开始 → 「今天还没有学习记录」', () => {
    const html = renderToStaticMarkup(
      createElement(TodayWordsView, {
        breakdown: EMPTY_TODAY_BREAKDOWN,
        onSelectWord: () => undefined,
      }),
    )
    expect(html).toContain('今天还没有学习记录')
    expect(html).not.toContain('复习（')
  })

  it('wordTags：已学显示评分；未学显示「未学」；加学/回炉为附加标签', () => {
    expect(wordTags(breakdown.items[0]!).map((t) => t.label)).toEqual(['认识'])
    expect(wordTags(breakdown.items[2]!).map((t) => t.label)).toEqual(['未学'])
    expect(wordTags(breakdown.items[1]!).map((t) => t.label)).toEqual(['模糊', '回炉'])
    expect(wordTags(breakdown.items[4]!).map((t) => t.label)).toEqual(['未学', '加学'])
  })
})
