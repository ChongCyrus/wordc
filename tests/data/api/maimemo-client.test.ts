import { describe, expect, it } from 'vitest'

import {
  createMaimemoClient,
  formatMaimemoDate,
  isMaimemoError,
  makeMaimemoError,
  parseMaimemoDate,
} from '../../../src/data/api/maimemo-client'
import type { MaimemoClientOptions } from '../../../src/data/api/maimemo-client'
import type { StudyRecord } from '../../../src/data/api/maimemo-types'

const TOKEN = 'test-token-not-real'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Ctx {
  calls: Array<{ url: string; init: RequestInit }>
}

function makeClient(
  handler: (url: string, init: RequestInit) => Promise<Response>,
  overrides: Partial<MaimemoClientOptions> = {},
): { client: ReturnType<typeof createMaimemoClient>; ctx: Ctx } {
  const ctx: Ctx = { calls: [] }
  const client = createMaimemoClient({
    token: TOKEN,
    throttle: false,
    sleep: async () => {},
    ...overrides,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      ctx.calls.push({ url, init: init ?? {} })
      return handler(url, init ?? {})
    }) as typeof fetch,
  })
  return { client, ctx }
}

describe('墨墨 API 客户端：成功 / 解包', () => {
  it('解包 {success,errors,data} 外壳', async () => {
    const { client, ctx } = makeClient(async () =>
      jsonResponse({ success: true, errors: [], data: { voc: { id: 'V1', spelling: 'apple' } } }),
    )
    const voc = await client.getVocabulary('apple')
    expect(voc).toEqual({ id: 'V1', spelling: 'apple' })
    expect(ctx.calls[0]!.url).toContain('https://open.maimemo.com/open/api/v1/memo/vocabulary?spelling=apple')
    const headers = ctx.calls[0]!.init.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`)
    expect(client.requestCountValue).toBe(1)
  })

  it('兼容裸数据体（无 data 字段）', async () => {
    const { client } = makeClient(async () => jsonResponse({ progress: { finished: 8, total: 888, study_time: 1000 } }))
    await expect(client.getStudyProgress()).resolves.toEqual({ finished: 8, total: 888, studyTime: 1000 })
  })

  it('query_study_records 使用 next_study_date 窗口与 limit≤200', async () => {
    const { client, ctx } = makeClient(async () => jsonResponse({ success: true, errors: [], data: { records: [] } }))
    await client.queryStudyRecords({
      start: '2026-01-01 00:00:00+00:00',
      end: '2026-12-31 00:00:00+00:00',
      limit: 1000,
    })
    const body = JSON.parse(String(ctx.calls[0]!.init.body)) as Record<string, unknown>
    expect(body.limit).toBe(200) // 超上限自动收敛（D45：1000 会 500）
    expect(body.next_study_date).toEqual({
      start: '2026-01-01 00:00:00+00:00',
      end: '2026-12-31 00:00:00+00:00',
    })
    expect(ctx.calls[0]!.url).toContain('/study/query_study_records')
    expect(ctx.calls[0]!.init.method).toBe('POST')
  })
})

describe('墨墨 API 客户端：错误分类与重试', () => {
  it('401 → E_UNAUTHORIZED，不重试', async () => {
    const { client, ctx } = makeClient(async () =>
      jsonResponse({ errors: [{ code: 'common_unauthorized', msg: 'Authorization failed' }], success: false }, 401),
    )
    await expect(client.getStudyProgress()).rejects.toMatchObject({ code: 'E_UNAUTHORIZED', status: 401 })
    expect(ctx.calls).toHaveLength(1)
  })

  it('403 → E_FORBIDDEN，不重试', async () => {
    const { client, ctx } = makeClient(async () => jsonResponse({ success: false, errors: [] }, 403))
    await expect(client.getStudyProgress()).rejects.toMatchObject({ code: 'E_FORBIDDEN' })
    expect(ctx.calls).toHaveLength(1)
  })

  it('429 先失败后成功：自动退避重试', async () => {
    let count = 0
    const sleeps: number[] = []
    const { client, ctx } = makeClient(
      async () => {
        count += 1
        if (count <= 2) return jsonResponse({ success: false, errors: [{ code: 'too_many_requests' }] }, 429)
        return jsonResponse({ success: true, errors: [], data: { progress: { finished: 1, total: 2, study_time: 3 } } })
      },
      { sleep: async (ms: number) => void sleeps.push(ms), random: () => 0 },
    )
    const progress = await client.getStudyProgress()
    expect(progress.finished).toBe(1)
    expect(ctx.calls).toHaveLength(3)
    expect(sleeps[0]).toBe(1000)
    expect(sleeps[1]).toBe(2000)
  })

  it('5xx 重试耗尽 → E_SERVER', async () => {
    const { client, ctx } = makeClient(async () => jsonResponse({ success: false, errors: [] }, 500), {
      maxRetries: 2,
      random: () => 0,
    })
    await expect(client.getStudyProgress()).rejects.toMatchObject({ code: 'E_SERVER', retryable: true })
    expect(ctx.calls).toHaveLength(3) // 1 + 2 次重试
  })

  it('超时（AbortError）→ E_TIMEOUT', async () => {
    const { client, ctx } = makeClient(
      async () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      },
      { maxRetries: 0 },
    )
    await expect(client.getStudyProgress()).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    expect(ctx.calls).toHaveLength(1)
  })

  it('fetch TypeError（CORS/断网）→ E_NETWORK 且不重试', async () => {
    const { client, ctx } = makeClient(async () => {
      throw new TypeError('Failed to fetch')
    })
    await expect(client.getStudyProgress()).rejects.toMatchObject({ code: 'E_NETWORK', retryable: false })
    expect(ctx.calls).toHaveLength(1)
  })

  it('非 JSON 响应 → E_BAD_RESPONSE', async () => {
    const { client } = makeClient(async () => new Response('<html>oops</html>', { status: 200 }))
    await expect(client.getStudyProgress()).rejects.toMatchObject({ code: 'E_BAD_RESPONSE' })
  })

  it('HTTP 200 但 success=false → 按 server code 分类', async () => {
    const { client } = makeClient(async () =>
      jsonResponse({ success: false, errors: [{ code: 'common_unauthorized', msg: 'Authorization failed' }] }),
    )
    await expect(client.getStudyProgress()).rejects.toMatchObject({ code: 'E_UNAUTHORIZED' })
  })

  it('无 token 直接抛 E_NO_TOKEN', () => {
    expect(() => createMaimemoClient({ token: '  ' })).toThrowError(/Token/)
    try {
      createMaimemoClient({ token: '' })
    } catch (error) {
      expect(isMaimemoError(error) && error.code).toBe('E_NO_TOKEN')
    }
  })

  it('makeMaimemoError 分类工具', () => {
    const error = makeMaimemoError('E_SERVER', 'x', { status: 500, serverCode: 'c', retryable: true })
    expect(error.name).toBe('MaimemoError')
    expect(error.status).toBe(500)
    expect(isMaimemoError(error)).toBe(true)
    expect(isMaimemoError(new Error('plain'))).toBe(false)
  })
})

describe('墨墨 API 客户端：限流', () => {
  it('请求间隔不足时等待（1.7s 口径可注入）', async () => {
    let clock = 0
    const waits: number[] = []
    const { client } = makeClient(
      async () => jsonResponse({ success: true, errors: [], data: { record: 1 } }),
      {
        throttle: true,
        minIntervalMs: 1000,
        now: () => clock,
        sleep: async (ms: number) => {
          waits.push(ms)
          clock += ms
        },
      },
    )
    await client.request('/x')
    await client.request('/x')
    await client.request('/x')
    expect(waits).toEqual([1000, 1000])
    expect(client.requestCountValue).toBe(3)
  })
})

describe('墨墨 API 客户端：时间窗二分翻页', () => {
  const DAY = 86_400_000
  const BASE = new Date(2026, 0, 1, 12, 0, 0).getTime()

  function makeRecords(count: number): StudyRecord[] {
    return Array.from({ length: count }, (_, index) => ({
      voc_id: `voc-${index}`,
      voc_spelling: `word${index}`,
      last_response: 'FAMILIAR',
      first_study_date: formatMaimemoDate(BASE + index * DAY),
      last_study_date: formatMaimemoDate(BASE + index * DAY),
      next_study_date: formatMaimemoDate(BASE + (index + 1) * DAY),
      study_count: 1,
      tags: [],
    }))
  }

  function windowHandler(records: StudyRecord[]) {
    return async (_url: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body ?? '{}')) as {
        as_count?: boolean
        next_study_date?: { start?: string; end?: string }
        limit?: number
      }
      if (body.as_count) {
        return jsonResponse({ success: true, errors: [], data: { records: [], count: records.length } })
      }
      const start = body.next_study_date?.start ? parseMaimemoDate(body.next_study_date.start) : null
      const end = body.next_study_date?.end ? parseMaimemoDate(body.next_study_date.end) : null
      const filtered = records.filter((record) => {
        const time = parseMaimemoDate(record.next_study_date)
        if (time == null) return false
        if (start != null && time < start) return false
        if (end != null && time > end) return false
        return true
      })
      const limit = body.limit ?? 200
      return jsonResponse({
        success: true,
        errors: [],
        data: { records: filtered.slice(0, limit), count: filtered.length },
      })
    }
  }

  it('分页拉全 450 条，无重复、页数 > 2', async () => {
    const records = makeRecords(450)
    const progress: Array<[number, number]> = []
    const { client } = makeClient(windowHandler(records), {
      // 从 2026 年附近开始，避免 1970→2026 的空窗多耗请求
      baseUrl: 'https://open.maimemo.com/open/api/v1/memo',
    })
    const result = await client.fetchAllStudyRecords((done, total) => progress.push([done, total]))
    expect(result.total).toBe(450)
    expect(result.records).toHaveLength(450)
    expect(new Set(result.records.map((record) => record.voc_id)).size).toBe(450)
    expect(result.pages).toBeGreaterThan(2)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[progress.length - 1]![0]).toBe(450)
  })

  it('恰好 200 条/页会继续二分（窗口密集）', async () => {
    const records = makeRecords(200) // 一页刚好 limit → 需要再拆一次确认
    const { client } = makeClient(windowHandler(records))
    const result = await client.fetchAllStudyRecords()
    expect(result.records).toHaveLength(200)
  })

  it('超过 maxPages 抛 E_RATE_LIMITED', async () => {
    const records = makeRecords(450)
    const { client } = makeClient(windowHandler(records), { maxPages: 1 })
    await expect(client.fetchAllStudyRecords()).rejects.toMatchObject({ code: 'E_RATE_LIMITED' })
  })
})

describe('时间串格式化（D45：官方用 +00:00 后缀表示北京时间）', () => {
  it('format → parse 往返一致（测试与本地时区无关：用固定 UTC 偏移计算）', () => {
    // 官方时间串是「北京时间墙钟 + 固定 +00:00 后缀」：
    // 北京时间 2026-11-10 08:30:15 == UTC 2026-11-10 00:30:15（Date.UTC 构造，不依赖 process.env.TZ）
    const ts = Date.UTC(2026, 10, 10, 0, 30, 15)
    const text = formatMaimemoDate(ts)
    expect(text).toBe('2026-11-10 08:30:15+00:00')
    expect(parseMaimemoDate(text)).toBe(ts)
    // 自证多个 epoch（含 0、跨日边界）往返稳定，避免硬编码某本地时区的墙钟
    for (const epoch of [0, Date.UTC(2026, 0, 1, 15, 59, 59), Date.UTC(2027, 11, 31, 16, 0, 0)]) {
      expect(parseMaimemoDate(formatMaimemoDate(epoch))).toBe(epoch)
    }
  })

  it('+00:00 按北京时间解释；+08:00 同义；Z 同义', () => {
    const expected = Date.UTC(2026, 10, 9, 16, 0, 0) // 2026-11-10 00:00 北京 = 前一日 16:00 UTC
    expect(parseMaimemoDate('2026-11-10 00:00:00+00:00')).toBe(expected)
    expect(parseMaimemoDate('2026-11-10T00:00:00+08:00')).toBe(expected)
    expect(parseMaimemoDate('2026-11-10T00:00:00Z')).toBe(expected)
    expect(parseMaimemoDate('not a date')).toBeNull()
    expect(parseMaimemoDate(null)).toBeNull()
  })
})
