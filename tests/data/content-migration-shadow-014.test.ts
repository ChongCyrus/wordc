import './test-utils'
import { primeIdbCacheReady } from './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { describe, expect, it } from 'vitest'
import { canSwitchContentWriteSource, createDeck, getDb, getSettings, resetDatabase, runContentMigrationShadow, setSqliteTransport, switchContentWriteSource } from '../../src/data'
describe('0.14 shadow migration', () => {
  it('preflight+batches+state，不切源；失败不切源', async () => {
    await resetDatabase(); await primeIdbCacheReady()
    await createDeck({ name: 'shadow', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    let backups = 0
    const ok = await runContentMigrationShadow({ preBackup: async () => { backups += 1; return { ok: true } }, write: async (rows) => ({ ok: true, revision: rows.length }) })
    expect(ok.ok).toBe(true)
    expect(backups).toBe(1)
    expect((await getSettings())['data.contentWriteSource'] ?? 'idb').toBe('idb')
    expect((await getDb().meta.get('contentMigrationState'))?.value).toMatchObject({ status: 'ready', writeCoverageComplete: false })
    expect((await canSwitchContentWriteSource()).ok).toBe(false)
    expect((await switchContentWriteSource()).ok).toBe(false)
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; cb?.(id, JSON.stringify(req.method === 'contentCounts' ? { ok: true, total: 1, deleted: 0, byKind: {}, revision: 1 } : { ok: true, rows: [], hasMore: false, revision: 1 })) }, 0); return JSON.stringify({ requestId: id }) } })
    expect((await canSwitchContentWriteSource()).ok).toBe(true)
    expect((await switchContentWriteSource()).ok).toBe(true)
    expect((await getSettings())['data.contentWriteSource']).toBe('sqlite')
    await persistContentWriteSource('idb')
    const fail = await runContentMigrationShadow({ preBackup: async () => ({ ok: false, error: 'no' }) })
    expect(fail.ok).toBe(false)
    expect((await getSettings())['data.contentWriteSource'] ?? 'idb').toBe('idb')
  })
})
