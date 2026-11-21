import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'

const noop = () => undefined
const base = {
  headword: 'denounce',
  meaningCn: '公开宣告',
  count: 0,
  total: 3,
  phraseLines: [],
  showPhrases: false,
  fontScale: 1,
  cardSize: 1,
  onTap: noop,
}

describe('task-247 顶部提示按三小次开关切换', () => {
  it('threeTapRecall=true 只显示单行短提示', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryStage, { ...base, threeTapRecall: true } as never),
    )
    expect(html).toContain('请熟悉/记忆下述映射')
    expect(html).not.toContain('wc-memory-reminder-list')
    expect(html).not.toContain('心里按音节默写单词')
  })

  it('threeTapRecall=false 保持完整多行圆圈提示', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryStage, { ...base, threeTapRecall: false } as never),
    )
    expect(html).toContain('推荐学习流程')
    expect(html).toContain('wc-root-process')
    expect(html).toContain('<li>')
  })

  it('StudyPage 传入 memory.threeTapRecall', () => {
    const page = readFileSync(
      fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
      'utf8',
    )
    expect(page).toContain("threeTapRecall={appSettings?.['memory.threeTapRecall'] !== false}")
  })
})
