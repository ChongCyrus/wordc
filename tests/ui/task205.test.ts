import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { withTimeout } from '../../src/ui/study/lib/with-timeout'
import { senseEditorInitialText } from '../../src/ui/study/components/SenseMnemonicPanel'
import { buildSenseMnemonicViews } from '../../src/ui/study/lib/sense-mnemonic-views'

const panel = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/SenseMnemonicPanel.tsx', import.meta.url)),
  'utf8',
)
const css = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/styles/study.css', import.meta.url)),
  'utf8',
)

const stored = [
  { coreSenseIndex: 1, label: '公开宣告', text: '助记1', source: 'ai' as const, updatedAt: 1 },
  { coreSenseIndex: 3, label: '旧本义', text: '旧助记', source: 'manual' as const, updatedAt: 2 },
]

describe('task-205 本义助记面板 P1', () => {
  it('withTimeout 超时 reject，正常 resolve', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50)).resolves.toBe('ok')
    await expect(withTimeout(new Promise(() => undefined), 20, '超时')).rejects.toThrow('超时')
  })

  it('AI 建议后点行打开编辑器：已保存优先，否则回填未应用建议', () => {
    expect(senseEditorInitialText('已保存', 'AI建议')).toBe('已保存')
    expect(senseEditorInitialText(undefined, 'AI建议')).toBe('AI建议')
    expect(senseEditorInitialText(undefined, undefined)).toBe('')
  })

  it('本地快速回填：label 优先、index 兜底、stale；不依赖 listSenseMnemonicViews', () => {
    const views = buildSenseMnemonicViews(
      [{ label: '公开宣告' }, { label: '行动举措' }],
      stored,
    )
    expect(views.current).toHaveLength(2)
    expect(views.current[0]!.mnemonic?.text).toBe('助记1')
    expect(views.current[0]!.match).toBe('label')
    expect(views.current[1]!.mnemonic).toBeUndefined()
    expect(views.stale).toHaveLength(1)
    expect(views.stale[0]!.text).toBe('旧助记')
  })

  it('加载不永久卡死：8s 超时+error/重试；coreSenses 用稳定 key 防 effect 重置', () => {
    expect(panel).toContain('withTimeout')
    expect(panel).toContain('8_000')
    expect(panel).toContain('读取本义助记超时')
    expect(panel).toContain('重试')
    expect(panel).toContain('listSenseMnemonics')
    expect(panel).toContain('buildSenseMnemonicViews')
    expect(panel).toContain('coreSensesKey')
    // 主路径本地回填；coreSenses 为空时回退 views API
    expect(panel).toContain('listSenseMnemonicViews(wordId)')
    expect(panel).toContain('result.current.length === 0')
  })

  it('头部操作 2 列/不竖排；覆盖独立行；进度+并发状态卡', () => {
    expect(panel).toContain('sense-panel-actions')
    expect(panel).toContain('sense-panel-overwrite')
    expect(panel).toContain('sense-panel-status')
    expect(panel).toContain('AI 生成全部')
    expect(panel).toContain('批量生成')
    expect(css).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')
    expect(css).toContain('min-height: 36px')
    expect(css).toContain('white-space: nowrap')
  })
})
