import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeck, ensureLegacyIdbMigratedToSqlite, persistLearningWriteSource, resetDatabase, setSqliteTransport, SQLITE_SCHEMA_VERSION } from '../../src/data'
afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb').catch(() => undefined) })
function mock(empty: boolean) {
  let seq = 0; const txs: unknown[][] = []
  setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'health') { cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: empty ? { states: 0, plans: 0, settings: 0, review_logs: 0 } : { states: 255, plans: 1, settings: 13, review_logs: 791 }, readOnly: false, integrityOk: true })); return } if (req.method === 'tx') { txs.push(req.ops ?? []); cb?.(id, JSON.stringify({ ok: true })); return } if (req.method === 'query' && req.payload?.table === 'migration_state') { cb?.(id, JSON.stringify({ ok: true, rows: [{ step: 'legacy-idb', status: 'done' }] })); return } cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
  return txs
}
describe('task-328 durable marker prevents IDB downgrade', () => {
  it('health 临时 0 但 migration_state=done：拒绝 IDB 迁移，不写 SQLite', async () => {
    await resetDatabase(); await createDeck({ name: 'r6a', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] }); await persistLearningWriteSource('idb')
    const txs = mock(true)
    const result = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => ({ ok: true }) })
    expect(result.mode).toBe('skipped')
    expect(result.error).toMatch(/迁移完成标记|拒绝 IDB 覆盖/)
    expect(txs).toHaveLength(0)
  })
  it('SQLite 已有 255/1/791 且 IDB 仅 2 logs：不迁移/不清 logs', async () => {
    await resetDatabase(); await createDeck({ name: 'r6b', words: [{ headword: 'b', meanings: [{ cn: '义' }] }] }); await persistLearningWriteSource('idb')
    const txs = mock(false)
    const result = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => ({ ok: true }) })
    expect(result.mode).toBe('skipped')
    expect(txs).toHaveLength(0)
  })
})
