import './test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../src/data/builtin', () => ({ ensureBuiltinDecks: async () => { throw new Error('mock seed fail') }, ensureBuiltinDeckWords: async () => ({ added: 0, issues: [] }) }))
import { getDb, rebuildContentCacheFromSqlite, resetDatabase, setSqliteTransport } from '../../src/data'
import { persistContentWriteSource } from '../../src/data/content-write-source'
afterEach(async () => { setSqliteTransport(null); await persistContentWriteSource('idb') })
describe('C2 seed fail', () => {
  it('seed 抛错→rebuild false 且旧 cache 保留', async () => {
    await resetDatabase(); await persistContentWriteSource('sqlite')
    const db = getDb(); await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready' }, updatedAt: Date.now() })
    await db.decks.put({ id: 'old', name: 'old', source: 'custom', wordCount: 0, version: 1, isDefault: false, createdAt: 1, updatedAt: 1 } as never)
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: 0, revision: 1 })); else cb?.(id, JSON.stringify({ ok: true, rows: [], hasMore: false, revision: 1 })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await rebuildContentCacheFromSqlite()
    expect(result.ok).toBe(false)
    expect(await db.decks.get('old')).toBeTruthy()
  })
})
