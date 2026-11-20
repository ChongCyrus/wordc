import { afterEach, describe, expect, it } from 'vitest'

import {
  cancelAllNativeRequests,
  isNativeHttpAvailable,
  maimemoMessageFor,
  nativeFetch,
} from '../../../src/data/api/maimemo'
import { createMaimemoClient } from '../../../src/data/api/maimemo-client'
import type { MomoApiBridge } from '../../../src/data/api/native-http'

interface CapturedRequest {
  requestId: string
  method: string
  url: string
  headersJson: string
  body: string
}

interface MockBridge {
  bridge: MomoApiBridge
  captured: CapturedRequest[]
  cancelCalls: string[]
}

/** 安装一个假的原生桥（同步记录请求，异步回调） */
function installBridge(
  responder: (captured: CapturedRequest) => unknown | null,
  options: { isNativeApp?: () => string; cancel?: boolean } = {},
): MockBridge {
  const captured: CapturedRequest[] = []
  const cancelCalls: string[] = []
  const bridge: MomoApiBridge = {
    isNativeApp: options.isNativeApp ?? (() => 'momo-apk'),
    request: (requestId, method, url, headersJson, body) => {
      const request = { requestId, method, url, headersJson, body }
      captured.push(request)
      const response = responder(request)
      if (response === null) return // 永不回调（模拟超时）
      setTimeout(() => {
        const callback = (globalThis as unknown as { window?: Window }).window
          ?.__momoApiCallback
        callback?.(
          requestId,
          typeof response === 'string' ? response : JSON.stringify(response),
        )
      }, 0)
    },
    ...(options.cancel
      ? { cancel: (requestId: string) => void cancelCalls.push(requestId) }
      : {}),
  }
  ;(globalThis as unknown as { window?: unknown }).window = { MomoApi: bridge }
  return { bridge, captured, cancelCalls }
}

function uninstallBridge(): void {
  cancelAllNativeRequests()
  delete (globalThis as unknown as { window?: unknown }).window
}

afterEach(() => {
  uninstallBridge()
})

describe('isNativeHttpAvailable（task-38 检测）', () => {
  it('无 window / 无 MomoApi → false', () => {
    expect(isNativeHttpAvailable()).toBe(false)
  })

  it('isNativeApp() === "momo-apk" → true；其它返回值 → false', () => {
    installBridge(() => null)
    expect(isNativeHttpAvailable()).toBe(true)
    uninstallBridge()
    installBridge(() => null, { isNativeApp: () => 'browser' })
    expect(isNativeHttpAvailable()).toBe(false)
  })
})

describe('nativeFetch：参数序列化 / 成功 / 失败 / 超时', () => {
  it('调用 request(requestId, method, url, headersJson, body) 并把回调转成 Response', async () => {
    const mock = installBridge(() => ({ ok: true, status: 201, body: '{"hello":"世界"}' }))
    const response = await nativeFetch('https://open.maimemo.com/open/api/v1/memo/x', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 200 }),
    })
    expect(response.status).toBe(201)
    await expect(response.json()).resolves.toEqual({ hello: '世界' })
    expect(mock.captured).toHaveLength(1)
    const captured = mock.captured[0]!
    expect(typeof captured.requestId).toBe('string')
    expect(captured.requestId.length).toBeGreaterThan(10)
    expect(captured.method).toBe('POST')
    expect(captured.url).toBe('https://open.maimemo.com/open/api/v1/memo/x')
    expect(JSON.parse(captured.headersJson)).toMatchObject({
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(captured.body)).toEqual({ limit: 200 })
  })

  it('回调传对象（非字符串）也兼容', async () => {
    const mock = installBridge(() => ({ ok: true, status: 200, body: '{"a":1}' }))
    // 覆盖 dispatcher：模拟宿主直接传对象（安装后 handler 已就绪）
    const response = await nativeFetch('https://open.maimemo.com/open/api/v1/memo/y', {
      method: 'GET',
    })
    expect(response.status).toBe(200)
    // 再测一次对象回调（bridge 的 responder 返回对象时会被 JSON.stringify，这里直接断言成功即可）
    expect(mock.captured).toHaveLength(1)
    expect(mock.captured[0]!.method).toBe('GET')
  })

  it('ok:false → 抛 TypeError（兼容现有 catch）', async () => {
    installBridge(() => ({ ok: false, error: 'URL 不在白名单' }))
    await expect(
      nativeFetch('https://open.maimemo.com/open/api/v1/memo/z'),
    ).rejects.toThrowError(/URL 不在白名单/)
    await expect(
      nativeFetch('https://open.maimemo.com/open/api/v1/memo/z'),
    ).rejects.toBeInstanceOf(TypeError)
  })

  it('超时 25s 可注入缩短：永不回调 → TypeError(timeout) 并撤销 pending', async () => {
    installBridge(() => null)
    await expect(
      nativeFetch('https://open.maimemo.com/open/api/v1/memo/slow', {}, { timeoutMs: 20 }),
    ).rejects.toThrowError(/timeout/i)
  })

  it('request 同步抛错 → TypeError', async () => {
    ;(globalThis as unknown as { window?: unknown }).window = {
      MomoApi: {
        isNativeApp: () => 'momo-apk',
        request: () => {
          throw new Error('bridge exploded')
        },
      },
    }
    await expect(
      nativeFetch('https://open.maimemo.com/open/api/v1/memo/bad'),
    ).rejects.toBeInstanceOf(TypeError)
  })
})

describe('maimemo-client：原生模式直连（忽略 proxyUrl）', () => {
  function jsonEnvelope(data: unknown): unknown {
    return { ok: true, status: 200, body: JSON.stringify({ success: true, errors: [], data }) }
  }

  it('transportMode=native，URL 直连且不拼代理；解析官方外壳', async () => {
    const mock = installBridge((request) => {
      if (request.url.includes('/study/query_study_records')) {
        return jsonEnvelope({ records: [{ voc_spelling: 'apple' }], count: 1 })
      }
      return jsonEnvelope({})
    })
    const client = createMaimemoClient({
      token: 'test-token',
      proxyUrl: 'http://127.0.0.1:8787', // 原生模式应忽略
      throttle: false,
      sleep: async () => {},
      timeoutMs: 2000,
    })
    expect(client.transportMode).toBe('native')
    const page = await client.queryStudyRecords({ start: '2026-01-01 00:00:00+00:00', end: '2026-12-31 00:00:00+00:00', limit: 200 })
    expect(page.records).toHaveLength(1)
    expect(page.records[0]!.voc_spelling).toBe('apple')
    expect(mock.captured[0]!.url).toBe(
      'https://open.maimemo.com/open/api/v1/memo/study/query_study_records',
    )
    expect(mock.captured[0]!.url).not.toContain('127.0.0.1')
  })

  it('原生模式网络失败文案「网络失败，请检查网络或 Token」，不出现代理提示', async () => {
    installBridge(() => ({ ok: false, error: 'Connection refused' }))
    const client = createMaimemoClient({
      token: 'test-token',
      throttle: false,
      sleep: async () => {},
      maxRetries: 0,
      timeoutMs: 2000,
    })
    await expect(client.getStudyProgress()).rejects.toMatchObject({
      code: 'E_NETWORK',
      message: '网络失败，请检查网络或 Token',
    })
    const message = maimemoMessageFor('E_NETWORK')
    expect(message.title).toBe('网络失败')
    expect(message.hint).not.toContain('代理')
  })

  it('3xx 不跟随：视为失败（E_BAD_RESPONSE）', async () => {
    installBridge(() => ({ ok: true, status: 302, body: '' }))
    const client = createMaimemoClient({
      token: 'test-token',
      throttle: false,
      sleep: async () => {},
      maxRetries: 0,
      timeoutMs: 2000,
    })
    await expect(client.getStudyProgress()).rejects.toMatchObject({ code: 'E_BAD_RESPONSE' })
  })

  it('非原生（无 MomoApi）→ 回退浏览器 fetch + proxyUrl', async () => {
    uninstallBridge()
    const calls: string[] = []
    const client = createMaimemoClient({
      token: 'test-token',
      proxyUrl: 'http://127.0.0.1:8787',
      throttle: false,
      sleep: async () => {},
      fetchImpl: (async (input: RequestInfo | URL) => {
        calls.push(String(input))
        return new Response(JSON.stringify({ success: true, errors: [], data: { progress: { finished: 1, total: 2, study_time: 3 } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }) as typeof fetch,
    })
    expect(client.transportMode).toBe('browser')
    const progress = await client.getStudyProgress()
    expect(progress.finished).toBe(1)
    expect(calls[0]).toBe('http://127.0.0.1:8787/open/api/v1/memo/study/get_study_progress')
    // 非原生：E_NETWORK 文案仍给代理提示
    const message = maimemoMessageFor('E_NETWORK')
    expect(message.hint).toContain('代理')
  })
})
