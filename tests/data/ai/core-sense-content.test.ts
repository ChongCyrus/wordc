/** 0.3.72 AI：本义例句/词组单条服务 */
import { describe, expect, it } from 'vitest'
import {
  generateCoreSenseExamples,
  generateCoreSensePhrases,
} from '../../../src/data/ai'
import type { AiConfig, ChatResponse, LlmProvider } from '../../../src/data/ai'
import {
  PROMPT_VERSION_CORE_SENSE_EXAMPLES,
  PROMPT_VERSION_CORE_SENSE_PHRASES,
} from '../../../src/data/ai/prompts'

const CFG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-fake',
  transport: 'auto',
  batchSize: 20,
  maxCostPerRun: 3,
  jsonMode: true,
}
const SOURCE = {
  word: 'alpha',
  label: '本义一',
  gloss: '说明',
  mappedMeanings: [{ meaningIndex: 2, cn: '阿尔法' }],
  representative: { meaningIndex: 2, cn: '阿尔法', examples: [{ en: 'old', cn: '旧' }] },
  count: 2,
}
const response = (json: unknown): ChatResponse => ({
  text: JSON.stringify(json),
  usage: { input: 10, output: 5, total: 15 },
})
function provider(handler: () => Promise<ChatResponse> | ChatResponse): LlmProvider {
  return { id: 'deepseek', async chat() { return handler() } } as LlmProvider
}

describe('0.3.72 · AI core sense examples/phrases', () => {
  it('examples：prompt 版本/条数/合法 JSON', async () => {
    const p = provider(() => response({ examples: [{ en: 'alpha example', cn: '例句' }] }))
    const result = await generateCoreSenseExamples({ ...SOURCE, count: 1 }, CFG, { provider: p })
    expect(result.promptVersion).toBe(PROMPT_VERSION_CORE_SENSE_EXAMPLES)
    expect(result.examples).toEqual([{ en: 'alpha example', cn: '例句' }])
    const bad = provider(() => response({ examples: [{ en: '', cn: 'x' }] }))
    await expect(generateCoreSenseExamples(SOURCE, CFG, { provider: bad })).rejects.toThrow(/en 不能为空/)
  })

  it('phrases：prompt 版本/合法 JSON/条数上限', async () => {
    const p = provider(() =>
      response({ phrases: [{ en: 'alpha phrase', cn: '词组' }, { en: 'extra', cn: '多余' }] }),
    )
    const result = await generateCoreSensePhrases({ ...SOURCE, count: 1 }, CFG, { provider: p })
    expect(result.promptVersion).toBe(PROMPT_VERSION_CORE_SENSE_PHRASES)
    expect(result.phrases).toEqual([{ en: 'alpha phrase', cn: '词组' }])
    const missing = provider(() => response({}))
    await expect(generateCoreSensePhrases(SOURCE, CFG, { provider: missing })).rejects.toThrow(/缺少 phrases/)
  })

  it('超时/成本预检', async () => {
    const hanging = provider(() => new Promise<ChatResponse>(() => undefined))
    await expect(
      generateCoreSenseExamples(SOURCE, CFG, { provider: hanging, timeoutMs: 100 }),
    ).rejects.toThrow(/超时/)
    const unlimited = provider(() => response({ examples: [{ en: 'a', cn: 'a' }] }))
    await expect(
      generateCoreSenseExamples(SOURCE, { ...CFG, maxCostPerRun: 0.00001 }, { provider: unlimited }),
    ).rejects.toThrow(/超过单次上限/)
  }, 10_000)
})
