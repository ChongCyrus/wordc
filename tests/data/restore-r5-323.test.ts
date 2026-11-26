import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { isRestorableBackup, listValidSqliteBackupFiles, resetDatabase, restoreSqliteFactsBackup, setSqliteTransport, SQLITE_SCHEMA_VERSION } from '../../src/data'
import type { SqliteBackupManifest } from '../../src/data/sqlite-backup'
afterEach(() => setSqliteTransport(null))
const manifest = (states: number, name = 'sqlite-backup-x.db'): SqliteBackupManifest => ({ format: 'momo-sqlite-backup-manifest', formatVersion: 1, name, path: `/p/${name}`, bytes: 4096, createdAt: 1, userVersion: SQLITE_SCHEMA_VERSION, dataEpoch: 0, counts: { states, plans: 0, settings: 0, reviewLogs: 0 }, integrityOk: true })
describe('task-323 R5 candidates', () => {
  it('isRestorableBackup 只认 states>0/integrity/bytes', () => {
    expect(isRestorableBackup(manifest(255))).toBe(true)
    expect(isRestorableBackup(manifest(0))).toBe(false)
    expect(isRestorableBackup({ ...manifest(255), integrityOk: false })).toBe(false)
    expect(isRestorableBackup({ ...manifest(255), bytes: 0 })).toBe(false)
  })
  it('safety/auto 不进候选；manual valid 保留', async () => {
    await resetDatabase()
    const rows = [{ name: 'sqlite-safety-1.db', size: 4096, mtime: 3, path: '/p/s' }, { name: 'sqlite-auto-backup-1.db', size: 4096, mtime: 2, path: '/p/a' }, { name: 'sqlite-backup-1.db', size: 4096, mtime: 1, path: '/p/m' }]
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; payload?: { name?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'listBackups') cb?.(id, JSON.stringify({ ok: true, backups: rows })); else if (req.method === 'readBackupManifest') cb?.(id, JSON.stringify({ ok: true, manifest: JSON.stringify(manifest(255, String(req.payload?.name))) })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const files = await listValidSqliteBackupFiles()
    expect(files.map((file) => file.name)).toEqual(['sqlite-backup-1.db'])
    expect(files[0]?.valid).toBe(true)
  })
  it('当前库为空但目标备份 states>0：allowEmptyCurrent 允许恢复', async () => {
    await resetDatabase()
    let seq = 0
    let restored = false
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, name: 'sqlite-safety-x.db', path: '/p/s.db', bytes: 4096, integrityOk: true })); else if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: restored ? 255 : 0, plans: 0, settings: 0, review_logs: 0 }, readOnly: false, integrityOk: true, wal: true, synchronous: 'FULL' })); else if (req.method === 'restoreDb') { restored = true; cb?.(id, JSON.stringify({ ok: true })) } else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await restoreSqliteFactsBackup({ path: '/p/target.db', manifest: manifest(255) }, { preBackup: async () => ({ ok: true }), allowEmptyCurrent: true, skipPostRestoreCacheRebuild: true })
    expect(result.ok).toBe(true)
  })
})
