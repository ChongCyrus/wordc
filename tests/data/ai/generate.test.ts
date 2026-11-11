import { describe, expect, it } from 'vitest'
import {
  AiRequestError,
  CONTENT_LIMITS,
  estimateCost,
  extractJsonObject,
  stripCodeFence,
  generateItems,
  validateGeneratedItems,
} from '../../../src/data/ai'
import type {
  AiConfig,
  ChatBody,
  ChatResponse,
  GenerateTarget,
  LlmProvider,
  TokenUsage,
} from '../../../src/data/ai'

const KEY = 'sk-fake-key-leak-123'
const CFG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: KEY,
  transport: 'proxy',
  batchSize: 2,
  maxCostPerRun: 3,
  proxyUrl: 'http://127.0.0.1:8788',
}

const USAGE: TokenUsage = { input: 100, output: 50, total: 150 }

function target(n: number, meaningIndex?: number): GenerateTarget {
  const headword = `word${n}`
  return {
    wordId: `deck:${headword}`,
    headword,
    headwordLower: headword,
    ...(meaningIndex != null ? { meaningIndex } : {}),
    meanings: [
      { id: `deck:${headword}#M1`, pos: 'n.', cn: '含义一' },
      { id: `deck:${headword}#M2`, pos: 'v.', cn: '含义二' },
    ],
    existing: { examples: 0, phrases: 0, mnemonics: 0 },
  }
}

function payloadFor(targets: GenerateTarget[], kind: 'examples' | 'phrases' | 'mnemonics'): string {
  const items = targets.map((t) => {
    if (kind === 'examples') {
      return {
        headword: t.headword,
        ...(t.meaningIndex != null ? { meaningIndex: t.meaningIndex } : {}),
        examples: [
          { en: `${t.headword} example one.`, cn: '例句一' },
          { en: `${t.headword} example two.`, cn: '例句二' },
          { en: `${t.headword} example one.`, cn: '重复' },
        ],
      }
    }
    if (kind === 'phrases') {
      return {
        headword: t.headword,
        meaningIndex: t.meaningIndex ?? 1,
        phrases: [
          { en: `${t.headword} up`, cn: '短语一' },
          { en: `${t.headword} up`, cn: '重复' },
          { en: `${t.headword} down`, cn: '短语二' },
          { en: `${t.headword} over`, cn: '短语三' },
        ],
      }
    }
    return {
      headword: t.headword,
      mnemonics: [{ type: 'root', text: `${t.headword} 的词根助记` }],
    }
  })
  return JSON.stringify({ items })
}

interface FakeProvider extends LlmProvider {
  calls: Array<{ body: ChatBody; cfg: AiConfig }>
}

function fakeProvider(
  handler: (call: number, body: ChatBody) => ChatResponse | Promise<ChatResponse>,
): FakeProvider {
  const calls: Array<{ body: ChatBody; cfg: AiConfig }> = []
  return {
    id: 'deepseek',
    calls,
    async chat(body, cfg) {
      calls.push({ body, cfg })
      return handler(calls.length, body)
    },
  }
}

function ok(text: string): ChatResponse {
  return { text, usage: USAGE }
}

const noSleep = async () => undefined

describe('ai/generate · 正常生成与校验', () => {
  it('成功：按 target 返回条目，去重/截断到 limit，成本按 usage 估算', async () => {
    const targets = [target(1), target(2)]
    const provider = fakeProvider(() => ok(payloadFor(targets, 'examples')))
    const res = await generateItems(
      { kind: 'examples', targets, config: CFG },
      { provider, sleep: noSleep },
    )
    expect(res.results).toHaveLength(2)
    expect(res.canceled).toBe(false)
    for (const r of res.results) {
      expect(r.error).toBeUndefined()
      expect(r.item?.examples).toHaveLength(CONTENT_LIMITS.examples)
      expect(r.item?.examples?.[0]?.cn).toBe('例句一')
    }
    expect(res.usage).toEqual(USAGE)
    expect(res.costYuan).toBeCloseTo(estimateCost(res.usage, 'deepseek-chat'), 6)
  })

  it('过滤：输入外的 headword/越界 meaningIndex 丢弃；未知 target → AI_EMPTY', async () => {
    const targets = [target(1, 2), target(2)]
    const provider = fakeProvider(() =>
      ok(
        JSON.stringify({
          items: [
            { headword: 'unknown-word', examples: [{ en: 'x', cn: 'x' }] },
            { headword: 'word1', meaningIndex: 99, examples: [{ en: 'bad', cn: 'bad' }] },
            { headword: 'word1', meaningIndex: 2, examples: [{ en: 'valid one', cn: '有效' }] },
            // word2 未返回
          ],
        }),
      ),
    )
    const res = await generateItems({ kind: 'examples', targets, config: CFG }, { provider, sleep: noSleep })
    expect(res.results[0]!.item?.examples?.map((e) => e.en)).toEqual(['valid one'])
    expect(res.results[1]!.error?.code).toBe('AI_EMPTY')
  })

  it('词组：meaningIndex 越界的短语丢弃，保留目标含义的短语', async () => {
    const targets = [target(1, 1)]
    const provider = fakeProvider(() =>
      ok(
        JSON.stringify({
          items: [
            {
              headword: 'word1',
              meaningIndex: 1,
              phrases: [
                { en: 'good phrase', cn: '好', meaningIndex: 1 },
                { en: 'out of range', cn: '越界', meaningIndex: 9 },
              ],
            },
          ],
        }),
      ),
    )
    const res = await generateItems({ kind: 'phrases', targets, config: CFG }, { provider, sleep: noSleep })
    expect(res.results[0]!.item?.phrases?.map((p) => p.en)).toEqual(['good phrase'])
  })

  it('batchSize 超上限按 50 切分（51 个 target → 2 次调用）', async () => {
    const targets = Array.from({ length: 51 }, (_, i) => target(i + 1))
    const provider = fakeProvider((_n, body) => {
      const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
      const parsed = JSON.parse(user.split('targets = ')[1]!.split('\n请')[0]!) as Array<{
        headword: string
        meaningIndex?: number
      }>
      const batchTargets = parsed.map((p) => {
        const base = targets.find((t) => t.headwordLower === p.headword)!
        return { ...base, ...(p.meaningIndex != null ? { meaningIndex: p.meaningIndex } : {}) }
      })
      return ok(payloadFor(batchTargets, 'examples'))
    })
    const res = await generateItems(
      { kind: 'examples', targets, config: { ...CFG, batchSize: 999 } },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(2)
    expect(res.results.filter((r) => !r.error)).toHaveLength(51)
  })
})

describe('ai/generate · JSON 修复重试', () => {
  it('第一次坏 JSON → 修复重试成功（调用 2 次，第二次 prompt 带修复说明）', async () => {
    const targets = [target(1)]
    const provider = fakeProvider((n) =>
      n === 1 ? ok('这不是 JSON') : ok(payloadFor(targets, 'examples')),
    )
    const res = await generateItems({ kind: 'examples', targets, config: CFG }, { provider, sleep: noSleep })
    expect(provider.calls).toHaveLength(2)
    expect(res.results[0]!.error).toBeUndefined()
    const repairMsg = provider.calls[1]!.body.messages.find((m) => m.role === 'user')!.content
    expect(repairMsg).toContain('不是合法 JSON')
  })

  it('持续坏 JSON → 修复 2 次后放弃（共 3 次调用），结果 AI_FORMAT 且 raw 已脱敏', async () => {
    const targets = [target(1)]
    const provider = fakeProvider(() => ok(`bad output ${KEY}`))
    const res = await generateItems({ kind: 'examples', targets, config: CFG }, { provider, sleep: noSleep })
    expect(provider.calls).toHaveLength(3)
    expect(res.results[0]!.error?.code).toBe('AI_FORMAT')
    expect(JSON.stringify(res)).not.toContain(KEY)
    expect(res.results[0]!.raw).not.toContain(KEY)
  })

  it('schema 不符（items 非数组/类型错）也走修复重试', async () => {
    const targets = [target(1)]
    const provider = fakeProvider((n) =>
      n === 1 ? ok('{"items":[{"headword":123}]}') : ok(payloadFor(targets, 'examples')),
    )
    const res = await generateItems({ kind: 'examples', targets, config: CFG }, { provider, sleep: noSleep })
    expect(provider.calls).toHaveLength(2)
    expect(res.results[0]!.error).toBeUndefined()
  })
})

describe('ai/generate · 重试/错误分类', () => {
  it('429 指数退避：两次限流后成功，退避 1s→2s', async () => {
    const targets = [target(1)]
    const delays: number[] = []
    const provider = fakeProvider((n) => {
      if (n <= 2) throw new AiRequestError('AI_RATE_LIMIT', 'rate limited', { status: 429, retryable: true })
      return ok(payloadFor(targets, 'examples'))
    })
    const res = await generateItems(
      { kind: 'examples', targets, config: CFG },
      {
        provider,
        sleep: async (ms) => {
          delays.push(ms)
        },
      },
    )
    expect(provider.calls).toHaveLength(3)
    expect(delays).toEqual([1000, 2000])
    expect(res.results[0]!.error).toBeUndefined()
  })

  it('429 超过 3 次重试 → AI_RATE_LIMIT', async () => {
    const targets = [target(1)]
    const provider = fakeProvider(() => {
      throw new AiRequestError('AI_RATE_LIMIT', 'rate limited', { status: 429, retryable: true })
    })
    const res = await generateItems(
      { kind: 'examples', targets, config: CFG },
      { provider, sleep: async () => undefined },
    )
    expect(provider.calls).toHaveLength(4) // 1 + 3 次重试
    expect(res.results[0]!.error?.code).toBe('AI_RATE_LIMIT')
  })

  it('5xx/网络错误重试 2 次后成功；401 不重试', async () => {
    const targets = [target(1)]
    {
      const provider = fakeProvider((n) => {
        if (n <= 2) throw new AiRequestError('AI_NETWORK', 'boom', { retryable: true })
        return ok(payloadFor(targets, 'examples'))
      })
      const res = await generateItems(
        { kind: 'examples', targets, config: CFG },
        { provider, sleep: async () => undefined },
      )
      expect(provider.calls).toHaveLength(3)
      expect(res.results[0]!.error).toBeUndefined()
    }
    {
      const provider = fakeProvider(() => {
        throw new AiRequestError('AI_AUTH', 'auth failed', { status: 401 })
      })
      const res = await generateItems(
        { kind: 'examples', targets, config: CFG },
        { provider, sleep: async () => undefined },
      )
      expect(provider.calls).toHaveLength(1)
      expect(res.results[0]!.error?.code).toBe('AI_AUTH')
    }
  })

  it('无 key → 所有目标 AI_NO_KEY，不调用 provider', async () => {
    const targets = [target(1), target(2)]
    const provider = fakeProvider(() => ok('{}'))
    const res = await generateItems(
      { kind: 'examples', targets, config: { ...CFG, apiKey: '' } },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(0)
    expect(res.results.every((r) => r.error?.code === 'AI_NO_KEY')).toBe(true)
  })
})

describe('ai/generate · 取消 / 成本上限 / 并发', () => {
  it('预取消（signal 已 abort）→ canceled=true、不调用 provider', async () => {
    const controller = new AbortController()
    controller.abort()
    const provider = fakeProvider(() => ok('{}'))
    const targets = [target(1)]
    const res = await generateItems(
      { kind: 'examples', targets, config: CFG, signal: controller.signal },
      { provider, sleep: noSleep },
    )
    expect(res.canceled).toBe(true)
    expect(provider.calls).toHaveLength(0)
    expect(res.results[0]!.error?.code).toBe('AI_CANCELED')
  })

  it('成本上限：预检超预算 → AI_COST_LIMIT 且不调用 provider', async () => {
    const targets = [target(1), target(2), target(3)]
    const provider = fakeProvider(() => ok('{}'))
    const res = await generateItems(
      { kind: 'examples', targets, config: { ...CFG, maxCostPerRun: 0.00001 } },
      { provider, sleep: noSleep },
    )
    expect(provider.calls).toHaveLength(0)
    expect(res.results.every((r) => r.error?.code === 'AI_COST_LIMIT')).toBe(true)
  })

  it('并发上限 3：6 个批次同时进行时 active 峰值 ≤3', async () => {
    const targets = Array.from({ length: 6 }, (_, i) => target(i + 1))
    let active = 0
    let maxActive = 0
    const provider = fakeProvider(async (_n, body) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      active -= 1
      const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
      const count = (JSON.parse(user.split('targets = ')[1]!.split('\n请')[0]!) as unknown[]).length
      const batch = targets.slice(0, count)
      return ok(payloadFor(batch, 'examples'))
    })
    await generateItems(
      { kind: 'examples', targets, config: { ...CFG, batchSize: 1 }, onProgress: () => undefined },
      { provider, sleep: noSleep, maxConcurrency: 3 },
    )
    expect(maxActive).toBeLessThanOrEqual(3)
    expect(provider.calls).toHaveLength(6)
  })

  it('进度回调：done 递增、total 正确、costYuan 非负', async () => {
    const targets = [target(1), target(2), target(3)]
    const progress: Array<{ done: number; total: number; costYuan: number }> = []
    const provider = fakeProvider((_n, body) => {
      const user = body.messages.find((m) => m.role === 'user')?.content ?? ''
      const count = (JSON.parse(user.split('targets = ')[1]!.split('\n请')[0]!) as unknown[]).length
      return ok(payloadFor(targets.slice(0, count), 'examples'))
    })
    await generateItems(
      { kind: 'examples', targets, config: { ...CFG, batchSize: 1 }, onProgress: (p) => progress.push(p) },
      { provider, sleep: noSleep },
    )
    expect(progress.map((p) => p.done)).toEqual([1, 2, 3])
    expect(progress.every((p) => p.total === 3 && p.costYuan >= 0)).toBe(true)
  })
})

describe('ai/generate · 校验/工具纯函数', () => {
  it('stripCodeFence/extractJsonObject 兼容 ```json 围栏与前后解释', () => {
    expect(stripCodeFence('```json\n{"items":[]}\n```')).toBe('{"items":[]}')
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}')
    expect(stripCodeFence('```json\n{"a":1}')).toBe('{"a":1}') // 只有开头围栏
    expect(stripCodeFence('{"a":1}\n```')).toBe('{"a":1}') // 只有结尾围栏
    expect(extractJsonObject('```json\n{"items":[]}\n```').json).toEqual({ items: [] })
    expect(extractJsonObject('前言 {"items":[]} 后记').json).toEqual({ items: [] })
    expect(extractJsonObject('nope').error).toBeTruthy()
  })

  it('jsonMode=false（免费模型）：围栏包裹的响应仍能解析成功', async () => {
    const targets = [target(1)]
    const payload = payloadFor(targets, 'examples')
    const provider = fakeProvider(() => ok('```json\n' + payload + '\n```'))
    const res = await generateItems(
      { kind: 'examples', targets, config: { ...CFG, jsonMode: false } },
      { provider, sleep: noSleep },
    )
    expect(res.results[0]!.error).toBeUndefined()
    expect(res.results[0]!.item?.examples).toHaveLength(CONTENT_LIMITS.examples)
  })

  it('validateGeneratedItems 按 kind 过滤、去重、截断', () => {
    const targets = [target(1)]
    const { byKey, error } = validateGeneratedItems({
      json: JSON.parse(payloadFor(targets, 'examples')),
      kind: 'examples',
      targets,
    })
    expect(error).toBeUndefined()
    const item = byKey.get('word1')
    expect(item?.examples).toHaveLength(CONTENT_LIMITS.examples)
  })
})
