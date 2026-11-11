import { afterEach, describe, expect, it } from 'vitest'
import {
  AiNetworkError,
  AiTimeoutError,
  createFetchHttpClient,
  createNativeHttpClient,
  createProxyHttpClient,
  isNativeAiAvailable,
  resolveTransport,
} from '../../../src/data/ai'
import type { AiConfig } from '../../../src/data/ai'

const CFG: AiConfig = {
  provider: 'deepseek',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  apiKey: 'sk-test',
  transport: 'auto',
  batchSize: 20,
  maxCostPerRun: 3,
}

const REQ = {
  url: 'https://api.deepseek.com/v1/chat/completions',
  method: 'POST' as const,
  headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test' },
  body: '{"a":1}',
  timeoutMs: 1000,
}

afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window
})

describe('ai/transport · 浏览器代理', () => {
  it('把 provider URL 的 path 转发到本地代理地址（不直连上游）', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('{"ok":1}', { status: 200 })
    }) as unknown as typeof fetch
    const client = createProxyHttpClient({ proxyUrl: 'http://127.0.0.1:8788/', fetchImpl })
    const res = await client.send(REQ)
    expect(res.status).toBe(200)
    expect(calls[0]!.url).toBe('http://127.0.0.1:8788/v1/chat/completions')
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test')
  })

  it('fetch client：非 2xx 原样返回；网络异常 → AiNetworkError', async () => {
    const okFetch = (async () => new Response('x', { status: 401 })) as unknown as typeof fetch
    expect((await createFetchHttpClient(okFetch).send(REQ)).status).toBe(401)
    const badFetch = (async () => {
      throw new TypeError('network down')
    }) as unknown as typeof fetch
    await expect(createFetchHttpClient(badFetch).send(REQ)).rejects.toBeInstanceOf(AiNetworkError)
  })
})

describe('ai/transport · APK 原生桥', () => {
  it('无桥时 isNativeAiAvailable=false；auto 回退 proxy', () => {
    expect(isNativeAiAvailable()).toBe(false)
    expect(resolveTransport({ ...CFG, transport: 'auto' })).toBe('proxy')
    expect(resolveTransport({ ...CFG, transport: 'native' })).toBe('native')
  })

  it('注入 window.AiApi：request 参数正确、回调转 Response', async () => {
    const seen: Array<{ id: string; method: string; url: string; headers: string; body: string }> = []
    const win = {
      AiApi: {
        isNativeApp: () => 'momo-apk',
        request: (id: string, method: string, url: string, headers: string, body: string) => {
          seen.push({ id, method, url, headers, body })
          // 模拟原生异步回调（result 字符串与对象都要兼容）
          setTimeout(() => {
            ;(globalThis as unknown as { window: { __aiApiCallback?: (id: string, r: unknown) => void } }).window.__aiApiCallback?.(
              id,
              { ok: true, status: 200, body: '{"items":[]}' },
            )
          }, 0)
        },
      },
    }
    ;(globalThis as unknown as { window: unknown }).window = win
    expect(isNativeAiAvailable()).toBe(true)
    expect(resolveTransport({ ...CFG, transport: 'auto' })).toBe('native')
    const res = await createNativeHttpClient(500).send(REQ)
    expect(res).toEqual({ status: 200, text: '{"items":[]}' })
    expect(seen[0]!.method).toBe('POST')
    expect(seen[0]!.url).toBe(REQ.url)
    expect(JSON.parse(seen[0]!.headers).Authorization).toBe('Bearer sk-test')
    expect(seen[0]!.body).toBe(REQ.body)
  })

  it('原生桥返回 ok:false → AiNetworkError（错误信息不含 key）', async () => {
    const win = {
      AiApi: {
        request: (id: string) => {
          setTimeout(() => {
            ;(globalThis as unknown as { window: { __aiApiCallback?: (id: string, r: unknown) => void } }).window.__aiApiCallback?.(
              id,
              JSON.stringify({ ok: false, error: 'upstream 401' }),
            )
          }, 0)
        },
      },
    }
    ;(globalThis as unknown as { window: unknown }).window = win
    try {
      await createNativeHttpClient(500).send(REQ)
      throw new Error('should throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AiNetworkError)
      expect(JSON.stringify(error)).not.toContain('sk-test')
    }
  })

  it('原生桥超时 → AiTimeoutError', async () => {
    const win = {
      AiApi: {
        request: () => {
          /* 永不回调 */
        },
        cancel: () => undefined,
      },
    }
    ;(globalThis as unknown as { window: unknown }).window = win
    await expect(createNativeHttpClient(5).send(REQ)).rejects.toBeInstanceOf(AiTimeoutError)
  })
})
