import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { CONTENT_MIGRATION_STATE_KEY, getDb, rebuildContentCacheFromSqlite, resetDatabase, setSqliteTransport } from '../../src/data'
import { persistContentWriteSource } from '../../src/data/content-write-source'
afterEach(() => setSqliteTransport(null))
function mock(rows: Array<Record<string, unknown>>) {
  setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: rows.length, deleted: 0, byKind: {}, revision: 10 })); else if (req.method === 'contentList') cb?.(id, JSON.stringify({ ok: true, revision: 10, rows, hasMore: false })); else cb?.(id, JSON.stringify({ ok: true })) }, 0); return JSON.stringify({ requestId: id }) } })
}
describe('0.14 cache rebuild order/packs', () => {
  it('custom word+overlay 保留；已应用 pack 保留；删除 pack 不复活', async () => {
    await resetDatabase()
    const db = getDb()
    await persistContentWriteSource('sqlite')
    await db.meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status: 'ready', writeCoverageComplete: true, revision: 10, written: 6 }, updatedAt: 1 })
    await db.decks.put({ id: 'custom', name: 'c', source: 'custom', wordCount: 1, version: 1, isDefault: false, createdAt: 1, updatedAt: 1 } as never)
    await db.words.put({ id: 'custom:w', deckId: 'custom', headword: 'w', headwordLower: 'w', meanings: [{ id: 'm', cn: '义' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1, createdAt: 1, updatedAt: 1 } as never)
    mock([
      { key: 'deck:custom', kind: 'deck', json: JSON.stringify({ id: 'custom', name: 'c', source: 'custom', wordCount: 1, version: 1, isDefault: false, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 1, deleted: 0 },
      { key: 'word:custom:w', kind: 'word', json: JSON.stringify({ id: 'custom:w', deckId: 'custom', headword: 'w', headwordLower: 'w', meanings: [{ id: 'm', cn: '义' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 2, deleted: 0 },
      { key: 'word-overlay:custom:w', kind: 'word-overlay', json: JSON.stringify({ rootEtymology: { parts: [{ type: 'root', text: 'keep' }] }, updatedAt: 9 }), updated_at: 9, revision: 3, deleted: 0 },
      { key: 'pack:applied', kind: 'pack', json: JSON.stringify({ id: 'applied', name: 'A', kind: 'custom', status: 'applied', itemCount: 1, appliedCount: 1, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 4, deleted: 0 },
      { key: 'pack-item:applied-i', kind: 'pack-item', json: JSON.stringify({ id: 'applied-i', packId: 'applied', status: 'applied', headwordLower: 'ai', createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 5, deleted: 0 },
      { key: 'pack:deleted', kind: 'pack', json: 'null', updated_at: 9, revision: 6, deleted: 1 },
    ])
    const result = await rebuildContentCacheFromSqlite()
    expect(result.ok).toBe(true)
    expect((await db.words.get('custom:w'))?.rootEtymology).toBeTruthy()
    expect(await db.packs.get('applied')).toBeTruthy()
    expect(await db.packs.get('deleted')).toBeUndefined()
  }, 60000)
})

describe('C3 pagination guard', () => {
  it('hasMore 且 added=0 抛错，不截断', async () => {
    await resetDatabase(); await persistContentWriteSource('sqlite')
    const db = getDb(); await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready' }, updatedAt: Date.now() })
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: 1, revision: 2 })); else cb?.(id, JSON.stringify({ ok: true, revision: 2, rows: [], hasMore: true })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await rebuildContentCacheFromSqlite()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/分页无进展|截断/)
  })
})
