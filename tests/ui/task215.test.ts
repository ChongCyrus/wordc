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

const base = {
  headword: 'denounce',
  phonetic: '',
  showPhonetic: false,
  coreSenses: [{ label: '公开宣告' }, { label: '行动举措' }],
  onToggleRareCoreSense: noop,
  meanings: [],
  examples: [],
  mnemonics: [],
  phrases: [],
  showPhrases: false,
  speaking: false,
  onSpeak: noop,
  onMarkMeaning: noop,
}

describe('task-215 本义手动标记/取消不常考', () => {
  it('未标记显示「标记不常考」，已标记显示「取消不常考」+ aria', () => {
    const unmarked = renderToStaticMarkup(createElement(AnnotationStage, { ...base } as never))
    expect(unmarked).toContain('rare-toggle-btn')
    expect(unmarked).toContain('标记不常考')
    expect(unmarked).toContain('aria-label="标记本义1「公开宣告」为不常考"')
    expect(unmarked).not.toContain('取消不常考')

    const marked = renderToStaticMarkup(
      createElement(AnnotationStage, {
        ...base,
        rareCoreSenseIndexes: [1],
        hideRareBlocks: false,
        onCancelRareCoreSense: noop,
      } as never),
    )
    expect(marked).toContain('取消不常考')
    expect(marked).toContain('rare-toggle-btn is-rare')
    expect(marked).toContain('aria-label="取消本义1「公开宣告」的不常考标记"')
  })

  it('按钮不冒泡触发整卡 +clicks；标记后进入隐藏过滤', () => {
    const annotation = src('ui/study/components/AnnotationStage.tsx')
    expect(annotation).toContain('event.stopPropagation()')
    expect(annotation).toContain('onToggleRareCoreSense(index + 1, sense.label')
    expect(annotation).toContain('rareCoreSet.has(index + 1)')
    const page = src('ui/study/StudyPage.tsx')
    expect(page).toContain('onToggleRareCoreSense')
    expect(page).toContain('setRareCoreSenseIndexes(session.word.wordId, next)')
    expect(page).toContain('已标记本义不常考')
    expect(page).toContain('标记本义不常考失败')
  })
})
