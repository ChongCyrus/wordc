import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { preflightSqliteRestore, resetDatabase, restoreSqliteFactsBackup, setSqliteTransport, SQLITE_SCHEMA_VERSION } from '../../src/data'
import { waitForContentMigrationQuiescent } from '../../src/data/content-migration-plan'
afterEach(() => setSqliteTransport(null))
describe('task-321 R4 gates', () => {
  it('迁移 running 时 quiescent 超时拒绝', async () => {
    await resetDatabase()
    const mod = await import('../../src/data/content-write-source')
    // 让 v15 状态 running：写 IDB mirror
    const { getDb } = await import('../../src/data')
    await getDb().meta.put({ key: mod.CONTENT_MIGRATION_V15_KEY, value: { status: 'running', at: 1 }, updatedAt: 1 })
    const result = await waitForContentMigrationQuiescent({ timeoutMs: 1_000 })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/迁移进行中/)
  })
  it('preflight 拒绝 states=0 manifest', async () => {
    const result = await preflightSqliteRestore({ format: 'momo-sqlite-backup-manifest', formatVersion: 1, name: 'empty', bytes: 4096, createdAt: 1, userVersion: SQLITE_SCHEMA_VERSION, dataEpoch: 0, counts: { states: 0, plans: 0, settings: 0, reviewLogs: 0 }, integrityOk: true })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/states=0|空库/)
  })
  it('当前库为空但目标备份有效 → 允许空 safety 并恢复成功', async () => {
    await resetDatabase()
    let restored = false
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`
      const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
      setTimeout(() => {
        if (req.method === 'restoreDb') { restored = true; cb?.(id, JSON.stringify({ ok: true })); return }
        if (req.method === 'backup') { cb?.(id, JSON.stringify({ ok: true, name: 's.db', path: '/p/s.db', bytes: 4096, integrityOk: true })); return }
        if (req.method === 'integrity') { cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); return }
        if (req.method === 'health') { const counts = restored ? { states: 255, plans: 1, settings: 2, review_logs: 791 } : { states: 0, plans: 0, settings: 2, review_logs: 0 }; cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts, readOnly: false, integrityOk: true, wal: true, synchronous: 'FULL' })); return }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0); return JSON.stringify({ requestId: id })
    } })
    const manifest = { format: 'momo-sqlite-backup-manifest' as const, formatVersion: 1 as const, name: 'target', path: '/p/target.db', bytes: 4096, createdAt: 1, userVersion: SQLITE_SCHEMA_VERSION, dataEpoch: 1, counts: { states: 255, plans: 1, settings: 2, reviewLogs: 791 }, integrityOk: true }
    const result = await restoreSqliteFactsBackup({ manifest }, { preBackup: async () => ({ ok: true }), skipPostRestoreCacheRebuild: true })
    expect(result.ok).toBe(true)
    expect(restored).toBe(true)
  })
})

describe('task-321 R4 wrapper deadlock guard', () => {
  it('迁移 running 时 wrapper 在拿锁前快速拒绝，不调用 restoreDb', async () => {
    await resetDatabase()
    const mod = await import('../../src/data/content-write-source')
    const { getDb } = await import('../../src/data')
    await getDb().meta.put({ key: mod.CONTENT_MIGRATION_V15_KEY, value: { status: 'running', at: 1 }, updatedAt: 1 })
    let restoreDbCalls = 0
    setSqliteTransport({ sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r`; const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
      if (req.method === 'restoreDb') restoreDbCalls += 1
      setTimeout(() => cb?.(id, JSON.stringify({ ok: true, rows: [] })), 0); return JSON.stringify({ requestId: id })
    } })
    const started = Date.now()
    const result = await restoreSqliteFactsBackup({ path: '/p/target.db' }, { preBackup: async () => ({ ok: true }), quiescentTimeoutMs: 200 })
    expect(result.ok).toBe(false)
    expect(result.blockedBy).toBe('content-migration')
    expect(restoreDbCalls).toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})
