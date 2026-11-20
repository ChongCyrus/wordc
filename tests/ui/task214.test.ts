import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'
import { ToastProvider } from '../../src/app/toast'
import { SenseMnemonicPanel } from '../../src/ui/study/components/SenseMnemonicPanel'
import { SenseMnemonicBatchPanel } from '../../src/ui/study/components/SenseMnemonicBatchPanel'

const noop = () => undefined
const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const panel = src('ui/study/components/SenseMnemonicPanel.tsx')
const batch = src('ui/study/components/SenseMnemonicBatchPanel.tsx')

describe('task-214 本义助记排除不常考本义', () => {
  it('面板：默认勾选、includeRare 取反、空态提示、单条重新生成不受过滤', () => {
    expect(panel).toContain('excludeRareCoreSenses')
    expect(panel).toContain('useState(true)')
    expect(panel).toContain('includeRare: !excludeRareCoreSenses')
    expect(panel).toContain('请至少勾选一个生成目标（串联或本义）')
    expect(panel).toContain('重新生成')
    expect(panel).toContain('generateSenseMnemonic(')
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(SenseMnemonicPanel, {
          open: true,
          wordId: 'deck:denounce',
          word: 'denounce',
          onClose: noop,
        }),
      ),
    )
    expect(html).toContain('排除已标记不常考的本义')
  })

  it('批量：默认勾选、includeRare 取反、无候选提示、汇总说明', () => {
    expect(batch).toContain('excludeRareCoreSenses')
    expect(batch).toContain('includeRare: !excludeRareCoreSenses')
    expect(batch).toContain('已排除不常考本义后无候选')
    expect(batch).toContain('（已排除不常考本义）')
    const html = renderToStaticMarkup(
      createElement(
        ToastProvider,
        null,
        createElement(SenseMnemonicBatchPanel, {
          open: true,
          currentWordId: 'deck:denounce',
          onClose: noop,
        }),
      ),
    )
    expect(html).toContain('排除已标记不常考的本义')
  })
})
