import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UserContentEditor } from '../../src/ui/study/components/UserContent'
import { AnnotationStage } from '../../src/ui/study/components/AnnotationStage'
import { MemoryStage } from '../../src/ui/study/components/MemoryStage'
import { visibleMnemonics } from '../../src/ui/study/lib/user-mnemonics'

const noop = () => undefined

const meaning = {
  meaningId: 'w#M1',
  pos: 'n.',
  cn: '银行',
  clicks: 0,
  encounters: 1,
  familiarity: 0,
}

function annotation(userNotes: unknown[], userMnemonics: unknown[]): string {
  return renderToStaticMarkup(
    createElement(AnnotationStage, {
      headword: 'bank',
      phonetic: '',
      showPhonetic: false,
      coreSenses: [],
      meanings: [meaning],
      examples: [],
      mnemonics: [{ type: '联想', text: 'AI 助记内容', meaningId: 'w#M1' }],
      userNotes,
      userMnemonics,
      onEditUserNote: noop,
      onEditUserMnemonic: noop,
      onEditMnemonic: noop,
      phrases: [],
      showPhrases: false,
      speaking: false,
      onSpeak: noop,
      onMarkMeaning: noop,
    } as never),
  )
}

describe('F6 用户笔记/助记 UI', () => {
  it('编辑弹层：目标/文本域/类型选择/保存取消；空内容不可保存', () => {
    const note = renderToStaticMarkup(
      createElement(UserContentEditor, {
        open: true,
        targetLabel: 'c：银行',
        mode: 'note',
        initialText: '',
        onSave: noop,
        onClose: noop,
      }),
    )
    expect(note).toContain('我的笔记 · c：银行')
    expect(note).toContain('textarea')
    expect(note).toContain('disabled')
    expect(note).not.toContain('助记类型')

    const mnemonic = renderToStaticMarkup(
      createElement(UserContentEditor, {
        open: true,
        targetLabel: 'bank',
        mode: 'mnemonic',
        initialText: 'bank 河岸→银行',
        onSave: noop,
        onDelete: noop,
        onClose: noop,
      }),
    )
    expect(mnemonic).toContain('我的助记 · bank')
    expect(mnemonic).toContain('助记类型')
    expect(mnemonic).toContain('删除')
    expect(mnemonic).toContain('保存')
  })

  it('注释面：用户内容标「我的」、AI 助记标「AI」；每 c 有笔记/助记编辑入口', () => {
    const html = annotation(
      [{ id: 'n1', text: '我的笔记内容', meaningId: 'w#M1' }],
      [{ id: 'm1', type: '谐音', text: '我的助记内容', meaningId: 'w#M1' }],
    )
    expect(html).toContain('我的笔记内容')
    expect(html).toContain('我的助记内容')
    expect(html).toContain('mine-badge')
    expect(html).toContain('ai-badge')
    expect(html).toContain('AI 助记内容')
    expect(html).toContain('编辑含义 银行 的我的笔记')
    expect(html).toContain('编辑含义 银行 的我的助记')
    expect(html).toContain('词级') // 词级用户内容区标题
  })

  it('助记合并：隐藏的 AI 原条目过滤、用户副本覆盖同 key（F6 补充）', () => {
    const word = {
      mnemonics: [
        { type: '联想', text: 'AI 原文', meaningId: 'w#M1' },
        { type: '谐音', text: '另一条 AI', meaningId: 'w#M1' },
      ],
      userMnemonics: [{ type: '联想', text: '我的副本', meaningId: 'w#M1' }],
      hiddenMnemonicKeys: ['w#M1|谐音|另一条 AI'],
    }
    const visible = visibleMnemonics(word)
    expect(visible.map((item) => item.text)).toEqual(['AI 原文'])
    // 用户副本与 AI 同 key/同文本时原条目隐藏
    const overridden = visibleMnemonics({
      mnemonics: [{ type: '联想', text: '同文', meaningId: 'w#M1' }],
      userMnemonics: [{ type: '联想', text: '同文', meaningId: 'w#M1' }],
    })
    expect(overridden).toEqual([])
  })

  it('w-c 页：当前 c 用户笔记/助记只读展示，无编辑按钮', () => {
    const html = renderToStaticMarkup(
      createElement(MemoryStage, {
        headword: 'bank',
        meaningCn: '银行',
        count: 1,
        total: 3,
        phraseLines: [],
        showPhrases: false,
        fontScale: 1,
        cardSize: 1,
        onTap: noop,
        userNotes: [{ id: 'n1', text: 'w-c 用户笔记', meaningId: 'w#M1' }],
        userMnemonics: [{ id: 'm1', type: '联想', text: 'w-c 用户助记', meaningId: 'w#M1' }],
      }),
    )
    expect(html).toContain('w-c 用户笔记')
    expect(html).toContain('w-c 用户助记')
    expect(html).toContain('mine-badge')
    expect(html).not.toContain('编辑')
  })
})
