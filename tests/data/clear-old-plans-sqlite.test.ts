import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { clearOldPlans, getDb, persistLearningWriteSource, resetDatabase, setSqliteTransport } from '../../src/data'
afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb') })
describe('P1 clean old plans sqlite', () => {
  it('SQLite 旧日期 plan 单 tx 删除 + IDB cache 清除', async () => {
    await resetDatabase()
    const db = getDb()
    await db.plans.put({ id: 'old', date: '2020-01-01', deckId: 'd', wordIds: [], index: 0, sources: {}, goals: {} as never, ratings: [], createdAt: 1, updatedAt: 1, completedAt: null } as never)
    await db.plans.put({ id: 'new', date: '2026-11-24', deckId: 'd', wordIds: [], index: 0, sources: {}, goals: {} as never, ratings: [], createdAt: 1, updatedAt: 1, completedAt: null } as never)
    await persistLearningWriteSource('sqlite')
    const txs: unknown[][] = []; let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'tx') { txs.push(req.ops ?? []); cb?.(id, JSON.stringify({ ok: true })) } else cb?.(id, JSON.stringify({ ok: true, rows: [{ id: 'old', date: '2020-01-01' }, { id: 'new', date: '2026-11-24' }] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const removed = await clearOldPlans('2026-01-01')
    expect(removed).toBe(1)
    expect(txs.length).toBe(1)
    expect(txs[0]![0]).toMatchObject({ op: 'delete', table: 'plans', where: { id: 'old' } })
    expect(await db.plans.get('old')).toBeUndefined()
    expect(await db.plans.get('new')).toBeTruthy()
  })
})
