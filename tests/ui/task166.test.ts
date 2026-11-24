import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SubwordDialog } from '../../src/ui/study/components/SubwordDialog'
import { DerivationPanel } from '../../src/ui/study/components/DerivationPanel'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'

const noop = () => undefined

describe('task-166：局部词/nc/JSON 入口', () => {
  it('点击单词弹层：显示局部词词性+中文；无结果显示提示', () => {
    const withItems = renderToStaticMarkup(
      createElement(SubwordDialog, {
        open: true,
        headword: 'marginal',
        items: [{ id: 'w:margin', headword: 'margin', pos: 'n.', cn: '边缘' }],
        onClose: noop,
      }),
    )
    expect(withItems).toContain('marginal 的局部/接近词')
    expect(withItems).toContain('margin')
    expect(withItems).toContain('n. · 边缘')

    const empty = renderToStaticMarkup(
      createElement(SubwordDialog, { open: true, headword: 'x', items: [], onClose: noop }),
    )
    expect(empty).toContain('没有找到可展示的局部/接近词')
  })

  it('注释面 nc 标记 + 右页 nc 列表/JSON 按钮', () => {
    const annotation = renderToStaticMarkup(
      createElement(AnnotationStage, {
        headword: 'bank',
        phonetic: '',
        showPhonetic: false,
        coreSenses: [],
        meanings: [
          { meaningId: 'm1', pos: 'n.', cn: '银行', clicks: 0, encounters: 1, familiarity: 0 },
        ],
        examples: [],
        mnemonics: [],
        ncMeaningIds: ['m1'],
        onMarkMeaning: noop,
        phrases: [],
        showPhrases: false,
        speaking: false,
        onSpeak: noop,
      } as never),
    )
    expect(annotation).toContain('nc-badge')

    const panel = renderToStaticMarkup(
      createElement(DerivationPanel, {
        open: true,
        headword: 'bank',
        content: { mode: 'text' as const, text: 'x', mermaid: '' },
        ncLabels: ['银行'],
        onExportJson: noop,
        onImportJson: noop,
        onClose: noop,
        onSave: noop,
      }),
    )
    expect(panel).toContain('导出 JSON')
    expect(panel).toContain('导入 JSON')
    expect(panel).toContain('nc（不易理解真实指代的含义）')
    expect(panel).toContain('银行')
  })
})
