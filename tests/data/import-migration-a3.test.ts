import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInitialState, createDeck, exportMigrationText, getLearningWriteSource, importMigration, persistLearningWriteSource, resetDatabase, updateSettings } from '../../src/data'
async function makeMigration() {
  await resetDatabase()
  const deck = await createDeck({ name: 'a3', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = (await import('../../src/data')).getDb()
  const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
  await db.states.put({ ...buildInitialState(word, 1), phase: 'review' })
  return exportMigrationText()
}
afterEach(async () => { await persistLearningWriteSource('idb') })
describe('A3 staging import', () => {
  it('成功：clear→migrate→rebuild→health counts，写源 sqlite', async () => {
    const text = await makeMigration(); await persistLearningWriteSource('sqlite')
    const calls: string[] = []
    const impl = {
      createBackup: (async () => ({ ok: true, manifest: { format: 'momo-sqlite-backup-manifest', formatVersion: 1, name: 'b', bytes: 1, createdAt: 1, userVersion: 2, dataEpoch: 0, counts: { states: 1, plans: 0, settings: 1, reviewLogs: 0 }, integrityOk: true } })) as never,
      clearFacts: (async () => { calls.push('clear') }) as never,
      migrate: (async () => { calls.push('migrate'); return { ok: true, dryRun: false, counts: { states: 1, plans: 0, settings: 1, reviewLogs: 0 }, batches: 1 } }) as never,
      rebuildCache: (async () => { calls.push('rebuild'); return { ok: true, dryRun: false, delta: { states: 0, plans: 0, settings: 0, reviewLogs: 0 }, cacheCounts: { states: 1, plans: 0, settings: 1, reviewLogs: 0 }, sqliteCounts: { states: 1, plans: 0, settings: 1, reviewLogs: 0 } } }) as never,
      health: async () => ({ ok: true, counts: { states: 1, plans: 0, settings: 1, review_logs: 0 } }),
    }
    const report = await importMigration(text, { strategy: 'replace', preBackup: async () => ({ ok: true }), sqliteStageImpl: impl })
    expect(report.ok).toBe(true)
    expect(calls).toEqual(['clear', 'migrate', 'rebuild'])
    expect(getLearningWriteSource()).toBe('sqlite')
  })
  it('失败：restoreBackup 调用、写源 idb、IDB 保留', async () => {
    const text = await makeMigration(); await persistLearningWriteSource('sqlite')
    const calls: string[] = []
    const impl = {
      createBackup: (async () => ({ ok: true, manifest: { format: 'momo-sqlite-backup-manifest', formatVersion: 1, name: 'b', bytes: 1, createdAt: 1, userVersion: 2, dataEpoch: 0, counts: { states: 1, plans: 0, settings: 1, reviewLogs: 0 }, integrityOk: true } })) as never,
      clearFacts: (async () => undefined) as never,
      migrate: (async () => ({ ok: false, dryRun: false, counts: { states: 1, plans: 0, settings: 1, reviewLogs: 0 }, batches: 1, error: 'mock migrate fail' })) as never,
      restoreBackup: (async () => { calls.push('restore'); return { ok: true } }) as never,
      health: async () => ({ ok: true, counts: { states: 1, plans: 0, settings: 1, review_logs: 0 } }),
    }
    await expect(importMigration(text, { strategy: 'replace', preBackup: async () => ({ ok: true }), sqliteStageImpl: impl })).rejects.toThrow(/mock migrate fail/)
    expect(calls).toContain('restore')
    expect(getLearningWriteSource()).toBe('idb')
  })
})

import { setSqliteTransport } from '../../src/data'
describe('A3 staging clear scope', () => {
  it('默认 clear 只清 states/plans/review_logs，不碰 migration_state/client_ops', async () => {
    const text = await makeMigration(); await persistLearningWriteSource('sqlite')
    const tables: string[] = []
    const txOps: unknown[][] = []
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) { const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }; const id = `${req.id}-r${++seq}`; setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult; if (req.method === 'tx') { txOps.push(req.ops ?? []); cb?.(id, JSON.stringify({ ok: true })) } else { const table = String(req.payload?.table ?? ''); tables.push(table); const key = table === 'states' ? 'word_id' : 'id'; cb?.(id, JSON.stringify({ ok: true, rows: [{ [key]: 'x' }] })) } }, 0); return JSON.stringify({ requestId: id }) } })
    const impl = {
      createBackup: (async () => ({ ok: true, manifest: { format: 'momo-sqlite-backup-manifest', formatVersion: 1, name: 'b', bytes: 1, createdAt: 1, userVersion: 2, dataEpoch: 0, counts: { states: 1, plans: 0, settings: 1, reviewLogs: 0 }, integrityOk: true } })) as never,
      migrate: (async () => ({ ok: true, dryRun: false, counts: { states: 1, plans: 0, settings: 1, reviewLogs: 0 }, batches: 1 })) as never,
      rebuildCache: (async () => ({ ok: true, dryRun: false, delta: { states: 0, plans: 0, settings: 0, reviewLogs: 0 }, cacheCounts: { states: 0, plans: 0, settings: 0, reviewLogs: 0 }, sqliteCounts: { states: 0, plans: 0, settings: 0, reviewLogs: 0 } })) as never,
      health: async () => { const db = (await import('../../src/data')).getDb(); return { ok: true, counts: { states: await db.states.count(), plans: await db.plans.count(), settings: await db.settings.count(), review_logs: await db.reviewLogs.count() } } },
    }
    const report = await importMigration(text, { strategy: 'replace', preBackup: async () => ({ ok: true }), sqliteStageImpl: impl })
    expect(report.ok).toBe(true)
    expect(tables).not.toContain('migration_state')
    expect(tables).not.toContain('client_ops')
    const deletedTables = txOps.flat().map((op) => (op as { table?: string }).table)
    expect(deletedTables).not.toContain('migration_state')
    expect(deletedTables).not.toContain('client_ops')
    setSqliteTransport(null)
  })
})
