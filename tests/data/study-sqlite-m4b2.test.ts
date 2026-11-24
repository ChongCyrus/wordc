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
  submitRatingSqlite,
  updateSettings,
  type SqliteTransport,
} from '../../src/data'

function install(opts: { clientOps?: Array<{ op_id: string; result_json: string }>; failTx?: boolean; stateRows?: Array<Record<string, unknown>> } = {}) {
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
