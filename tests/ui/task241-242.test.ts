import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'

const noop = () => undefined
const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const stageBase = {
  headword: 'denounce',
  meaningCn: '公开宣告',
  count: 1,
  total: 3,
  phraseLines: [{ en: 'denounce the plan', cn: '公开宣布计划' }],
  showPhrases: true,
  fontScale: 1,
  cardSize: 1,
  rootLabel: 'fixture本义',
  examples: [{ en: 'He denounced the plan.', cn: '他公开宣布了计划。' }],
  mnemonics: [{ type: '联想', text: '助记文本' }],
  onTap: noop,
}

describe('task-241 MemoryStage 三拍/final', () => {
  it('hidden 只显示 w+小圈，隐藏释义/生成元/例句/词组；verify/normal 显示', () => {
    const hidden = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...stageBase,
        memoryPhase: 'hidden',
        showMeaning: false,
        derivation: { steps: ['本义步骤', '引申步骤'] },
        currentLine: '当前行',
        coreSenseGloss: '本义解释',
        coreSenseOverview: '串联记忆',
        familiarity: 0.5,
        userNotes: [{ id: 'n1', text: '笔记' }],
      } as never),
    )
    expect(hidden).toContain('denounce')
    expect(hidden).toContain('wc-dots')
    expect(hidden).not.toContain('公开宣告')
    expect(hidden).not.toContain('fixture本义')
    expect(hidden).not.toContain('He denounced the plan.')
    expect(hidden).not.toContain('公开宣布计划')
    expect(hidden).not.toContain('derivation-chain')
    expect(hidden).not.toContain('当前行')
    expect(hidden).not.toContain('本义解释')
    expect(hidden).not.toContain('串联记忆')
    expect(hidden).not.toContain('不熟悉度')
    const verify = renderToStaticMarkup(
      createElement(MemoryStage, { ...stageBase, memoryPhase: 'verify', showMeaning: true } as never),
    )
    expect(verify).toContain('公开宣告')
  })

  it('final-hidden 只 w；final-summary 显示全部映射 pos+cn / 本义 label+gloss', () => {
    const finalHidden = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...stageBase,
        memoryPhase: 'final-hidden',
        showMeaning: false,
      } as never),
    )
    expect(finalHidden).toContain('denounce')
    expect(finalHidden).not.toContain('公开宣告')
    const summary = renderToStaticMarkup(
      createElement(MemoryStage, {
        ...stageBase,
        memoryPhase: 'final-summary',
        showMeaning: false,
        summaryEntries: [
          { meaningId: 'M1', kind: 'meaning', pos: '动', cn: '谴责' },
          { meaningId: 'core:1', kind: 'core-sense', cn: '公开宣告', label: '公开宣告', gloss: '当众斥其非' },
        ],
      } as never),
    )
    expect(summary).toContain('本词全部映射')
    expect(summary).toContain('[动] 谴责')
    expect(summary).toContain('当众斥其非')
    expect(summary).not.toContain('He denounced the plan.')
  })

  it('StudyPage 用 helper 传 phase/showMeaning/summary；设置映射', () => {
    const page = src('ui/study/StudyPage.tsx')
    expect(page).toContain('memoryViewPhase(session)')
    expect(page).toContain('memoryShowMeaning(session)')
    expect(page).toContain('memorySummaryEntries(session)')
    const hook = src('ui/study/hooks/useStudySession.ts')
    expect(hook).toContain("threeTapRecall: s['memory.threeTapRecall'] !== false")
    const settings = src('ui/me/SettingsPage.tsx')
    expect(page).toContain('三小次模式')
    expect(page).toContain('memory.threeTapRecall')
    expect(settings).toContain('记忆卡切换闪动动画')
    expect(settings).toContain("s['memory.cardFlashAnimation'] === true")
  })
})

describe('task-242 生成式阶段2三拍', () => {
  const gen = src('ui/study/components/GenerativeMemoryStage.tsx')
  it('用 subTapAfterTap 三拍，第3拍才 count+1，最后进阶段3；false 旧行为', () => {
    expect(gen).toContain('subTapAfterTap(subTap)')
    expect(gen).toContain("setSubTap('full')")
    expect(gen).toContain('if (!threeTapRecall)')
    expect(gen).toContain('next >= clicksRequired')
    expect(gen).toContain('phase2ShowMeaning')
    expect(gen).toContain('threeTapRecall = true')
  })
})
