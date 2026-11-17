/** 0.3.62：generateRareMeaningsBatch 并发/逐条进度/超时重试/abort 收尾 */
import { describe, expect, it } from 'vitest'
import { generateRareMeaningsBatch } from '../../../src/data/ai/rare-meanings'
import type { AiConfig, ChatBody, ChatResponse, LlmProvider } from '../../../src/data/ai'

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
  meanings: [{ index: 1, cn: '义一' }, { index: 2, cn: '义二' }],
})
const response = (indexes: number[] = []): ChatResponse => ({
  text: JSON.stringify({ rareMeaningIndexes: indexes }),
  usage: { input: 10, output: 5, total: 15 },
})

function provider(handler: (call: number, body: ChatBody) => Promise<ChatResponse> | ChatResponse): LlmProvider & { calls: number } {
  let calls = 0
  return {
    id: 'deepseek',
    get calls() { return calls },
    async chat(body) { calls += 1; return handler(calls, body) },
  } as LlmProvider & { calls: number }
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('0.3.62 · rare batch 控制面', () => {
  it('并发 2 生效 + onProgress 逐词 done 1..N + results 顺序对应', async () => {
    let active = 0
    let maxActive = 0
    const p = provider(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await sleep(30)
      active -= 1
      return response([1])
    })
    const progress: number[] = []
    const sources = Array.from({ length: 6 }, (_, i) => SOURCE(i))
    const result = await generateRareMeaningsBatch(sources, CFG, {
      provider: p,
      concurrency: 2,
      timeoutMs: 5_000,
      onProgress: (entry) => progress.push(entry.done),
    })
    expect(maxActive).toBeLessThanOrEqual(2)
    expect(maxActive).toBeGreaterThanOrEqual(2)
    expect([...new Set(progress.filter((done) => done > 0))]).toEqual([1, 2, 3, 4, 5, 6])
    expect(result.results.map((entry) => entry.source.word)).toEqual(sources.map((source) => source.word))
    expect(result.canceled).toBe(false)
    expect(result.retried).toBe(0)
  })

  it('单条超时只失败该条，默认自动重试一次；其它词成功', async () => {
    const p = provider(async (call) => {
      // 第一次 call（timeout 词）永远不 resolve；重试时正常
      if (call === 1) return new Promise<ChatResponse>(() => undefined)
      return response([2])
    })
    const sources = [SOURCE(0), SOURCE(1)]
    const result = await generateRareMeaningsBatch(sources, CFG, {
      provider: p,
      concurrency: 1,
      timeoutMs: 200,
      retryTimeoutOnce: true,
    })
    expect(result.retried).toBe(1)
    expect(result.results[0]!.source.word).toBe('w0')
    expect(result.results[0]!.rareMeaningIndexes).toEqual([2]) // 重试成功
    expect(result.results[1]!.rareMeaningIndexes).toEqual([2])
    expect(result.results.every((entry) => !entry.error)).toBe(true)
  }, 10_000)

  it('外部 abort：立即收尾、done=total、未完成项标记 canceled，不再发起新请求', async () => {
    const p = provider(async () => {
      await sleep(5_000)
      return response()
    })
    const controller = new AbortController()
    const sources = Array.from({ length: 6 }, (_, i) => SOURCE(i))
    const started = Date.now()
    const pending = generateRareMeaningsBatch(sources, CFG, {
      provider: p,
      concurrency: 2,
      timeoutMs: 30_000,
      signal: controller.signal,
    })
    await sleep(30)
    controller.abort()
    const result = await pending
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(result.canceled).toBe(true)
    expect(result.results).toHaveLength(6)
    expect(result.results.every((entry) => entry.rareMeaningIndexes === undefined)).toBe(true)
    expect(result.results.filter((entry) => entry.errorKind === 'canceled').length).toBeGreaterThan(0)
  }, 10_000)

  it('开始前已 abort：不调用 provider，全部 canceled 且 done=total', async () => {
    const p = provider(() => response())
    const controller = new AbortController()
    controller.abort()
    let finalProgress: { done: number; total: number } | undefined
    const result = await generateRareMeaningsBatch([SOURCE(0), SOURCE(1)], CFG, {
      provider: p,
      signal: controller.signal,
      onProgress: (entry) => { finalProgress = { done: entry.done, total: entry.total } },
    })
    expect(p.calls).toBe(0)
    expect(result.canceled).toBe(true)
    expect(result.results.every((entry) => entry.errorKind === 'canceled')).toBe(true)
    expect(finalProgress).toEqual({ done: 2, total: 2 })
  })
})
