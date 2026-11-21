import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { AppProviders } from '../../src/app/providers'
import { AppRoutes } from '../../src/app/router'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const unitList = src('ui/decks/UnitListPage.tsx')
const unitDetail = src('ui/decks/UnitDetailPage.tsx')
const ranking = src('ui/stats/RankingPage.tsx')
const addWords = src('ui/home/AddTodayWordsDialog.tsx')
const settings = src('ui/me/SettingsPage.tsx')
const router = src('app/router.tsx')
const css = src('app/styles/global.css')

describe('task-259 单元/排行/添加新词', () => {
  it('首页按钮 + 添加弹窗三种方式/已有计划处理/API', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(AppProviders, null, createElement(AppRoutes, null)),
      ),
    )
    expect(html).toContain('今日')
    expect(src('ui/home/HomePage.tsx')).toContain('添加今日新单词')
    expect(addWords).toContain('手动筛选')
    expect(addWords).toContain('随机选择')
    expect(addWords).toContain('顺序选择')
    expect(addWords).toContain('保留今日计划并追加')
    expect(addWords).toContain('移除今天未学的自动新词后追加')
    expect(addWords).toContain('仅移除未学的自动新词')
    expect((addWords.match(/移除今天未学的自动新词后追加/g) ?? []).length).toBe(1)
    expect(src('ui/components/Dialog.tsx')).toContain('createPortal')
    expect(src('ui/components/Dialog.tsx')).toContain('document.body')
    expect(addWords).toContain('getManualNewWordCandidates')
    expect(addWords).toContain('pickUnlearnedNewWords')
    expect(addWords).toContain('appendNewWordsToTodayPlan')
    expect(addWords).toContain('removeUnlearnedAutoNewWords')
    expect(addWords).toContain('getDeckChapters')
  })

  it('单元入口/详情/进度定位/抽词', () => {
    expect(router).toContain("path: 'decks/:deckId/units'")
    expect(router).toContain("path: 'decks/:deckId/units/:chapter'")
    expect(unitList).toContain('getDeckChapters')
    expect(unitList).toContain('getDeckProgressLocation')
    expect(unitList).toContain('当前：')
    expect(unitDetail).toContain('getWordsByChapter')
    expect(unitDetail).toContain('抽这些词复习')
    expect(unitDetail).toContain('appendWordsToTodayPlan')
    expect(unitDetail).toContain('已学')
    expect(unitDetail).toContain('未学')
    expect(unitDetail).toContain('搜索单元单词')
    expect(unitDetail).toContain('BulkSelectToolbar')
  })

  it('完整排行：最不熟/最熟/前20/详情/抽词', () => {
    expect(router).toContain("path: 'stats/ranking'")
    expect(ranking).toContain('getWordFamiliarityRanking')
    expect(ranking).toContain('最不熟')
    expect(ranking).toContain('最熟')
    expect(ranking).toContain('最不熟前 20 一键')
    expect(ranking).toContain('抽这些词复习')
    expect(ranking).toContain('appendWordsToTodayPlan')
    expect(ranking).toContain('word.meanings')
  })

  it('设置新词来源 manual/auto + CSS', () => {
    expect(settings).toContain('新词来源')
    expect(settings).toContain("'study.newWordSource': 'manual'")
    expect(settings).toContain("'study.newWordSource': 'auto'")
    expect(css).toContain('.unit-pick-bar')
    expect(css).toContain('.add-word-candidates')
    expect(css).toContain('@media (max-width: 360px)')
  })
})
