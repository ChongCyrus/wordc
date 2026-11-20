import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const panel = src('ui/study/components/SenseMnemonicPanel.tsx')
const memory = src('ui/study/components/MemoryStage.tsx')
const gen = src('ui/study/components/GenerativeMemoryStage.tsx')
const css = src('ui/study/styles/study.css')

describe('task-249 B：串联对象勾选', () => {
  it('默认排除 rare、全选/反选/取消、只传勾选对象、空选禁用', () => {
    expect(panel).toContain('getRareCoreSenseIndexes')
    expect(panel).toContain('overviewTargets')
    expect(panel).toContain('默认排除已标记不常考的本义')
    expect(panel).toContain('.filter((sense) => Boolean(sense.label) && overviewTargets.has(sense.index))')
    expect(panel).toContain('.filter((mapping) => overviewTargets.has(mapping.coreSenseIndex))')
    expect(panel).toContain("overviewTargets.size === 0")
    expect(css).toContain('.sense-overview-targets')
    // 打开/加载重置为默认
    expect(panel).toContain('setOverviewTargets(')
  })
})

describe('task-249 C：第三拍刷新反馈', () => {
  it('MemoryStage/生成式卡片 key 随 count 变化触发 fade-in', () => {
    expect(memory).toContain('key={`${memoryPhase}-${safeCount}-${threeTapRecall')
    expect(gen).toContain('key={`gen-count-${count}-${subTap}`}')
    expect(css).toContain('animation: study-card-in')
  })
})

describe('task-249 A：false 模式 final 渲染不依赖 threeTap', () => {
  it('MemoryStage 的 hidden/final 渲染按 memoryPhase，而不是 threeTapRecall 开关', () => {
    expect(memory).toContain("memoryPhase === 'hidden' || memoryPhase === 'final-hidden'")
    expect(memory).toContain("memoryPhase === 'final-summary'")
    const html = renderToStaticMarkup(
      createElement(MemoryStage, {
        headword: 'denounce',
        meaningCn: '公开宣告',
        count: 2,
        total: 2,
        phraseLines: [],
        showPhrases: false,
        fontScale: 1,
        cardSize: 1,
        memoryPhase: 'final-hidden',
        showMeaning: false,
        threeTapRecall: false,
        meaningPos: '动',
        summaryEntries: [{ meaningId: 'M1', kind: 'meaning', pos: '动', cn: '谴责' }],
        onTap: () => undefined,
      } as never),
    )
    expect(html).toContain('denounce')
    expect(html).toContain('[动]')
    expect(html).toContain('?')
    expect(html).not.toContain('公开宣告')
  })
})
