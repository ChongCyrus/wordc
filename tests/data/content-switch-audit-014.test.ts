import './test-utils'
import { primeIdbCacheReady } from './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { canSwitchContentWriteSource, getContentMigrationState, reconcileInterruptedContentMigration, resetDatabase, resetContentWriteSourceForImport, switchContentWriteSource, getSettings, setSqliteTransport } from '../../src/data'
import { persistContentWriteSource } from '../../src/data/content-write-source'
afterEach(async () => { setSqliteTransport(null); await persistContentWriteSource('idb') })
function store(total = 0) { let seq = 0; setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total, deleted: 0, byKind: {}, revision: 7 })); else cb?.(id, JSON.stringify({ ok: true, rows: [], hasMore: false, revision: 7 })) }, 0); return JSON.stringify({ requestId: id }) } }) }
describe('0.14 audit-switch', () => {
  it('reset import → idb + 清迁移状态', async () => {
    await resetDatabase(); await primeIdbCacheReady(); await persistContentWriteSource('sqlite')
    await resetContentWriteSourceForImport()
    expect((await getSettings())['data.contentWriteSource']).toBe('idb')
    expect(await getContentMigrationState()).toBeNull()
  })
  it('running→reconcile failed+idb', async () => {
    await resetDatabase(); await primeIdbCacheReady(); await persistContentWriteSource('sqlite')
    await (await import('../../src/data')).getDb().meta.put({ key: 'contentMigrationState', value: { status: 'running', token: 't' }, updatedAt: Date.now() })
    const result = await reconcileInterruptedContentMigration()
    expect(result.rescued).toBe(true)
    expect((await getContentMigrationState())?.status).toBe('failed')
    expect((await getSettings())['data.contentWriteSource']).toBe('idb')
  })
  it('switch coverage/counts 门禁', async () => {
    await resetDatabase(); await primeIdbCacheReady(); store(5)
    const db = (await import('../../src/data')).getDb()
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false }, updatedAt: Date.now() })
    expect((await canSwitchContentWriteSource()).ok).toBe(false)
    expect((await switchContentWriteSource()).ok).toBe(false)
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    expect((await switchContentWriteSource()).ok).toBe(true)
    expect((await getSettings())['data.contentWriteSource']).toBe('sqlite')
  })
})

import { rebuildContentCacheFromSqlite, runContentMigrationFormal } from '../../src/data'
import { getIdbCacheMeta } from '../../src/data/idb-cache'
describe('audit-switch remaining', () => {
  it('formal ready 但 counts=0 → 重跑（非 idempotent）', async () => {
    await resetDatabase(); await primeIdbCacheReady(); store(0)
    const db = (await import('../../src/data')).getDb()
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    const result = await runContentMigrationFormal()
    expect(result.idempotent).not.toBe(true)
  })
  it('cache 重建 contentList 失败 → dirty+diag', async () => {
    await resetDatabase(); await primeIdbCacheReady(); await persistContentWriteSource('sqlite')
    const db = (await import('../../src/data')).getDb()
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: 2, revision: 5 })); else cb?.(id, JSON.stringify({ ok: false, message: 'mock list fail' })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await rebuildContentCacheFromSqlite()
    expect(result.ok).toBe(false)
    expect((await getIdbCacheMeta())?.dirty).toBe(true)
    expect((await db.meta.get('contentCacheRebuild.diag'))?.value).toMatchObject({ ok: false })
  })
})
