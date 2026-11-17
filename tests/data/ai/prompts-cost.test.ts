import { describe, expect, it } from 'vitest'
import {
  CONTENT_LIMITS,
  PROMPT_VERSION,
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  estimateBatchCost,
  estimateBatchTokens,
  estimateCost,
  estimateTextTokens,
  formatCostYuan,
} from '../../../src/data/ai'
import type { GenerateTarget } from '../../../src/data/ai'

const TARGETS: GenerateTarget[] = [
  {
    wordId: 'deck:embrace',
    headword: 'embrace',
    headwordLower: 'embrace',
    meanings: [
      { id: 'deck:embrace#M1', pos: 'n.', cn: '拥抱' },
      { id: 'deck:embrace#M2', pos: 'vt.', cn: '包含' },
    ],
    existing: { examples: 1, phrases: 0, mnemonics: 0 },
  },
  {
    wordId: 'deck:dog',
    headword: 'dog',
    headwordLower: 'dog',
    meaningIndex: 1,
    meanings: [{ id: 'deck:dog#M1', pos: 'n.', cn: '狗' }],
    existing: { examples: 0, phrases: 2, mnemonics: 0 },
  },
]

describe('ai/prompts · prompt 契约 v1（CLI 与 App 共用）', () => {
  it('system prompt 含版本、严格 JSON 要求、schema、每类条数约束', () => {
    const system = buildSystemPrompt()
    expect(PROMPT_VERSION).toBe('v1')
    expect(system).toContain(PROMPT_VERSION)
    expect(system).toContain('只输出严格 JSON')
    expect(system).toContain('"items"')
    expect(system).toContain('root|assoc|story')
    expect(system).toContain('≤60 字中文')
    expect(system).not.toMatch(/api[_-]?key/i)
  })

  it('user prompt：kind/limit/targets JSON（含 meaningIndex 与 existing）', () => {
    const user = buildUserPrompt({ kind: 'phrases', targets: TARGETS })
    expect(user).toContain('kind = phrases')
    expect(user).toContain(`limit = ${CONTENT_LIMITS.phrases}`)
    expect(user).toContain('embrace')
    expect(user).toContain('meaningIndex')
    expect(user).toContain('"existing"')
    // targets 必须是可 JSON.parse 的数组（CLI/模型都依赖）
    const jsonPart = user.split('targets = ')[1]!.split('\n请')[0]!
    const parsed = JSON.parse(jsonPart) as Array<{ headword: string; meaningIndex?: number }>
    expect(parsed).toHaveLength(2)
    expect(parsed[0]!.headword).toBe('embrace')
    expect(parsed[1]!.meaningIndex).toBe(1)
  })

  it('repair prompt 带原始 prompt + 错误摘要 + 只输出 JSON 的指令', () => {
    const repair = buildRepairPrompt('targets = []', 'items.0.headword: Required')
    expect(repair).toContain('targets = []')
    expect(repair).toContain('items.0.headword')
    expect(repair).toContain('不是合法 JSON')
  })
})

describe('ai/cost · 成本估算', () => {
  it('deepseek-chat：输入 ¥2/M、输出 ¥8/M（100 万 token = ¥10）', () => {
    expect(estimateCost({ input: 1_000_000, output: 0, total: 1_000_000 }, 'deepseek-chat')).toBe(2)
    expect(estimateCost({ input: 0, output: 1_000_000, total: 1_000_000 }, 'deepseek-chat')).toBe(8)
    expect(estimateCost({ input: 1_000_000, output: 1_000_000, total: 2_000_000 }, 'deepseek-chat')).toBe(10)
  })

  it('reasoner 更贵；未知模型回退默认价', () => {
    const tokens = { input: 1_000_000, output: 0, total: 1_000_000 }
    expect(estimateCost(tokens, 'deepseek-reasoner')).toBeGreaterThan(estimateCost(tokens, 'deepseek-chat'))
    expect(estimateCost(tokens, 'some-model')).toBe(2)
  })

  it('batch 预估随目标数/条数单调增长；formatCostYuan 格式化', () => {
    const one = estimateBatchCost({ kind: 'examples', targets: 1, model: 'deepseek-chat' })
    const many = estimateBatchCost({ kind: 'examples', targets: 20, model: 'deepseek-chat' })
    expect(one).toBeGreaterThan(0)
    expect(many).toBeGreaterThan(one)
    expect(estimateTextTokens('abcd')).toBeGreaterThan(0)
    expect(formatCostYuan(0.0006)).toBe('¥0.0006')
    expect(formatCostYuan(1.234)).toBe('¥1.23')
    expect(formatCostYuan(Number.NaN)).toBe('¥0.00')
  })

  it('estimateBatchTokens 输入/输出均为正数', () => {
    const t = estimateBatchTokens({ kind: 'phrases', targets: 10 })
    expect(t.input).toBeGreaterThan(0)
    expect(t.output).toBeGreaterThan(0)
    expect(t.total).toBe(t.input + t.output)
  })
})
