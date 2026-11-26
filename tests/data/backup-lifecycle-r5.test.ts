import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { clearAllData, getDb, getLearningWriteSource, persistLearningWriteSource, resetDatabase, restoreSqliteFactsBackup, runAutoBackup, setSqliteTransport, SQLITE_SCHEMA_VERSION, type AutoBackupBridge, type AutoBackupEntry } from '../../src/data'
afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb') })
class Bridge implements AutoBackupBridge {
  files = new Map<string, { size: number; mtime: number }>(); seq = 0; flags = new Map<string, string>(); diag: string[] = []
  isAvailable() { return true }
  save(_text: string, name: string) { this.files.set(name, { size: 10, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name, path: name } }
  list(): AutoBackupEntry[] { return [...this.files.entries()].map(([name, f]) => ({ name, size: f.size, mtime: f.mtime, path: name })) }
  read() { return null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag(key: string) { return this.flags.get(key) ?? '' }
  setFlag(key: string, value: string) { this.flags.set(key, value); return true }
  appendDiagLog(text: string) { this.diag.push(text) }
}
describe('task-323 R5 lifecycle', () => {
  it('clearAllData 成功清理 sqlite-safety，不动手动 sqlite-backup', async () => {
    await resetDatabase(); await persistLearningWriteSource('sqlite')
    const deleted: string[] = []; let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; payload?: { name?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, name: 'sqlite-safety-1.db', path: '/p/s.db', bytes: 4096, integrityOk: true })); else if (req.method === 'deleteBackup') { deleted.push(String(req.payload?.name)); cb?.(id, JSON.stringify({ ok: true })); } else if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 1, plans: 0, settings: 0, review_logs: 0 }, readOnly: false, integrityOk: true })); else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    await clearAllData({ preBackup: async () => ({ ok: true }) })
    expect(deleted).toContain('sqlite-safety-1.db')
    expect(deleted.some((name) => name.startsWith('sqlite-backup-') && !name.startsWith('sqlite-backup-manual'))).toBe(false)
    expect(getLearningWriteSource()).toBe('sqlite')
  })
  it('auto 备份可见且 prune 保留 7 份', async () => {
    await resetDatabase(); await persistLearningWriteSource('sqlite')
    const bridge = new Bridge()
    for (let i = 0; i < 9; i += 1) bridge.files.set(`sqlite-auto-backup-${i}.db`, { size: 10, mtime: i + 1 })
    const backups = new Map<string, { name: string; path: string; bytes: number; integrityOk: boolean }>(); let seq = 0
    let deleted = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; payload?: { name?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'backup') { const name = String(req.payload?.name); backups.set(name, { name, path: `/p/${name}`, bytes: 4096, integrityOk: true }); bridge.files.set(name, { size: 4096, mtime: 100 }); cb?.(id, JSON.stringify({ ok: true, name, path: `/p/${name}`, bytes: 4096, integrityOk: true })); } else if (req.method === 'listBackups') cb?.(id, JSON.stringify({ ok: true, backups: [...bridge.files.keys()].map((name) => ({ name, path: `/p/${name}`, size: 4096, mtime: bridge.files.get(name)!.mtime })) })); else if (req.method === 'deleteBackup') { deleted += 1; bridge.files.delete(String(req.payload?.name)); cb?.(id, JSON.stringify({ ok: true })); } else if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 1, plans: 0, settings: 0, review_logs: 0 }, readOnly: false, integrityOk: true })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const result = await runAutoBackup(bridge, { force: true })
    expect(result.mode).toBe('backed-up')
    expect(deleted).toBeGreaterThanOrEqual(3)
    const autoLeft = [...bridge.files.keys()].filter((name) => name.startsWith('sqlite-auto-backup-')).length
    expect(autoLeft).toBe(7) // 原有 9 + 新 1 =10，保留7（含新备份）
  })
  it('restore.diag 写目标 manifest 字段；settings 差异不阻断', async () => {
    await resetDatabase(); await persistLearningWriteSource('sqlite'); let seq = 0; let restored = false
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, name: 'sqlite-safety-x.db', path: '/p/s.db', bytes: 4096, integrityOk: true })); else if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: restored ? 1 : 0, plans: 0, settings: 999, review_logs: 0 }, readOnly: false, integrityOk: true })); else if (req.method === 'restoreDb') { restored = true; cb?.(id, JSON.stringify({ ok: true })); } else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); else cb?.(id, JSON.stringify({ ok: true, rows: [] })) }, 0); return JSON.stringify({ requestId: id }) } })
    const manifest = { format: 'momo-sqlite-backup-manifest' as const, formatVersion: 1 as const, name: 'sqlite-backup-t.db', path: '/p/t', bytes: 4096, createdAt: 1, userVersion: SQLITE_SCHEMA_VERSION, dataEpoch: 0, counts: { states: 1, plans: 0, settings: 0, reviewLogs: 0 }, integrityOk: true }
    const ok = await restoreSqliteFactsBackup({ path: '/p/t', manifest }, { preBackup: async () => ({ ok: true }), allowEmptyCurrent: true, skipPostRestoreCacheRebuild: true })
    expect(ok.ok).toBe(true) // settings 实际999 vs manifest0 不阻断
    const empty = await restoreSqliteFactsBackup({ path: '/p/t', manifest: { ...manifest, counts: { ...manifest.counts, states: 0 } } }, { preBackup: async () => ({ ok: true }) })
    expect(empty.ok).toBe(false)
    expect((await getDb().meta.get('restore.diag'))?.value).toMatchObject({ error: expect.stringMatching(/states=0|空库/) })
  })
})
