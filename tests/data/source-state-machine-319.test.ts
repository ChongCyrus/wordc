import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { getLearningWriteSource, persistLearningWriteSource, resetDatabase, shouldReloadForSourceRecovery } from '../../src/data'
afterEach(async () => { await persistLearningWriteSource('idb').catch(() => undefined) })
describe('task-319 source state machine', () => {
  it('shouldReload 至多一次，且 readonly 不刷', () => {
    expect(shouldReloadForSourceRecovery('idb', 'sqlite', false)).toBe(true)
    expect(shouldReloadForSourceRecovery('idb', 'sqlite', true)).toBe(false)
    expect(shouldReloadForSourceRecovery('sqlite', 'readonly', false)).toBe(false)
    expect(shouldReloadForSourceRecovery('sqlite', 'sqlite', false)).toBe(false)
  })
  it('readonly 迁移必须持久化 meta，且受控回退 idb 合法', async () => {
    await resetDatabase()
    await persistLearningWriteSource('sqlite')
    await persistLearningWriteSource('readonly')
    expect(getLearningWriteSource()).toBe('readonly')
    await persistLearningWriteSource('idb')
    expect(getLearningWriteSource()).toBe('idb')
  })
})

import { requestSourceRecovery } from '../../src/data'
describe('task-319 single owner', () => {
  it('并发 requestSourceRecovery 合流且 meta=内存', async () => {
    await resetDatabase()
    const [a, b] = await Promise.all([requestSourceRecovery('a'), requestSourceRecovery('b')])
    expect(a).toBe(b)
    const meta = await (await import('../../src/data')).getDb().meta.get('data.learningWriteSource')
    const value = (meta?.value as { source?: string } | undefined)?.source
    expect(value).toBe(a)
    expect((await import('../../src/data')).getLearningWriteSource()).toBe(a)
  })
})

import { restoreSqliteFactsBackup, setSqliteTransport, clearIdbCacheDirty, getIdbCacheMeta, SQLITE_SCHEMA_VERSION } from '../../src/data'
describe('task-319 R3 restore cache clean', () => {
  it('restore 成功后 cache clean；立即再 restore 仍 sqlite/clean', async () => {
    await resetDatabase()
    let restores = 0; let seq = 0; let restored = false
    setSqliteTransport({ sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`
      setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'backup') { cb?.(id, JSON.stringify({ ok: true, name: 'safety.db', path: '/p/safety.db', bytes: 4096, integrityOk: true })); return }
        if (req.method === 'restoreDb') { restores += 1; restored = true; cb?.(id, JSON.stringify({ ok: true })); return }
        if (req.method === 'health') { cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: restored ? 0 : 1, plans: 0, settings: 0, review_logs: 0 }, readOnly: false, integrityOk: true, wal: true, synchronous: 'FULL' })); return }
        if (req.method === 'integrity') { cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); return }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0); return JSON.stringify({ requestId: id })
    } })
    await clearIdbCacheDirty({ generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false })
    const first = await restoreSqliteFactsBackup({ path: '/p/empty.db' }, { preBackup: async () => ({ ok: true }) })
    expect(first.ok).toBe(true)
    expect((await getIdbCacheMeta())?.dirty).toBe(false)
    expect((await import('../../src/data')).getLearningWriteSource()).toBe('sqlite')
    const second = await restoreSqliteFactsBackup({ path: '/p/empty.db' }, { preBackup: async () => ({ ok: true }) })
    // R5：当前库为空但目标备份 states>0 时允许恢复（空库直接填充），第二次也应成功
    expect(second.ok).toBe(true)
    expect(restores).toBe(2)
    expect((await getIdbCacheMeta())?.dirty).toBe(false)
    expect((await import('../../src/data')).getLearningWriteSource()).toBe('sqlite')
    setSqliteTransport(null)
  }, 60000)
})
