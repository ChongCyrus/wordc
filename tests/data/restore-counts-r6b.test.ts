import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupOldPlans, createSqliteFactsBackup, getDb, getSqliteBackupManifest, resetDatabase, restoreSqliteFactsBackup, setSqliteTransport, SQLITE_SCHEMA_VERSION, withDataWriteLock } from '../../src/data'
afterEach(() => setSqliteTransport(null))
const baseManifest = (states: number, plans: number) => ({ format: 'momo-sqlite-backup-manifest' as const, formatVersion: 1 as const, name: 'b', path: '/p/b', bytes: 4096, createdAt: 1, userVersion: SQLITE_SCHEMA_VERSION, dataEpoch: 0, counts: { states, plans, settings: 0, reviewLogs: 0 }, integrityOk: true })
describe('task-327 R6 counts/startup locks', () => {
  it('plans 差异不阻断（跨日 cleanup 合法改 plan 数）', async () => {
    await resetDatabase(); let seq = 0; let restored = false
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, name: 'sqlite-safety-x.db', path: '/p/s', bytes: 4096, integrityOk: true })); else if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: restored ? 1 : 0, plans: restored ? 0 : 0, settings: 0, review_logs: 0 }, readOnly: false, integrityOk: true })); else if (req.method === 'restoreDb') { restored = true; cb?.(id, JSON.stringify({ ok: true })); } else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await restoreSqliteFactsBackup({ path: '/p/t', manifest: baseManifest(1, 1) }, { preBackup: async () => ({ ok: true }), allowEmptyCurrent: true, skipPostRestoreCacheRebuild: true })
    console.log('PLANRES', result)
    expect(result.ok).toBe(true)
  })
  it('states 差异仍严格拒绝并回滚', async () => {
    await resetDatabase(); let seq = 0; let restored = false; let rollback = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, name: 'sqlite-safety-x.db', path: '/p/s', bytes: 4096, integrityOk: true })); else if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: restored ? 0 : 0, plans: 0, settings: 0, review_logs: 0 }, readOnly: false, integrityOk: true })); else if (req.method === 'restoreDb') { if (restored) rollback += 1; else restored = true; cb?.(id, JSON.stringify({ ok: true })); } else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await restoreSqliteFactsBackup({ path: '/p/t', manifest: baseManifest(1, 0) }, { preBackup: async () => ({ ok: true }), allowEmptyCurrent: true, skipPostRestoreCacheRebuild: true })
    expect(result.ok).toBe(false)
    expect(rollback).toBe(1)
  })
  it('getSqliteBackupManifest native 空串 → null，不回退陈旧 IDB', async () => {
    await resetDatabase()
    await getDb().meta.put({ key: 'sqliteBackup.manifest:old.db', value: baseManifest(999, 0), updatedAt: 1 })
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'readBackupManifest') cb?.(id, JSON.stringify({ ok: true, manifest: '' })); else cb?.(id, JSON.stringify({ ok: true })) }, 0); return JSON.stringify({ requestId: id }) } })
    expect(await getSqliteBackupManifest('old.db')).toBeNull()
  })
  it('native counts 支持 snake_case review_logs', async () => {
    await resetDatabase(); let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; payload?: { name?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 241, plans: 1, settings: 13, review_logs: 791 }, readOnly: false, integrityOk: true })); else if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, name: req.payload?.name, path: '/p/b', bytes: 4096, integrityOk: true, counts: { states: 241, plans: 1, settings: 13, review_logs: 791 } })); else cb?.(id, JSON.stringify({ ok: true })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await createSqliteFactsBackup()
    expect(result.ok).toBe(true)
    expect(result.manifest?.counts.reviewLogs).toBe(791)
  })
  it('cleanupOldPlans 在写锁内排队', async () => {
    await resetDatabase()
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holder = withDataWriteLock(() => gate)
    let cleaned = false
    const cleanup = cleanupOldPlans({ keepDays: 0 }).then(() => { cleaned = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(cleaned).toBe(false)
    release()
    await holder
    await cleanup
    expect(cleaned).toBe(true)
  })
})
