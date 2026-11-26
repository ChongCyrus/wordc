import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteFactsBackup, resetDatabase, setSqliteTransport, SQLITE_SCHEMA_VERSION } from '../../src/data'
afterEach(() => setSqliteTransport(null))
function mock(nativeReviewLogs: number | null) {
  const state = { backupCalls: 0, deleteCalls: 0, manifests: [] as Array<Record<string, unknown>> }; let seq = 0
  setSqliteTransport({ sqliteCall(json: string) {
    const req = JSON.parse(json) as { id: string; method: string; payload?: { name?: string; manifest?: string } }; const id = `${req.id}-r${++seq}`
    setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
      if (req.method === 'health') { cb?.(id, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 241, plans: 1, settings: 13, review_logs: 791 }, readOnly: false, integrityOk: true, bytes: 100 })); return }
      if (req.method === 'backup') { state.backupCalls += 1; cb?.(id, JSON.stringify({ ok: true, name: req.payload?.name, path: `/p/${req.payload?.name}`, bytes: 4096, integrityOk: true, ...(nativeReviewLogs != null ? { counts: { states: 241, plans: 1, settings: 13, reviewLogs: nativeReviewLogs } } : {}) })); return }
      if (req.method === 'deleteBackup') { state.deleteCalls += 1; cb?.(id, JSON.stringify({ ok: true })); return }
      if (req.method === 'writeBackupManifest') { state.manifests.push(JSON.parse(String(req.payload?.manifest)) as Record<string, unknown>); cb?.(id, JSON.stringify({ ok: true })); return }
      cb?.(id, JSON.stringify({ ok: true, rows: [] }))
    }, 0); return JSON.stringify({ requestId: id })
  } })
  return state
}
describe('task-326 R6 backup manifest counts', () => {
  it('native 741 / health 791 → 不登记，重试后失败', async () => {
    await resetDatabase()
    const state = mock(741)
    const result = await createSqliteFactsBackup()
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/不一致|counts/)
    expect(state.backupCalls).toBe(2)
    expect(state.deleteCalls).toBeGreaterThanOrEqual(1)
    expect(state.manifests).toHaveLength(0)
  })
  it('native 791 / health 791 → manifest counts 791', async () => {
    await resetDatabase()
    const state = mock(791)
    const result = await createSqliteFactsBackup()
    expect(result.ok).toBe(true)
    expect(result.manifest?.counts.reviewLogs).toBe(791)
    expect(state.manifests).toHaveLength(1)
    expect((state.manifests[0]!.counts as Record<string, number>).reviewLogs).toBe(791)
  })
  it('native 未返回 counts → 回退 health 并写 diag', async () => {
    await resetDatabase()
    const state = mock(null)
    const result = await createSqliteFactsBackup()
    expect(result.ok).toBe(true)
    expect(result.manifest?.counts.reviewLogs).toBe(791)
    expect(state.manifests).toHaveLength(1)
    const diag = (await (await import('../../src/data')).getDb().meta.get('sqliteBackup.createDiag'))?.value as { warning?: string }
    expect(diag?.warning).toMatch(/回退 health/)
  })
})
