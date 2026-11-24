import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { commitNumberDraft } from '../../src/ui/components/NumberDraftInput'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

describe('task-332 数字输入草稿/删空重输', () => {
  it('空串回退上次有效值；新数字提交并 clamp', () => {
    expect(commitNumberDraft('', 5, 1, 20)).toEqual({ value: 5, draft: '5' })
    expect(commitNumberDraft('12', 5, 1, 20)).toEqual({ value: 12, draft: '12' })
    expect(commitNumberDraft('99', 5, 1, 20)).toEqual({ value: 20, draft: '20' })
    expect(commitNumberDraft('0', 3, 1, 20)).toEqual({ value: 1, draft: '1' })
  })

  it('目标输入框均使用 NumberDraftInput', () => {
    for (const file of ['ui/decks/GeneratePage.tsx', 'ui/decks/AdvancedFilterPage.tsx', 'ui/me/AiSettingsSection.tsx']) {
      const code = src(file)
      expect(code).toContain('NumberDraftInput')
      expect(code).not.toMatch(/type="number"[\s\S]{0,200}onChange=\{\(event\) => set(BatchSize|Concurrency|Budget|TopN)/)
    }
    const input = src('ui/components/NumberDraftInput.tsx')
    expect(input).toContain('value={draft}')
    expect(input).toContain('onBlur={commit}')
  })
})
