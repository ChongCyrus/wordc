import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const panel = readFileSync(
  fileURLToPath(new URL('../../src/ui/study/components/SenseMnemonicPanel.tsx', import.meta.url)),
  'utf8',
)

describe('task-223 建议态修复', () => {
  it('不再固定显示「AI 已生成建议」；未生成不出现建议行', () => {
    expect(panel).not.toContain('AI 已生成建议')
    expect(panel).not.toContain("next[p.coreSenseIndex!] === 'error'")
    expect(panel).toContain("suggestions[view.coreSenseIndex]?.trim()")
  })

  it('区分生成中/成功/失败：running/error 文案 + 空建议不显示', () => {
    expect(panel).toContain("genStatus[view.coreSenseIndex] === 'running'")
    expect(panel).toContain('生成中…')
    expect(panel).toContain("genStatus[view.coreSenseIndex] === 'error'")
    expect(panel).toContain('生成失败，可重试')
    // 最终只在 entry.mnemonic 非空时置 ok
    expect(panel).toContain('if (!entry.error && entry.mnemonic)')
    expect(panel).toContain('statuses[index] = \'ok\'')
  })
})
