import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeck, ensureLegacyIdbMigratedToSqlite, getDb, persistLearningWriteSource, resetDatabase, setSqliteTransport, SQLITE_SCHEMA_VERSION } from '../../src/data'
afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb').catch(() => undefined) })
function install(opts: { sqliteNonEmpty: boolean; durable?: boolean }) {
  const counts = opts.sqliteNonEmpty ? { states: 255, plans: 1, settings: 13, review_logs: 0 } : { states: 0, plans: 0, settings: 0, review_logs: 0 }
  let seq = 0; const txs: unknown[][] = []
  setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'health') { cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts, readOnly: false, integrityOk: true })); return } if (req.method === 'tx') { txs.push(req.ops ?? []); cb?.(id, JSON.stringify({ ok: true })); return } if (req.method === 'query') { const table = String(req.payload?.table ?? ''); if (table === 'migration_state') cb?.(id, JSON.stringify({ ok: true, rows: opts.durable ? [{ step: 'legacy-idb', status: 'done' }] : [] })); else cb?.(id, JSON.stringify({ ok: true, rows: opts.sqliteNonEmpty && table === 'states' ? [{ word_id: 'w' }] : [] })); return } cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
  return txs
}
describe('task-329 R6 hard gate', () => {
  it('SQLite 255/1 + IDB 2 logs：skipped 零 tx，logs 不减少', async () => {
    await resetDatabase(); await persistLearningWriteSource('idb')
    const deck = await createDeck({ name: 'h1', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    await getDb().reviewLogs.bulkAdd([{ wordId: 'a', deckId: deck.id, reviewedAt: 1, rating: 'familiar' }, { wordId: 'a', deckId: deck.id, reviewedAt: 2, rating: 'familiar' }] as never)
    const txs = install({ sqliteNonEmpty: true })
    const result = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => ({ ok: true }) })
    expect(result.mode).toBe('skipped'); expect(txs).toHaveLength(0)
  })
  it('SQLite 255/1 + IDB 791 logs：skipped 零 tx', async () => {
    await resetDatabase(); await persistLearningWriteSource('idb')
    const deck = await createDeck({ name: 'h2', words: [{ headword: 'b', meanings: [{ cn: '义' }] }] })
    const logs = Array.from({ length: 791 }, (_, i) => ({ wordId: 'b', deckId: deck.id, reviewedAt: i, rating: 'familiar' }))
    await getDb().reviewLogs.bulkAdd(logs as never)
    const txs = install({ sqliteNonEmpty: true })
    const result = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => ({ ok: true }) })
    expect(result.mode).toBe('skipped'); expect(txs).toHaveLength(0)
  })
  it('SQLite 全 0 + 无 durable marker：允许迁移（产生 tx）', async () => {
    await resetDatabase(); await persistLearningWriteSource('idb')
    const deck = await createDeck({ name: 'h3', words: [{ headword: 'c', meanings: [{ cn: '义' }] }] })
    await getDb().reviewLogs.bulkAdd([{ wordId: 'c', deckId: deck.id, reviewedAt: 1, rating: 'familiar' }] as never)
    const txs = install({ sqliteNonEmpty: false, durable: false })
    const result = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => ({ ok: true }) })
    expect(result.mode).not.toBe('skipped')
    expect(txs.length).toBeGreaterThan(0)
  })
  it('模拟升级：SQLite 已有行且 durable：零 tx、不减少', async () => {
    await resetDatabase(); await persistLearningWriteSource('idb')
    const deck = await createDeck({ name: 'h4', words: [{ headword: 'd', meanings: [{ cn: '义' }] }] })
    await getDb().reviewLogs.bulkAdd([{ wordId: 'd', deckId: deck.id, reviewedAt: 1, rating: 'familiar' }] as never)
    const txs = install({ sqliteNonEmpty: false, durable: true })
    const result = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => ({ ok: true }) })
    expect(result.mode).toBe('skipped'); expect(txs).toHaveLength(0)
  })
})
