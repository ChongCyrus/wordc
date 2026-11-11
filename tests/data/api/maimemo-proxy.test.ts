import { afterEach, describe, expect, it } from 'vitest'

import { createProxyServer } from '../../../src/data/api/maimemo-proxy.mjs'
import type { ProxyServerLike } from '../../../src/data/api/maimemo-proxy.mjs'

let server: ProxyServerLike | null = null

async function listen(
  fetchImpl: typeof fetch,
): Promise<{ base: string; calls: Array<{ url: string; init: RequestInit }> }> {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const wrapped = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return fetchImpl(input as RequestInfo, init)
  }) as typeof fetch
  server = createProxyServer({ fetchImpl: wrapped })
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return { base: `http://127.0.0.1:${address.port}`, calls }
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
  }
})

describe('墨墨本地代理（CORS 绕行）', () => {
  it('OPTIONS 预检返回 CORS 头', async () => {
    const { base } = await listen(async () => new Response('{}'))
    const response = await fetch(`${base}/open/api/v1/memo/study/query_study_records`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:4173' },
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-allow-headers')?.toLowerCase()).toContain('authorization')
  })

  it('POST 转发到 https://open.maimemo.com 并原样返回（含 Authorization）', async () => {
    const { base, calls } = await listen(async () =>
      new Response(JSON.stringify({ success: true, errors: [], data: { records: [{ voc_id: 'x' }], count: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const response = await fetch(`${base}/open/api/v1/memo/study/query_study_records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer fake-token' },
      body: JSON.stringify({ limit: 200 }),
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    const body = (await response.json()) as { data: { records: unknown[] } }
    expect(body.data.records).toHaveLength(1)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://open.maimemo.com/open/api/v1/memo/study/query_study_records')
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer fake-token')
  })

  it('上游 401 原样透传（浏览器端能正确分类 E_UNAUTHORIZED）', async () => {
    const { base } = await listen(async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 'common_unauthorized' }] }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    )
    const response = await fetch(`${base}/open/api/v1/memo/vocabulary?spelling=apple`, {
      headers: { Authorization: 'Bearer bad' },
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('只代理 /open/*，其它路径 404（防 SSRF）', async () => {
    const { base } = await listen(async () => new Response('{}'))
    const response = await fetch(`${base}/other/secret`)
    expect(response.status).toBe(404)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('/open/*')
  })

  it('上游异常 → 502 + 可读错误', async () => {
    const { base } = await listen(async () => {
      throw new Error('socket hang up')
    })
    const response = await fetch(`${base}/open/api/v1/memo/study/get_study_progress`, {
      method: 'POST',
      headers: { Authorization: 'Bearer fake' },
      body: '{}',
    })
    expect(response.status).toBe(502)
    const body = (await response.json()) as { error: string }
    expect(body.error).toContain('upstream request failed')
  })
})
