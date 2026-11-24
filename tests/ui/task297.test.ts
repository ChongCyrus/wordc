import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const page = readFileSync(
  fileURLToPath(new URL('../../src/ui/decks/GeneratePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-297 0.6.0 统一生成页类型/目标数', () => {
  it('全类型列表 + 目标数 + 最终目标', () => {
    for (const label of ['例句', '词组', '助记', '本义/引申链', '本义助记', '串联本义', '含义助记', '词根缀源', '引申图', '不常考']) {
      expect(page).toContain(label)
    }
    expect(page).toContain('buildGenerationTargets')
    expect(page).toContain("目标 {counts[item.label]")
    expect(page).toContain('最终目标')
    expect(page).toContain('buildGenerationTargets')
  })

  it('0.6.1 去掉下一步配置按钮，统一生成+副标题', () => {
    expect(page).not.toContain('下一步：生成配置')
    expect(page).toContain('统一生成')
    expect(page).toContain('任务可在「我的 → AI 生成任务」暂停 / 继续')
    expect(page).not.toContain('<AiGeneratePanel')
  })
})
