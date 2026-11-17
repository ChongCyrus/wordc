import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'

const source = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/AnnotationStage.tsx', import.meta.url)),
  'utf8',
)
const noop = () => undefined

const html = renderToStaticMarkup(
  createElement(AnnotationStage, {
    headword: 'denounce',
    phonetic: '',
    showPhonetic: false,
    meanings: [
      {
        meaningId: 'M1',
        pos: '动',
        cn: '谴责',
        familiarity: { clicks: 0, encounters: 0 },
      },
    ],
    mnemonics: [{ id: 'mn1', meaningId: 'M1', type: '词根', text: 'depend(依赖)+ency' }],
    examples: [],
    phrases: [],
    showPhrases: false,
    speaking: false,
    onSpeak: noop,
    onMarkMeaning: noop,
    onEditMnemonic: noop,
  } as never),
)

describe('task-207 c 行 AI 助记整行编辑', () => {
  it('去掉编辑按钮，整行 role=button + aria-label + tabIndex', () => {
    expect(html).toContain('meaning-mnemonic is-editable')
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('aria-label="编辑含义谴责 的 AI 助记"')
    expect(html).not.toContain('>编辑</button>')
    expect(html).toContain('depend(依赖)+ency')
  })

  it('键盘 Enter/Space 触发；笔记类编辑按钮保留', () => {
    expect(source).toContain("event.key === 'Enter' || event.key === ' '")
    expect(source).toContain('event.preventDefault()')
    expect(source).toContain('编辑含义 ${meaning.cn} 的我的笔记')
    expect(source).toContain('编辑含义 ${meaning.cn} 的我的助记')
  })
})
