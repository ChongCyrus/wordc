import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInitialState, createDeck, ensureLegacyIdbMigratedToSqlite, getDb, resetDatabase, setSqliteTransport, updateSettings } from '../../src/data'
afterEach(() => setSqliteTransport(null))
describe('M6 auto legacy migration gate', () => {
  it('无 SQLite → unsupported；SQLite 非空 → skipped 不重复迁移', async () => {
    expect((await ensureLegacyIdbMigratedToSqlite()).mode).toBe('unsupported')
    await resetDatabase()
    const deck = await createDeck({ name: 'g', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ ...buildInitialState(word, 1), phase: 'review' })
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          cb?.(id, JSON.stringify({ ok: true, userVersion: 2, counts: { states: 241, plans: 1, settings: 13, review_logs: 2 }, readOnly: false, integrityOk: true }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const result = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => ({ ok: true }) })
    expect(result.mode).toBe('skipped')
  })
})

import { withDataWriteLock, migrateIdbToSqlite } from '../../src/data'
describe('M6 lock order', () => {
  it('ensureLegacy 外层锁 + migrate skipWriteLock 不死锁(<5s)', async () => {
    const { resetDatabase, createDeck, updateSettings } = await import('../../src/data')
    await resetDatabase()
    const deck = await createDeck({ name: 'lock', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    let migrated = false
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[] }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 2, readOnly: false, counts: migrated ? { states: 0, plans: 0, settings: 1, review_logs: 0 } : { states: 0, plans: 0, settings: 0, review_logs: 0 } }))
          else if (req.method === 'tx') { migrated = true; cb?.(id, JSON.stringify({ ok: true })) }
          else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const result = await Promise.race([
      withDataWriteLock(() => migrateIdbToSqlite({ dryRun: false, unsafe: true, skipWriteLock: true, sqliteTxImpl: async () => { migrated = true; return { ok: true } }, sqliteQueryImpl: async () => ({ ok: true, rows: [] }), sqliteHealthImpl: async () => ({ ok: true, userVersion: 2, counts: migrated ? { states: 0, plans: 0, settings: 1, review_logs: 0 } : { states: 0, plans: 0, settings: 0, review_logs: 0 } }) })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, error: 'deadlock timeout' }), 5000)),
    ])
    expect(result).toMatchObject({ ok: true })
    setSqliteTransport(null)
  }, 15000)
})
