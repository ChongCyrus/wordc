/** 0.11.0 M4b-2-1：submitRating SQLite 事务/幂等/失败不回写 IDB/只读重试 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildInitialState,
  createDeck,
  getDb,
  resetDatabase,
  setSqliteTransport,
  persistLearningWriteSource,
  flushRatingCacheWarmup,
  getRatingCacheDebugEvents,
  markIdbCacheDirty,
  submitRatingSqlite,
  updateSettings,
  type SqliteTransport,
} from '../../src/data'

function install(opts: { clientOps?: Array<{ op_id: string; result_json: string }>; failTx?: boolean; stateRows?: Array<Record<string, unknown>>; reviewLogDelayMs?: number } = {}) {
  const txs: unknown[][] = []
  let seq = 0
  const transport: SqliteTransport = {
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'tx') {
          txs.push(req.ops ?? [])
          callback?.(id, JSON.stringify(opts.failTx ? { ok: false, code: 'E_IO', message: 'mock tx fail' } : { ok: true }))
          return
        }
        if (req.payload?.table === 'client_ops') callback?.(id, JSON.stringify({ ok: true, rows: opts.clientOps ?? [] }))
        else if (req.payload?.table === 'states') callback?.(id, JSON.stringify({ ok: true, rows: opts.stateRows ?? [] }))
        else if (req.payload?.table === 'plans') callback?.(id, JSON.stringify({ ok: true, rows: [] }))
        else if (req.payload?.table === 'review_logs' && opts.reviewLogDelayMs) setTimeout(() => callback?.(id, JSON.stringify({ ok: true, rows: [] })), opts.reviewLogDelayMs)
        else callback?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  }
  setSqliteTransport(transport)
  return { txs }
}

async function seed() {
  await resetDatabase()
  const deck = await createDeck({ name: 'sqlite-rating', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
  return { deck, word }
}

afterEach(async () => {
  setSqliteTransport(null)
  await persistLearningWriteSource('idb')
})

describe('0.11.0 · M4b-2-1 submitRating SQLite', () => {
  it('单 tx 写 state/log/plan?/client_ops；成功后更新 IDB cache', async () => {
    const { word } = await seed()
    await persistLearningWriteSource('sqlite')
    const mock = install()
    const result = await submitRatingSqlite(word.id, 'familiar', 1000, { clientOpId: 'op-1' })
    await flushRatingCacheWarmup()
    expect(result.state.wordId).toBe(word.id)
    expect(mock.txs).toHaveLength(1)
    const tables = mock.txs[0]!.map((op) => (op as { table: string }).table)
    expect(tables).toContain('states')
    expect(tables).toContain('review_logs')
    expect(tables).toContain('client_ops')
    expect((await getDb().states.get(word.id))?.phase).toBeTruthy()
    expect(await getDb().reviewLogs.where('wordId').equals(word.id).count()).toBe(1)
  })

  it('同 clientOpId 重放返回首次结果，不重复 tx', async () => {
    const { word } = await seed()
    await persistLearningWriteSource('sqlite')
    const cached = { state: buildInitialState(word, 1), log: { id: 0 }, intervalDays: 1, longTermUpdate: false, requeue: 'none' }
    const mock = install({ clientOps: [{ op_id: 'op-1', result_json: JSON.stringify(cached) }] })
    const replay = await submitRatingSqlite(word.id, 'familiar', 1000, { clientOpId: 'op-1' })
    expect(replay.idempotentReplay).toBe(true)
    expect(mock.txs).toHaveLength(0)
  })

  it('SQLite tx 失败：不写 IDB；只读模式返回可重试错误', async () => {
    const { word } = await seed()
    await persistLearningWriteSource('sqlite')
    install({ failTx: true })
    const before = await getDb().states.get(word.id)
    await expect(submitRatingSqlite(word.id, 'familiar', 1000, { clientOpId: 'op-fail' })).rejects.toThrow(/mock tx fail/)
    expect(await getDb().states.get(word.id)).toEqual(before)
    await persistLearningWriteSource('readonly')
    await expect(submitRatingSqlite(word.id, 'familiar', 1000, { clientOpId: 'op-ro' })).rejects.toMatchObject({ code: 'LEARNING_READONLY' })
  })
})

describe('task-299 连评关键路径', () => {
  it('连续 10 次评分：事务全部提交，后台 cache flush 后可读', async () => {
    const { word } = await seed()
    await persistLearningWriteSource('sqlite')
    const mock = install()
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => submitRatingSqlite(word.id, 'familiar', 1000 + i, { clientOpId: `rapid-${i}` }).catch((error) => error)))
    expect(results.filter((item) => item instanceof Error)).toHaveLength(0)
    expect(mock.txs).toHaveLength(10)
    await flushRatingCacheWarmup()
    expect((await getDb().states.get(word.id))?.phase).toBeTruthy()
    const meta = await (await import('../../src/data/idb-cache')).getIdbCacheMeta()
    expect(meta?.dirty).toBe(false)
  })
})


describe('task-299 dirty 窗口', () => {
  it('第一次评分返回时 dirty 已置位；第二次评分前不会读旧 cache', async () => {
    const { word } = await seed()
    await persistLearningWriteSource('sqlite')
    const mock = install({ reviewLogDelayMs: 40 })
    const first = await submitRatingSqlite(word.id, 'familiar', 2000, { clientOpId: 'dirty-1' })
    expect(first.log.id).toBe(0)
    const meta = await (await import('../../src/data/idb-cache')).getIdbCacheMeta()
    expect(meta?.dirty).toBe(true)
    const second = await submitRatingSqlite(word.id, 'familiar', 2001, { clientOpId: 'dirty-2' })
    expect(second.state.wordId).toBe(word.id)
    await flushRatingCacheWarmup()
    expect(mock.txs).toHaveLength(2)
  })
})

describe('task-299 并发 cache 串行', () => {
  it('评分1后台未完成时评分2返回：dirty 仍 true，最终 cache 为最新 state', async () => {
    const { word } = await seed()
    await persistLearningWriteSource('sqlite')
    install({ reviewLogDelayMs: 60 })
    const first = await submitRatingSqlite(word.id, 'familiar', 3000, { clientOpId: 'seq-1' })
    expect((await (await import('../../src/data/idb-cache')).getIdbCacheMeta())?.dirty).toBe(true)
    const second = await submitRatingSqlite(word.id, 'vague', 3001, { clientOpId: 'seq-2' })
    const dirtyBeforeFlush = await (await import('../../src/data/idb-cache')).getIdbCacheMeta()
    expect(dirtyBeforeFlush?.dirty).toBe(true)
    await flushRatingCacheWarmup()
    const cached = await getDb().states.get(word.id)
    expect(cached?.lastRating).toBe(second.state.lastRating)
    expect((await (await import('../../src/data/idb-cache')).getIdbCacheMeta())?.dirty).toBe(false)
    expect(first.state.wordId).toBe(word.id)
    const events = getRatingCacheDebugEvents()
    const last = events.slice(-4)
    expect(last.map((event) => event.split(':')[0])).toEqual(['start', 'end', 'start', 'end'])
    expect(Number(last[0]!.split(':')[1])).toBe(Number(last[1]!.split(':')[1]))
    expect(Number(last[2]!.split(':')[1])).toBe(Number(last[3]!.split(':')[1]))
    expect(Number(last[2]!.split(':')[1])).toBeGreaterThan(Number(last[1]!.split(':')[1]))
  })
})

describe('task-299 首词 plan index', () => {
  it('首词评分 tx 内 plan.index 前进，后台 cache flush 后 IDB plan 同步', async () => {
    const { deck, word } = await seed()
    await persistLearningWriteSource('sqlite')
    const db = getDb()
    const planId = `${new Date().toISOString().slice(0, 10)}:${deck.id}`
    await db.plans.put({ id: planId, date: new Date().toISOString().slice(0, 10), deckId: deck.id, wordIds: [word.id, 'other'], index: 0, sources: { [word.id]: 'new', other: 'new' }, goals: { dailyGoal: 10, dueCount: 0, newBudget: 10, extraCount: 0 }, ratings: [], createdAt: 1, updatedAt: 1, completedAt: null } as never)
    await (await import('../../src/data/idb-cache')).clearIdbCacheDirty({ generation: await (await import('../../src/data/data-epoch')).getDataEpoch(), sqliteUserVersion: 3, dirty: false })
    const mock = install()
    await submitRatingSqlite(word.id, 'familiar', 4000, { clientOpId: 'plan-first', planId })
    const txPlan = mock.txs[0]!.find((op) => (op as { table: string }).table === 'plans') as { row?: { idx?: number } } | undefined
    expect(txPlan?.row?.idx).toBe(1)
    await flushRatingCacheWarmup()
    expect((await db.plans.get(planId))?.index).toBe(1)
  })
})

describe('task-312 C-06 compare-and-clear', () => {
  it('其它写 dirty 不会被 rating cache 清除', async () => {
    const { word } = await seed()
    await persistLearningWriteSource('sqlite')
    install({ reviewLogDelayMs: 40 })
    await submitRatingSqlite(word.id, 'familiar', 5000, { clientOpId: 'c06-1' })
    await markIdbCacheDirty('other-write-failed')
    await flushRatingCacheWarmup()
    expect((await (await import('../../src/data/idb-cache')).getIdbCacheMeta())?.dirty).toBe(true)
  })
})
