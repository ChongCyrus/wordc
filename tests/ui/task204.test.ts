import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'

const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)
const panel = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/SenseMnemonicPanel.tsx', import.meta.url)),
  'utf8',
)
const page = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/StudyPage.tsx', import.meta.url)),
  'utf8',
)
const noop = () => undefined

function annotation(coreSenses: Array<{ label: string; note?: string; origin?: string }>, senseMnemonics: Array<{ coreSenseIndex: number; label: string; text: string; source: 'manual' | 'ai' }> = []) {
  return renderToStaticMarkup(
    createElement(AnnotationStage, {
      headword: 'denounce',
      phonetic: '',
      showPhonetic: false,
      coreSenses,
      senseMnemonics,
      onOpenSenseMnemonicPanel: noop,
      onEditSenseMnemonic: noop,
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
}

describe('task-204 本义集合视觉重排', () => {
  it('本义项卡片：徽标+label+来源右上+助记块左条/无重复前缀/aria-label', () => {
    const html = annotation(
      [{ label: '公开宣告', note: '公开说明', origin: 'de- + nuntiare' }],
      [{ coreSenseIndex: 1, label: '公开宣告', text: 'de(向下)+nounce(宣布)：向下宣布→公开宣告', source: 'ai' }],
    )
    expect(html).toContain('core-sense-card')
    expect(html).toContain('core-sense-badge')
    expect(html).toContain('core-sense-label')
    expect(html).toContain('core-sense-source')
    expect(html).toContain('core-sense-mnemonic-block')
    expect(html).toContain('aria-label="本义助记·本义1「公开宣告」 的助记，点击编辑"')
    expect(html).not.toContain('本义助记·本义1「公开宣告」：de(')
  })

  it('同 origin 只显示一次（trim 比较）；不同 origin 分别显示', () => {
    const html = annotation([
      { label: '甲', origin: ' 词源A ' },
      { label: '乙', origin: '词源A' },
      { label: '丙', origin: '词源B' },
    ])
    expect((html.match(/词源：词源A/g) ?? []).length).toBe(1)
    expect((html.match(/词源：词源B/g) ?? []).length).toBe(1)
  })

  it('长助记折叠展开按钮 + 深链初始编辑', () => {
    const longText = '这是一条很长很长的本义助记内容，用于验证两行折叠和展开按钮是否出现。'.repeat(2)
    const html = annotation([{ label: '公开宣告' }], [
      { coreSenseIndex: 1, label: '公开宣告', text: longText, source: 'manual' },
    ])
    expect(html).toContain('is-collapsed')
    expect(html).toContain('展开')
    expect(html).toContain('core-sense-mnemonic-toggle')
    expect(panel).toContain('initialEditIndex')
    expect(panel).toContain('setEditor({')
    expect(page).toContain('onEditSenseMnemonic')
    expect(page).toContain('initialEditIndex={senseEditIndex}')
    expect(css).toContain('.core-sense-card')
    expect(css).toContain('gap: 14px')
    expect(css).toContain('border-left: 3px solid var(--mm-primary)')
    expect(css).toContain('-webkit-line-clamp: 2')
    expect(css).toContain('position: absolute; top: 8px; right: 10px')
  })
})
