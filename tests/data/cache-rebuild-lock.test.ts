import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { rebuildIdbCacheFromSqlite, resetDatabase, setSqliteTransport, withDataWriteLock } from '../../src/data'
afterEach(() => setSqliteTransport(null))
describe('cache rebuild lock', () => {
  it('外层写锁 + skipWriteLock 5s 完成', async () => {
    await resetDatabase()
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 2, counts: { states: 0, plans: 0, settings: 0, review_logs: 0 }, integrityOk: true, readOnly: false })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await Promise.race([
      withDataWriteLock(() => rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'deadlock' }), 5000)),
    ])
    expect(result).toMatchObject({ ok: true })
  }, 15000)
})
