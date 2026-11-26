import { primeLegacySqliteContentSource } from './test-utils'
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { getDb, rebuildContentCacheFromSqlite, resetDatabase, setSqliteTransport } from '../../src/data'
import { persistContentWriteSource } from '../../src/data/content-write-source'
afterEach(async () => { setSqliteTransport(null); await persistContentWriteSource('idb') })
async function prep() {
  await resetDatabase(); await primeLegacySqliteContentSource()
  const db = getDb(); await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready' }, updatedAt: Date.now() })
  let seq = 0
  setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: 1, revision: 1 })); else if (req.method === 'contentList') cb?.(id, JSON.stringify({ ok: true, hasMore: false, revision: 1, rows: [{ key: 'pack:x', kind: 'pack', json: JSON.stringify({ id: 'x', name: 'x', kind: 'custom', status: 'applied', itemCount: 0, appliedCount: 0, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 1, deleted: 0 }] })); else cb?.(id, JSON.stringify({ ok: true })) }, 0); return JSON.stringify({ requestId: id }) } })
  return db
}
describe('0.14 cache rebuild hooks', () => {
  it('C2 counts 不一致→false + restore 调用', async () => {
    await prep()
    let restored = 0
    const result = await rebuildContentCacheFromSqlite({ testHooks: { seed: async () => undefined, applyRows: async () => undefined, restoreCache: async () => { restored += 1 } } })
    expect(result.ok).toBe(false)
    expect(restored).toBe(1)
  })
  it('C6 restore 抛错→error 含 rollbackError + diag', async () => {
    const db = await prep()
    const result = await rebuildContentCacheFromSqlite({ testHooks: { seed: async () => undefined, applyRows: async () => { throw new Error('apply fail') }, restoreCache: async () => { throw new Error('restore fail') } } })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/rollbackError|restore fail|旧 cache 恢复失败/)
    expect((await db.meta.get('contentCacheRebuild.diag'))?.value).toMatchObject({ ok: false })
  })
})
