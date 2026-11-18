import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { coreSenseDisplayContent, pickCoreSenseEntry } from '../../src/ui/study/lib/core-sense-display'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

const savedExamples = {
  coreSenseIndex: 1,
  label: '公开宣告',
  examples: [{ en: 'AI saved example.', cn: 'AI 保存例句。' }],
  source: 'ai' as const,
  updatedAt: 1,
}
const savedPhrases = {
  coreSenseIndex: 1,
  label: '公开宣告',
  phrases: [{ en: 'denounce the plan', cn: '公开宣布计划' }],
  source: 'ai' as const,
  updatedAt: 1,
}
const representative = {
  examples: [{ en: 'Critics example.', cn: '代表 c 例句。' }],
  phrases: [{ en: 'representative phrase', cn: '代表 c 词组' }],
}

describe('task-219 保存的本义例句/词组优先显示', () => {
  it('label 优先/index 兜底；已保存优先于 representative；数量截断/0 隐藏', () => {
    expect(pickCoreSenseEntry([{ coreSenseIndex: 1, label: '公开宣告', entry: savedExamples }], { index: 1, label: '公开宣告' })).toBe(savedExamples)
    expect(pickCoreSenseEntry([{ coreSenseIndex: 1, label: '旧名', entry: savedExamples }], { index: 1, label: '新名' })).toBe(savedExamples)
    const display = coreSenseDisplayContent({
      exampleCount: 2,
      phraseCount: 2,
      representative,
      savedExamples,
      savedPhrases,
    })
    expect(display.examples[0]!.en).toBe('AI saved example.')
    expect(display.phrases[0]!.en).toBe('denounce the plan')
    const zero = coreSenseDisplayContent({
      exampleCount: 0,
      phraseCount: 0,
      representative,
      savedExamples,
      savedPhrases,
    })
    expect(zero.examples).toEqual([])
    expect(zero.phrases).toEqual([])
    const truncated = coreSenseDisplayContent({
      exampleCount: 1,
      phraseCount: 0,
      representative,
      savedExamples: { ...savedExamples, examples: [savedExamples.examples[0]!, savedExamples.examples[0]!] },
      savedPhrases,
    })
    expect(truncated.examples).toHaveLength(1)
  })

  it('hook 读取 ExampleViews/PhraseViews 并优先保存内容；页面传 core phrases', () => {
    const hook = src('ui/study/hooks/useStudySession.ts')
    expect(hook).toContain('listCoreSenseExampleViews')
    expect(hook).toContain('listCoreSensePhraseViews')
    expect(hook).toContain('coreSenseDisplayContent')
    const page = src('ui/study/StudyPage.tsx')
    expect(page).toContain('study.coreSenseContent?.phrases')
    expect(page).toContain('coreSenseExamples')
    const panel = src('ui/study/components/CoreSenseAIPanel.tsx')
    expect(panel).toContain('saveCoreSenseExamples')
    expect(panel).toContain('saveCoreSensePhrases')
    expect(panel).toContain('onChanged?.()')
  })
})
