import { primeLegacySqliteContentSource } from './test-utils'
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { finalizeContentWriteCoverage, getDb, getContentMigrationState, rebuildContentCacheFromSqlite, resetDatabase, setSqliteTransport } from '../../src/data'
import { persistContentWriteSource } from '../../src/data/content-write-source'
afterEach(async () => { setSqliteTransport(null); await persistContentWriteSource('idb') })
function counts(total: number) { let seq = 0; setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total, revision: 3 })); else if (req.method === 'contentList') cb?.(id, JSON.stringify({ ok: true, rows: [], hasMore: false, revision: 3 })); else cb?.(id, JSON.stringify({ ok: true })) }, 0); return JSON.stringify({ requestId: id }) } }) }
describe('0.14 finalize coverage', () => {
  it('未 ready→false；ready+空 counts→false；ready+counts→true', async () => {
    await resetDatabase()
    const db = getDb()
    expect((await finalizeContentWriteCoverage()).ok).toBe(false)
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'failed' }, updatedAt: Date.now() })
    expect((await finalizeContentWriteCoverage()).ok).toBe(false)
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready' }, updatedAt: Date.now() })
    counts(0)
    expect((await finalizeContentWriteCoverage()).ok).toBe(false)
    counts(2)
    expect((await finalizeContentWriteCoverage()).ok).toBe(true)
    expect((await getContentMigrationState())?.writeCoverageComplete).toBe(true)
  })
  it('stale IDB 指纹→false', async () => {
    await resetDatabase(); counts(2)
    const db = getDb()
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready', idbFingerprint: { version: 1, counts: { decks: 999 }, hash: 'stale' } }, updatedAt: Date.now() })
    expect((await finalizeContentWriteCoverage()).ok).toBe(false)
  })
  it('C2 overlay counts 不一致→失败并恢复旧 cache', async () => {
    await resetDatabase(); await primeLegacySqliteContentSource(); counts(0)
    const db = getDb()
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready' }, updatedAt: Date.now() })
    await db.decks.put({ id: 'old', name: 'old', source: 'custom', wordCount: 1, version: 1, isDefault: false, createdAt: 1, updatedAt: 1 } as never)
    await db.words.put({ id: 'old:w', deckId: 'old', headword: 'w', headwordLower: 'w', meanings: [{ id: 'm', cn: '义' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1, createdAt: 1, updatedAt: 1 } as never)
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: 1, revision: 1 })); else if (req.method === 'contentList') cb?.(id, JSON.stringify({ ok: true, hasMore: false, revision: 1, rows: [{ key: 'pack:bad', kind: 'pack', json: 'not-json', updated_at: 1, revision: 1, deleted: 0 }] })); else cb?.(id, JSON.stringify({ ok: true })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await rebuildContentCacheFromSqlite()
    expect(result.ok).toBe(false)
    expect(await db.words.get('old:w')).toBeTruthy()
  })
})
