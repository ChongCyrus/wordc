import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'

const noop = () => undefined
const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const css = src('ui/study/styles/study.css')

describe('task-212 本义不熟悉度 + 只记本义加权', () => {
  it('本义卡显示 clicks/encounters、百分比与 4px 条', () => {
    const html = renderToStaticMarkup(
      createElement(AnnotationStage, {
        headword: 'denounce',
        phonetic: '',
        showPhonetic: false,
        coreSenses: [{ label: '公开宣告' }, { label: '行动举措' }],
        coreSenseStatsByIndex: { 1: { clicks: 3, encounters: 5 } },
        coreSenseFamiliarityByIndex: { 1: 0.6, 2: null },
        onCoreSenseClick: noop,
        meanings: [],
        examples: [],
        mnemonics: [],
        phrases: [],
        showPhrases: false,
        speaking: false,
        onSpeak: noop,
        onMarkMeaning: noop,
      } as never),
    )
    expect(html).toContain('core-sense-stats')
    expect(html).toContain('3/5')
    expect(html).toContain('60%')
    expect(html).toContain('fam-bar')
    expect(html).toContain('fam-bar--')
  })

  it('点击整卡 +clicks，助记块不冒泡；rare 卡不可点', () => {
    const annotation = src('ui/study/components/AnnotationStage.tsx')
    expect(annotation).toContain('onCoreSenseClick?.(index + 1, sense.label)')
    expect(annotation).toContain('if (rareCoreSet.has(index + 1)) return')
    expect(annotation).toContain('event.stopPropagation()')
    const page = src('ui/study/StudyPage.tsx')
    expect(page).toContain('recordCoreSenseClick')
    expect(page).toContain('recordCoreSenseEncounters')
    expect(page).toContain('coreEncounteredRef')
    expect(page).toContain('coreSenseStatsByIndex')
  })

  it('加权只记本义：设置/构建/回退/切换/开关 UI', () => {
    const hook = src('ui/study/hooks/useStudySession.ts')
    expect(hook).toContain('memory.weightedCoreSenseOnly')
    expect(hook).toContain('buildCoreSenseWeightedUnits')
    expect(hook).toContain('toCoreSenseSessionWord')
    expect(hook).toContain('built.hasUsable')
    expect(hook).toContain('该词暂无可用本义，已回退普通加权记忆')
    expect(hook).toContain('switchWeightedCoreOnly')
    expect(hook).toContain('本次进度已重置')
    const page = src('ui/study/StudyPage.tsx')
    expect(page).toContain('weighted-core-only-toggle')
    expect(page).toContain('只记本义')
    expect(css).toContain('.weighted-core-only-toggle')
    expect(css).toContain('position: fixed; top: 56px; right: 12px')
    expect(css).toContain('.core-sense-card:not(.is-rare):active')
    expect(css).toContain('transition: background-color 120ms')
  })
})
