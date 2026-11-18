/** 0.3.65 AI：本义助记单条/batch 控制面 */
import { describe, expect, it } from 'vitest'
import {
  PROMPT_VERSION_SENSE_MNEMONIC,
  buildSenseMnemonicSystemPrompt,
} from '../../../src/data/ai/prompts'
import {
  generateSenseMnemonic,
  generateSenseMnemonicBatch,
  validateSenseMnemonicDraft,
} from '../../../src/data/ai'
import type { AiConfig, ChatResponse, LlmProvider } from '../../../src/data/ai'

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
const SOURCE = (n: number) => ({
  word: `w${n}`,
  wordId: `deck:w${n}`,
  coreSenseIndex: 1,
  label: `本义${n}`,
  gloss: '说明',
  meanings: [{ index: 1, cn: '义一' }, { index: 2, cn: '义二' }],
})
const ok = (mnemonic = '拆分记忆'): ChatResponse => ({
  text: JSON.stringify({ mnemonic }),
  usage: { input: 10, output: 5, total: 15 },
})
function provider(handler: (call: number) => Promise<ChatResponse> | ChatResponse): LlmProvider & { calls: number } {
  let calls = 0
  return {
    id: 'deepseek',
    get calls() { return calls },
    async chat() { calls += 1; return handler(calls) },
  } as LlmProvider & { calls: number }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('0.3.65 · AI sense mnemonic', () => {
  it('单条：prompt 版本/输入 label/释义；合法 JSON；非法空；v1.1 去拉丁化', async () => {
    const systemPrompt = buildSenseMnemonicSystemPrompt()
    expect(systemPrompt).toContain('谐音')
    expect(systemPrompt).toContain('默认不要用拉丁')
    expect(systemPrompt).toContain('不要让学习者额外记外语词源')
    expect(systemPrompt).not.toContain('可含英文拆解。\n若词源不可靠')
    expect(PROMPT_VERSION_SENSE_MNEMONIC).toBe('v1.1-core-sense-mnemonic')
    const p = provider(() => ok('谐音：w 本义'))
    const result = await generateSenseMnemonic(SOURCE(1), CFG, { provider: p })
    expect(result.promptVersion).toBe(PROMPT_VERSION_SENSE_MNEMONIC)
    expect(result.mnemonic).toBe('谐音：w 本义')
    expect(() => validateSenseMnemonicDraft({})).toThrow(/缺少 mnemonic/)
    expect(() => validateSenseMnemonicDraft({ mnemonic: '  ' })).toThrow(/缺少 mnemonic/)
  })

  it('batch：并发/进度/失败隔离/超时重试/abort', async () => {
    let active = 0
    let maxActive = 0
    const p = provider(async (call) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(25)
      active -= 1
      if (call === 2) throw new Error('bad json')
      return ok(`助记${call}`)
    })
    const progress: number[] = []
    const result = await generateSenseMnemonicBatch(
      [SOURCE(1), SOURCE(2), SOURCE(3)],
      CFG,
      { provider: p, concurrency: 2, timeoutMs: 5_000, onProgress: (entry) => progress.push(entry.done) },
    )
    expect(maxActive).toBeLessThanOrEqual(2)
    expect([...new Set(progress.filter((done) => done > 0))]).toEqual([1, 2, 3])
    expect(result.results[1]!.error).toBeTruthy()
    expect(result.results[1]!.mnemonic).toBeUndefined() // 失败项不能产生“建议”文本
    expect(result.results[0]!.mnemonic).toBeTruthy()
    expect(result.canceled).toBe(false)

    // 超时自动重试一次
    const retryProvider = provider((call) => (call === 1 ? new Promise<ChatResponse>(() => undefined) : ok('重试成功')))
    const retried = await generateSenseMnemonicBatch([SOURCE(9)], CFG, {
      provider: retryProvider,
      concurrency: 1,
      timeoutMs: 150,
      retryTimeoutOnce: true,
    })
    expect(retried.retried).toBe(1)
    expect(retried.results[0]!.mnemonic).toBe('重试成功')

    // abort 立即收尾
    const slow = provider(async () => { await sleep(5_000); return ok() })
    const controller = new AbortController()
    const pending = generateSenseMnemonicBatch(
      [SOURCE(1), SOURCE(2), SOURCE(3)],
      CFG,
      { provider: slow, concurrency: 2, timeoutMs: 30_000, signal: controller.signal },
    )
    await sleep(20)
    controller.abort()
    const aborted = await pending
    expect(aborted.canceled).toBe(true)
    expect(aborted.results.every((entry) => entry.errorKind === 'canceled')).toBe(true)
    // UI 只能对真实 mnemonic 显示「AI 已生成建议」：取消项必须没有 mnemonic
    expect(aborted.results.every((entry) => entry.mnemonic === undefined)).toBe(true)
  }, 15_000)

  it('成本预检：预计超 maxCostPerRun 直接拒绝', async () => {
    const p = provider(() => ok())
    const tiny: AiConfig = { ...CFG, maxCostPerRun: 0.0001 }
    await expect(
      generateSenseMnemonicBatch(Array.from({ length: 40 }, (_, i) => SOURCE(i)), tiny, { provider: p }),
    ).rejects.toThrow(/超过单次上限/)
  })
})
