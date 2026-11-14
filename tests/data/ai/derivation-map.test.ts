import { describe, expect, it } from 'vitest'
import { generateDerivationMap, validateDerivationMapDraft } from '../../../src/data/ai/derivation-map'
import { PROMPT_VERSION_DERIVATION_MAP } from '../../../src/data/ai/prompts'
import type { AiConfig } from '../../../src/data/ai/types'
import type { LlmProvider } from '../../../src/data/ai/provider'

const CFG = {
  enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat',
  apiKey: 'test-key', keyStorage: 'session', maxCostPerRun: 3, pregenBudget: 40, jsonMode: true,
  timeoutMs: 60_000,
  transport: 'auto',
  batchSize: 1,
} as unknown as AiConfig

const SOURCE = {
  word: 'charge',
  coreSenses: [{ label: '装载', note: '把东西装到载体上' }],
  meanings: [
    { index: 1, cn: '收费', pos: 'v.' },
    { index: 2, cn: '充电', pos: 'v.' },
    { index: 3, cn: '指控', pos: 'n.' },
  ],
}

function providerReturning(text: string): LlmProvider & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    id: 'deepseek', calls,
    async chat(body: Parameters<LlmProvider['chat']>[0]) { calls.push(body); return { text, usage: { inputTokens: 10, outputTokens: 20 } } },
  } as unknown as LlmProvider & { calls: unknown[] }
}

describe('task-148/F8：AI 生成元→含义引申图', () => {
  it('prompt 版本 + 成功解析 rootLabel/mermaid/text；输入 c 全部进入 user prompt', async () => {
    expect(PROMPT_VERSION_DERIVATION_MAP).toBe('v1.0-derivation-map')
    const provider = providerReturning(JSON.stringify({
      rootLabel: '装载',
      mermaid: 'mindmap\n  root((装载))\n    收费\n    充电\n    指控',
      text: '装载 → 场景/对象/词性 → 收费/充电/指控',
    }))
    const result = await generateDerivationMap(SOURCE, CFG, { provider })
    expect(result.rootLabel).toBe('装载')
    expect(result.mermaid).toContain('mindmap')
    expect(result.text).toContain('收费')
    expect(result.promptVersion).toBe(PROMPT_VERSION_DERIVATION_MAP)
    const body = provider.calls[0] as { messages: Array<{ content: string }> }
    const user = body.messages[1]!.content
    expect(user).toContain('charge')
    expect(user).toContain('收费')
    expect(user).toContain('充电')
    expect(user).toContain('指控')
    expect(body.messages[0]!.content).toContain('生成元')
  })

  it('非法 JSON/缺 rootLabel/非法 mermaid 抛 AI_FORMAT', async () => {
    await expect(
      generateDerivationMap(SOURCE, CFG, { provider: providerReturning('not json') }),
    ).rejects.toMatchObject({ code: 'AI_FORMAT' })
    await expect(
      generateDerivationMap(SOURCE, CFG, { provider: providerReturning(JSON.stringify({ mermaid: 'mindmap' })) }),
    ).rejects.toMatchObject({ code: 'AI_FORMAT' })
    expect(() => validateDerivationMapDraft({ rootLabel: '装载', mermaid: 'graph TD' })).toThrow(/mindmap/)
    expect(validateDerivationMapDraft({ rootLabel: '装载', text: '装载→收费' }).rootLabel).toBe('装载')
  })
})
