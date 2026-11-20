import '../test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  createDeck,
  getDb,
  importMaimemoProgress,
  isMaimemoError,
  resetDatabase,
  updateSettings,
} from '../../../src/data'
import { createMaimemoClient } from '../../../src/data/api/maimemo-client'
import type { MaimemoClient } from '../../../src/data/api/maimemo-client'

interface MockContext {
  calls: BodyInit[]
  client: ReturnType<typeof createMaimemoClient>
}

function envelope(records: unknown[]): Response {
  return new Response(JSON.stringify({ success: true, errors: [], data: { records } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function makeClient(
  handler: (body: { spellings?: string[]; limit?: number }, index: number) => Response | Promise<Response>,
  overrides: Parameters<typeof createMaimemoClient>[0] extends infer O
    ? O extends { token: string }
      ? Partial<O>
      : never
    : never = {},
): MockContext {
  const calls: BodyInit[] = []
  const client = createMaimemoClient({
    token: 'test-token',
    throttle: false,
    sleep: async () => {},
    maxRetries: 2,
    ...overrides,
    fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { spellings?: string[]; limit?: number }
      calls.push(String(init?.body ?? ''))
      return handler(body, calls.length - 1)
    }) as typeof fetch,
  })
  return { calls, client }
}

const BASE_OPTS = { minIntervalMs: 0 }

beforeEach(async () => {
  await resetDatabase()
})

describe('task-40：按拼写批量拉取（spellings 策略）', () => {
  it('分批查询：请求数=批数、进度语义为已扫描词/总词、按 voc_id 去重', async () => {
    const spellings = Array.from({ length: 100 }, (_, index) => `word${index}`)
    const learned = new Set(spellings.filter((_, index) => index % 2 === 0)) // 50 个
    const progress: Array<[number, number]> = []
    const { client, calls } = makeClient((body) => {
      const records = (body.spellings ?? [])
        .filter((spelling) => learned.has(spelling))
        .map((spelling) => ({ voc_id: `id-${spelling}`, voc_spelling: spelling, last_response: 'FAMILIAR' }))
      return envelope(records)
    })
    const result = await client.fetchAllStudyRecords({
      spellings,
      batchSize: 10,
      ...BASE_OPTS,
      onProgress: (scanned, total) => progress.push([scanned, total]),
    })
    expect(result.strategy).toBe('spellings')
    expect(result.pages).toBe(10)
    expect(calls).toHaveLength(10)
    expect(result.records).toHaveLength(50)
    expect(result.scanned).toBe(100)
    // 进度：单调递增，最后一条 = 100/100
    expect(progress.at(-1)).toEqual([100, 100])
    expect(progress.length).toBeGreaterThan(0)
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]![0]).toBeGreaterThanOrEqual(progress[i - 1]![0])
      expect(progress[i]![1]).toBe(100)
    }
    // 每批 limit=200（服务端单页上限）
    expect((JSON.parse(String(calls[0])) as { limit?: number }).limit).toBe(200)
  })

  it('拼写归一化去重：大小写/空白视为同一词，只查一次', async () => {
    const { client, calls } = makeClient((body) =>
      envelope((body.spellings ?? []).map((spelling) => ({ voc_id: `id-${spelling.toLowerCase()}`, voc_spelling: spelling }))),
    )
    const result = await client.fetchAllStudyRecords({
      spellings: ['apple', 'Apple', ' apple ', 'APPLE'],
      batchSize: 10,
      ...BASE_OPTS,
    })
    expect(calls).toHaveLength(1)
    expect(result.records).toHaveLength(1)
    expect(result.scanned).toBe(1)
  })

  it('服务端忽略 spellings 过滤（返回不在本批的词）→ 立刻 E_BAD_RESPONSE（不静默降级）', async () => {
    const { client } = makeClient(() =>
      envelope([{ voc_id: 'x1', voc_spelling: 'not-in-batch' }]),
    )
    try {
      await client.fetchAllStudyRecords({ spellings: ['apple', 'banana'], batchSize: 10, ...BASE_OPTS })
      throw new Error('should throw')
    } catch (error) {
      expect(isMaimemoError(error)).toBe(true)
      expect((error as { code: string }).code).toBe('E_BAD_RESPONSE')
      expect((error as Error).message).toContain('spellings')
    }
  })

  it('限流 429 自动退避重试后继续成功', async () => {
    let count = 0
    const { client, calls } = makeClient((body) => {
      count += 1
      if (count === 1) {
        return new Response(JSON.stringify({ success: false, errors: [{ code: 'common_too_many_request' }] }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        })
      }
      return envelope((body.spellings ?? []).map((spelling) => ({ voc_id: `id-${spelling}`, voc_spelling: spelling })))
    })
    const result = await client.fetchAllStudyRecords({ spellings: ['apple', 'banana'], batchSize: 10, ...BASE_OPTS })
    expect(result.records).toHaveLength(2)
    expect(calls.length).toBe(2) // 1 次 429 + 1 次成功
  })

  it('总请求上限：超过 maxRequests → E_RATE_LIMITED 明确错误', async () => {
    const spellings = Array.from({ length: 100 }, (_, index) => `w${index}`)
    const { client, calls } = makeClient((body) =>
      envelope((body.spellings ?? []).map((spelling) => ({ voc_id: `id-${spelling}`, voc_spelling: spelling }))),
    )
    await expect(
      client.fetchAllStudyRecords({ spellings, batchSize: 10, maxRequests: 3, ...BASE_OPTS }),
    ).rejects.toMatchObject({ code: 'E_RATE_LIMITED' })
    expect(calls.length).toBeLessThanOrEqual(4)
  })

  it('单页满 limit 视为可能截断：按拼写集合二分重查，最终记录完整', async () => {
    const spellings = Array.from({ length: 8 }, (_, index) => `s${index}`)
    const { client } = makeClient((body) => {
      const batch = body.spellings ?? []
      // 模拟服务端单页上限 4：只返回前 4 条（超出一律截断）
      const records = batch.slice(0, 4).map((spelling) => ({ voc_id: `id-${spelling}`, voc_spelling: spelling }))
      return envelope(records)
    })
    const result = await client.fetchAllStudyRecords({
      spellings,
      batchSize: 8,
      pageLimit: 4,
      ...BASE_OPTS,
    })
    expect(result.records).toHaveLength(8)
    expect(new Set(result.records.map((record) => record.voc_spelling)).size).toBe(8)
  })

  it('取消：abort 后抛 E_CANCELLED 且不再发请求', async () => {
    const controller = new AbortController()
    controller.abort()
    const { client, calls } = makeClient(() => envelope([]))
    await expect(
      client.fetchAllStudyRecords({ spellings: ['apple'], batchSize: 10, signal: controller.signal, ...BASE_OPTS }),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' })
    expect(calls).toHaveLength(0)
  })

  it('取消：批次进行中 abort → 后续批次停止', async () => {
    const controller = new AbortController()
    const spellings = Array.from({ length: 30 }, (_, index) => `w${index}`)
    const { client, calls } = makeClient((body) =>
      envelope((body.spellings ?? []).map((spelling) => ({ voc_id: `id-${spelling}`, voc_spelling: spelling }))),
    )
    await expect(
      client.fetchAllStudyRecords({
        spellings,
        batchSize: 10,
        signal: controller.signal,
        ...BASE_OPTS,
        onProgress: (scanned) => {
          if (scanned >= 10) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ code: 'E_CANCELLED' })
    expect(calls.length).toBe(1)
  })

  it('无 spellings → 日期窗口兜底；乱序/游标无进展时明确报错（不再无限二分）', async () => {
    const { client, calls } = makeClient(() => {
      // 200 条满页且时间乱序（模拟真实接口不可靠）
      const records = Array.from({ length: 200 }, (_, index) => ({
        voc_id: `id-${index}`,
        voc_spelling: `w${index}`,
        next_study_date: index % 2 === 0 ? '2027-04-11 00:00:00+00:00' : '2026-11-09 00:00:00+00:00',
      }))
      return envelope(records)
    })
    await expect(client.fetchAllStudyRecords(BASE_OPTS)).rejects.toMatchObject({
      code: 'E_BAD_RESPONSE',
    })
    // 第 1 次是 as_count 估计总数（窗口兜底的进度分母），第 2 次是第一页窗口查询；
    // 检测到乱序后首次即抛错，不会再有第二页/二分请求。
    expect(calls.length).toBe(2)
    expect(JSON.parse(String(calls[0]))).toMatchObject({ as_count: true })
    expect(JSON.parse(String(calls[1]))).not.toHaveProperty('as_count')
  })

  it('importMaimemoProgress 会把本地词库拼写传给 client（progress 语义为词数）', async () => {
    const deck = await createDeck({
      name: '拼写列表测试',
      words: Array.from({ length: 12 }, (_, index) => ({
        headword: `api${index}`,
        meanings: [{ pos: 'n.', cn: `词${index}` }],
      })),
    })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    expect((await getDb().words.count())).toBe(12)

    let capturedSpellings: string[] = []
    const progress: Array<[number, number]> = []
    const mockClient = {
      fetchAllStudyRecords: async (options: {
        spellings?: string[]
        onProgress?: (scanned: number, total: number) => void
      }) => {
        capturedSpellings = options.spellings ?? []
        options.onProgress?.(6, 12)
        options.onProgress?.(12, 12)
        return {
          records: [{ voc_id: 'v1', voc_spelling: 'api0', last_response: 'FAMILIAR' }],
          pages: 3,
          total: 0,
          strategy: 'spellings' as const,
          scanned: 12,
          durationMs: 10,
        }
      },
    } as unknown as MaimemoClient

    const result = await importMaimemoProgress({
      client: mockClient,
      onProgress: (scanned, total) => progress.push([scanned, total]),
    })
    expect(capturedSpellings.sort()).toEqual(
      Array.from({ length: 12 }, (_, index) => `api${index}`).sort(),
    )
    expect(result.strategy).toBe('spellings')
    expect(result.scanned).toBe(12)
    expect(result.pages).toBe(3)
    expect(result.matched).toBe(1)
    expect(progress).toEqual([
      [6, 12],
      [12, 12],
    ])
  })
})
