import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { insertNewlineAt, shouldInsertNewline } from '../../src/ui/components/MultilineTextarea'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

describe('task-291 多行输入 Enter 换行', () => {
  it('插入换行并返回换行后光标', () => {
    expect(insertNewlineAt('ab', 1, 1)).toEqual({ value: 'a\nb', cursor: 2 })
    expect(insertNewlineAt('ab', 1, 2)).toEqual({ value: 'a\n', cursor: 2 })
    expect(insertNewlineAt('ab', null, null)).toEqual({ value: 'ab\n', cursor: 3 })
  })

  it('Enter 处理；Shift+Enter/中文 composing 不处理', () => {
    expect(shouldInsertNewline({ key: 'Enter' })).toBe(true)
    expect(shouldInsertNewline({ key: 'Enter', shiftKey: true })).toBe(false)
    expect(shouldInsertNewline({ key: 'Enter', isComposing: true })).toBe(false)
    expect(shouldInsertNewline({ key: 'Enter', keyCode: 229 })).toBe(false)
    expect(shouldInsertNewline({ key: 'a' })).toBe(false)
  })

  it('所有多行输入统一使用 MultilineTextarea', () => {
    for (const file of [
      'ui/study/components/UserContent.tsx',
      'ui/study/components/RootEtymologyEditDialog.tsx',
      'ui/study/components/SenseMnemonicPanel.tsx',
      'ui/study/components/SenseMnemonicEditDialog.tsx',
      'ui/study/components/CoreSenseOverviewEditDialog.tsx',
      'ui/study/components/RootMnemonicDialog.tsx',
      'ui/study/components/DerivationPanel.tsx',
      'ui/decks/DeckDetailPage.tsx',
    ]) {
      const code = src(file)
      expect(code).toContain('MultilineTextarea')
      expect(code).not.toContain('<textarea')
    }
    const helper = src('ui/components/MultilineTextarea.tsx')
    expect(helper).toContain('isComposing')
    expect(helper).toContain('setSelectionRange')
  })
})
