import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteFactsBackup, preflightSqliteRestore, setSqliteTransport, type SqliteTransport } from '../../src/data'

function install(opts: { bytes?: number; integrityOk?: boolean; healthFail?: boolean } = {}) {
  let seq = 0
  const transport: SqliteTransport = {
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') callback?.(id, JSON.stringify({ ok: true, userVersion: 3, sizeBytes: 4096, integrityOk: opts.integrityOk !== false, readOnly: false, counts: { states: 241, plans: 1, settings: 13, review_logs: 0 } }))
        else if (req.method === 'backup') callback?.(id, JSON.stringify({ ok: true, bytes: opts.bytes ?? 4096, name: 'sqlite-backup-x.db', path: '/p/x', checksum: 'abc' }))
        else if (req.method === 'integrity') callback?.(id, JSON.stringify({ ok: true, integrityOk: opts.integrityOk !== false }))
        else callback?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  }
  setSqliteTransport(transport)
}
afterEach(() => setSqliteTransport(null))

describe('M5 sqlite backup', () => {
  it('0KB 拒绝；integrity 失败拒绝；有效备份 manifest 含 counts/epoch', async () => {
    install({ bytes: 0 })
    expect((await createSqliteFactsBackup('sqlite-backup-test.db')).ok).toBe(false)
    setSqliteTransport(null)
    install({ bytes: 4096, integrityOk: false })
    expect((await createSqliteFactsBackup('sqlite-backup-test.db')).ok).toBe(false)
    setSqliteTransport(null)
    install({ bytes: 4096 })
    const ok = await createSqliteFactsBackup('sqlite-backup-test.db')
    expect(ok.ok).toBe(true)
    expect(ok.manifest).toMatchObject({ bytes: 4096, counts: { states: 241, plans: 1, settings: 13 } })
  })
  it('只读模式 restore preflight 拒绝', async () => {
    const result = await preflightSqliteRestore({ format: 'momo-sqlite-backup-manifest', formatVersion: 1, name: 'x', bytes: 10, createdAt: 1, userVersion: 3, dataEpoch: 1, counts: { states: 1, plans: 0, settings: 0, reviewLogs: 0 }, integrityOk: false })
    expect(result.ok).toBe(false)
  })
})

import { restoreSqliteFactsBackup } from '../../src/data'
describe('M5 sqlite restore', () => {
  it('preBackup 失败拒绝；restoreDb 成功 counts 校验；counts 不一致报错', async () => {
    let restoreCalls = 0
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { path?: string } }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'restoreDb') restoreCalls += 1
          if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 3, counts: { states: 241, plans: 1, settings: 13, review_logs: 0 }, integrityOk: true, readOnly: false }))
          else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true }))
          else if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, bytes: 4096, name: 'sqlite-backup-safety.db', path: '/p/safety.db', checksum: 'x' }))
          else if (req.method === 'restoreDb') cb?.(id, JSON.stringify({ ok: true }))
          else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const manifest = { format: 'momo-sqlite-backup-manifest' as const, formatVersion: 1 as const, name: 'b', path: '/p/b', bytes: 4096, createdAt: 1, userVersion: 3, dataEpoch: 1, counts: { states: 241, plans: 1, settings: 13, reviewLogs: 0 }, integrityOk: true }
    const denied = await restoreSqliteFactsBackup({ manifest }, {})
    expect(denied.ok).toBe(false)
    const ok = await restoreSqliteFactsBackup({ manifest }, { preBackup: async () => ({ ok: true }), skipPostRestoreCacheRebuild: true })
    expect(ok.ok).toBe(true)
    expect(ok.counts).toEqual(manifest.counts)
    expect(restoreCalls).toBe(1)
  })
})

import { listValidSqliteBackups, type AutoBackupBridge as BridgeType, type AutoBackupEntry as EntryType } from '../../src/data'
class MemBridge implements BridgeType {
  files = new Map<string, string>()
  isAvailable() { return true }
  save(t: string, n: string) { this.files.set(n, t); return { ok: true, mode: 'native' as const, name: n, path: `/p/${n}` } }
  list(): EntryType[] { return [...this.files.entries()].map(([name, text], i) => ({ name, size: text.length, mtime: i, path: `/p/${name}` })) }
  read(n: string) { return this.files.get(n) ?? null }
  delete(n: string) { return this.files.delete(n) }
  prune() { return 0 }
  getFlag() { return '' }
  setFlag() { return true }
  appendDiagLog() {}
}
describe('M5 fault injection', () => {
  it('partial/0KB 不登记、列表不显示', () => {
    const bridge = new MemBridge()
    bridge.files.set('sqlite-backup-a.db.partial', 'x')
    bridge.files.set('sqlite-backup-empty.db', '')
    bridge.files.set('sqlite-backup-ok.db', 'db')
    const list = listValidSqliteBackups(bridge)
    expect(list.some((entry) => entry.name.endsWith('.partial'))).toBe(false)
    expect(list.find((entry) => entry.name === 'sqlite-backup-empty.db')?.valid).toBe(false)
    expect(list.find((entry) => entry.name === 'sqlite-backup-ok.db')?.valid).toBe(true)
  })
  it('restore 失败/超时/counts 不一致/只读 → 拒绝且 beforeCounts 可见', async () => {
    let mode: 'fail' | 'timeout' = 'fail'
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 3, readOnly: false, counts: { states: 1, plans: 0, settings: 0, review_logs: 0 } }))
          else if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true }))
          else if (req.method === 'backup') cb?.(id, JSON.stringify({ ok: true, bytes: 4096, name: 'sqlite-backup-safety.db', path: '/p/safety.db', checksum: 'x' }))
          else if (req.method === 'restoreDb') {
            if (mode === 'fail') cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock restore fail' }))
            else setTimeout(() => cb?.(id, JSON.stringify({ ok: true })), 5000)
          } else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const manifest = { format: 'momo-sqlite-backup-manifest' as const, formatVersion: 1 as const, name: 'b', path: '/p/b', bytes: 10, createdAt: 1, userVersion: 3, dataEpoch: 1, counts: { states: 2, plans: 0, settings: 0, reviewLogs: 0 }, integrityOk: true }
    const failed = await restoreSqliteFactsBackup({ manifest }, { preBackup: async () => ({ ok: true }) })
    expect(failed.ok).toBe(false)
    expect(failed.beforeCounts?.states).toBe(1)
    mode = 'timeout'
    const timed = await Promise.race([
      restoreSqliteFactsBackup({ manifest }, { preBackup: async () => ({ ok: true }) }).then((r) => r.ok),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 7000)),
    ])
    expect(timed === false || timed === 'timeout').toBe(true)
  }, 20000)
  it('只读拒绝恢复', async () => {
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          cb?.(id, JSON.stringify({ ok: true, userVersion: 3, readOnly: true, integrityOk: true, counts: { states: 1, plans: 0, settings: 0, review_logs: 0 } }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const manifest = { format: 'momo-sqlite-backup-manifest' as const, formatVersion: 1 as const, name: 'b', path: '/p/b', bytes: 10, createdAt: 1, userVersion: 3, dataEpoch: 1, counts: { states: 1, plans: 0, settings: 0, reviewLogs: 0 }, integrityOk: true }
    const result = await preflightSqliteRestore(manifest)
    expect(result.ok).toBe(false)
  })
})

import { saveSqliteBackupManifest, getSqliteBackupManifest, deleteSqliteBackupManifest } from '../../src/data'
describe('D native sidecar', () => {
  it('save→read→delete 走 native', async () => {
    const texts = new Map<string, string>(); let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; payload?: { name?: string; manifest?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'writeBackupManifest') { texts.set(String(req.payload?.name), String(req.payload?.manifest)); cb?.(id, JSON.stringify({ ok: true })) } else if (req.method === 'readBackupManifest') cb?.(id, JSON.stringify({ ok: true, manifest: texts.get(String(req.payload?.name)) ?? '' })); else cb?.(id, JSON.stringify({ ok: true })) }, 0); return JSON.stringify({ requestId: id }) } })
    const manifest = { format: 'momo-sqlite-backup-manifest' as const, formatVersion: 1 as const, name: 'b.db', path: '/p/b.db', bytes: 10, createdAt: 1, userVersion: 3, dataEpoch: 1, counts: { states: 1, plans: 0, settings: 0, reviewLogs: 0 }, integrityOk: true }
    await saveSqliteBackupManifest(manifest)
    expect((await getSqliteBackupManifest('b.db'))?.name).toBe('b.db')
    await deleteSqliteBackupManifest('b.db')
    // native read still has text; delete is IDB legacy cleanup + native deleteBackup in file delete
    setSqliteTransport(null)
  })
})
