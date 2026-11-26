import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { restoreSqliteFactsBackup, setSqliteTransport } from '../../src/data'

afterEach(() => setSqliteTransport(null))

const manifest = {
  format: 'momo-sqlite-backup-manifest' as const,
  formatVersion: 1 as const,
  name: 'b.db',
  path: '/p/b.db',
  bytes: 4096,
  createdAt: 1,
  userVersion: 3,
  dataEpoch: 1,
  counts: { states: 1, plans: 0, settings: 0, reviewLogs: 0 },
  integrityOk: true,
}

function install(opts: { backupBytes?: number; mode?: 'ok' | 'native-throw' | 'counts-mismatch' } = {}) {
  let seq = 0
  let restoreCalls = 0
  const attemptedPaths: string[] = []
  let targetRestored = false
  setSqliteTransport({
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: { path?: string } }
      const id = `${req.id}-r${++seq}`
      if (req.method === 'restoreDb') attemptedPaths.push(String(req.payload?.path ?? ''))
      if (req.method === 'restoreDb' && opts.mode === 'native-throw' && req.payload?.path === '/p/b.db') {
        throw new Error('native restore boom')
      }
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') {
          const states = opts.mode === 'counts-mismatch' && targetRestored ? 2 : 1
          cb?.(id, JSON.stringify({ ok: true, userVersion: 3, counts: { states, plans: 0, settings: 0, review_logs: 0 }, integrityOk: true, readOnly: false }))
          return
        }
        if (req.method === 'backup') {
          cb?.(id, JSON.stringify({ ok: true, bytes: opts.backupBytes ?? 4096, name: 'sqlite-backup-safety.db', path: '/p/safety.db', checksum: 'x' }))
          return
        }
        if (req.method === 'restoreDb') {
          restoreCalls += 1
          if (req.payload?.path === '/p/b.db') targetRestored = true
          cb?.(id, JSON.stringify({ ok: true }))
          return
        }
        if (req.method === 'integrity') cb?.(id, JSON.stringify({ ok: true, integrityOk: true }))
        else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { get restoreCalls() { return restoreCalls }, attemptedPaths }
}

describe('P0-2 restore safety snapshot', () => {
  it('安全快照失败直接拒绝，不调用 restoreDb', async () => {
    const mock = install({ backupBytes: 0 })
    const result = await restoreSqliteFactsBackup({ manifest }, { preBackup: async () => ({ ok: true }) })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/安全快照/)
    expect(mock.restoreCalls).toBe(0)
  })

  it('native restore 异常时回滚安全快照', async () => {
    const mock = install({ mode: 'native-throw' })
    const result = await restoreSqliteFactsBackup({ manifest }, { preBackup: async () => ({ ok: true }) })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/已回滚/)
    expect(mock.restoreCalls).toBe(1)
    expect(mock.attemptedPaths).toEqual(['/p/b.db', '/p/safety.db'])
  })

  it('恢复后 counts 不一致时回滚安全快照', async () => {
    const mock = install({ mode: 'counts-mismatch' })
    const result = await restoreSqliteFactsBackup({ manifest }, { preBackup: async () => ({ ok: true }) })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/已回滚/)
    expect(mock.restoreCalls).toBe(2)
  })
})
