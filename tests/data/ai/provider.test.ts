import { describe, expect, it } from 'vitest'
import {
  AiRequestError,
  buildChatUrl,
  classifyHttpStatus,
  createLlmProvider,
  parseChatResponse,
  sanitizeSnippet,
} from '../../../src/data/ai'
import type { AiConfig, AiHttpClient } from '../../../src/data/ai'

const KEY = 'test-key-1234567890abcdef'
const CFG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: KEY,
  transport: 'proxy',
  batchSize: 20,
  maxCostPerRun: 3,
  proxyUrl: 'http://127.0.0.1:8788',
}

function httpWith(response: { status: number; text: string }): { client: AiHttpClient; seen: unknown[] } {
  const seen: unknown[] = []
  return {
    seen,
    client: {
      async send(req) {
        seen.push(req)
        return response
      },
    },
  }
}

const okBody = JSON.stringify({
  choices: [{ message: { content: '{"items":[]}' } }],
  usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
})

describe('ai/provider · OpenAI 兼容 provider（mock http，无真实网络）', () => {
  it('成功：返回文本 + usage；请求带 Authorization/response_format/模型', async () => {
    const { client, seen } = httpWith({ status: 200, text: okBody })
    const provider = createLlmProvider({ http: client })
    const res = await provider.chat(
      { messages: [{ role: 'user', content: 'hi' }] },
      CFG,
      new AbortController().signal,
    )
    expect(res.text).toBe('{"items":[]}')
    expect(res.usage).toEqual({ input: 120, output: 30, total: 150 })
    const req = seen[0] as {
      url: string
      headers: Record<string, string>
      body: string
    }
    expect(req.url).toBe('https://api.deepseek.com/v1/chat/completions')
    expect(req.headers.Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(req.body) as { model: string; response_format: { type: string } }
    expect(body.model).toBe('deepseek-chat')
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('错误分类：401→AI_AUTH、402→AI_QUOTA、429→AI_RATE_LIMIT、500→AI_NETWORK(可重试)', async () => {
    const cases: Array<[number, string, boolean]> = [
      [401, 'AI_AUTH', false],
      [402, 'AI_QUOTA', false],
      [429, 'AI_RATE_LIMIT', true],
      [500, 'AI_NETWORK', true],
    ]
    for (const [status, code, retryable] of cases) {
      const { client } = httpWith({ status, text: '{"error":"x"}' })
      const provider = createLlmProvider({ http: client })
      await expect(
        provider.chat({ messages: [] }, CFG, new AbortController().signal),
      ).rejects.toMatchObject({ code, retryable })
    }
  })

  it('**key 不出现在错误信息里**（即使 upstream 错误体回显）', async () => {
    const { client } = httpWith({ status: 401, text: `{"error":"invalid key ${KEY}"}` })
    const provider = createLlmProvider({ http: client })
    try {
      await provider.chat({ messages: [] }, CFG, new AbortController().signal)
      throw new Error('should throw')
    } catch (error) {
      const err = error as AiRequestError
      expect(err.message).not.toContain(KEY)
      expect(JSON.stringify(err)).not.toContain(KEY)
      expect(err.message).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/)
    }
  })

  it('空 content → AI_BAD_RESPONSE；非 JSON → AI_BAD_RESPONSE', async () => {
    {
      const { client } = httpWith({ status: 200, text: JSON.stringify({ choices: [{ message: { content: '' } }] }) })
      const provider = createLlmProvider({ http: client })
      await expect(provider.chat({ messages: [] }, CFG, new AbortController().signal)).rejects.toMatchObject({
        code: 'AI_BAD_RESPONSE',
      })
    }
    {
      const { client } = httpWith({ status: 200, text: 'not-json' })
      const provider = createLlmProvider({ http: client })
      await expect(provider.chat({ messages: [] }, CFG, new AbortController().signal)).rejects.toMatchObject({
        code: 'AI_BAD_RESPONSE',
      })
    }
  })

  it('无 key → AI_NO_KEY（不发起请求）', async () => {
    const { client, seen } = httpWith({ status: 200, text: okBody })
    const provider = createLlmProvider({ http: client })
    await expect(
      provider.chat({ messages: [] }, { ...CFG, apiKey: '' }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'AI_NO_KEY' })
    expect(seen).toHaveLength(0)
  })
})

describe('ai/provider · 工具函数', () => {
  it('buildChatUrl 兼容任意版本路径（6 种端点 + 重复斜杠）', () => {
    // deepseek 默认（无版本段 → /v1）
    expect(buildChatUrl(CFG)).toBe('https://api.deepseek.com/v1/chat/completions')
    // 硅基流动：/v1 结尾
    expect(buildChatUrl({ ...CFG, baseUrl: 'https://api.siliconflow.cn/v1' })).toBe(
      'https://api.siliconflow.cn/v1/chat/completions',
    )
    // 智谱：/api/paas/v4 结尾（任意版本段）
    expect(buildChatUrl({ ...CFG, baseUrl: 'https://open.bigmodel.cn/api/paas/v4' })).toBe(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
    )
    // 火山 ark：/api/v3
    expect(buildChatUrl({ ...CFG, baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' })).toBe(
      'https://ark.cn-beijing.volces.com/api/v3/chat/completions',
    )
    // 千帆：/v2
    expect(buildChatUrl({ ...CFG, baseUrl: 'https://qianfan.baidubce.com/v2' })).toBe(
      'https://qianfan.baidubce.com/v2/chat/completions',
    )
    // 完整 endpoint 原样（含尾部斜杠/重复斜杠）
    expect(buildChatUrl({ ...CFG, baseUrl: 'https://x.test/v1/chat/completions/' })).toBe(
      'https://x.test/v1/chat/completions',
    )
    expect(buildChatUrl({ ...CFG, baseUrl: 'https://api.deepseek.com//v1//' })).toBe(
      'https://api.deepseek.com/v1/chat/completions',
    )
  })

  it('jsonMode：默认带 response_format；cfg.jsonMode=false 不带；body 显式覆盖', async () => {
    const readBody = (seen: unknown[]) => JSON.parse((seen[0] as { body: string }).body) as {
      response_format?: { type: string }
    }
    {
      const { client, seen } = httpWith({ status: 200, text: okBody })
      await createLlmProvider({ http: client }).chat({ messages: [] }, CFG, new AbortController().signal)
      expect(readBody(seen).response_format).toEqual({ type: 'json_object' })
    }
    {
      const { client, seen } = httpWith({ status: 200, text: okBody })
      await createLlmProvider({ http: client }).chat(
        { messages: [] },
        { ...CFG, jsonMode: false },
        new AbortController().signal,
      )
      expect(readBody(seen).response_format).toBeUndefined()
    }
    {
      // body 显式 jsonMode=true 可覆盖 cfg=false（测试/特殊调用用）
      const { client, seen } = httpWith({ status: 200, text: okBody })
      await createLlmProvider({ http: client }).chat(
        { messages: [], jsonMode: true },
        { ...CFG, jsonMode: false },
        new AbortController().signal,
      )
      expect(readBody(seen).response_format).toEqual({ type: 'json_object' })
    }
  })

  it('classifyHttpStatus 边界', () => {
    expect(classifyHttpStatus(403).code).toBe('AI_AUTH')
    expect(classifyHttpStatus(408).code).toBe('AI_TIMEOUT')
    expect(classifyHttpStatus(404).code).toBe('AI_BAD_RESPONSE')
    expect(classifyHttpStatus(503).retryable).toBe(true)
  })

  it('parseChatResponse 无 usage 时用文本长度保守估算', () => {
    const res = parseChatResponse({ choices: [{ message: { content: '{"items":[]}' } }] })
    expect(res.usage.total).toBeGreaterThan(0)
  })

  it('sanitizeSnippet 移除 key 与 sk- 片段', () => {
    const text = `err ${KEY} and sk-abcdefghijkl`
    const out = sanitizeSnippet(text, KEY)
    expect(out).not.toContain(KEY)
    expect(out).not.toMatch(/sk-[A-Za-z0-9_-]{6,}/)
  })
})
