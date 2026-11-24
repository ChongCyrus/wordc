import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { buildInitialState, clearAllData, createDeck, getDb, persistLearningWriteSource, resetDatabase, setSqliteTransport, updateSettings } from '../../src/data'

function install(failTx = false) {
  let seq = 0
  const ops: unknown[][] = []
  setSqliteTransport({
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') { cb?.(id, JSON.stringify({ ok: true, userVersion: 2, counts: { states: 0, plans: 0, settings: 0, review_logs: 0 }, readOnly: false, integrityOk: true })); return }
        if (req.method === 'integrity') { cb?.(id, JSON.stringify({ ok: true, integrityOk: true })); return }
        if (req.method === 'tx') { ops.push(req.ops ?? []); cb?.(id, JSON.stringify(failTx ? { ok: false, code: 'E_IO', message: 'mock tx fail' } : { ok: true })); return }
        const table = req.payload?.table
        const row = table === 'states' ? { word_id: 's1' } : table === 'plans' ? { id: 'p1' } : table === 'settings' ? { key: 'k1' } : table === 'review_logs' ? { id: 1 } : table === 'client_ops' ? { op_id: 'o1' } : table === 'migration_state' ? { step: 'legacy-idb' } : {}
        cb?.(id, JSON.stringify({ ok: true, rows: [row] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { ops }
}
async function seed() {
  await resetDatabase()
  const deck = await createDeck({ name: 'clear-a1', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
  await getDb().states.put({ ...buildInitialState(word, 1), phase: 'review' })
  return { deck, word }
}
afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb') })
describe('A1 clear sqlite mode', () => {
  it('preBackup 一次；先清 IDB 后单 tx 清 SQLite；清后双空', async () => {
    await seed(); await persistLearningWriteSource('sqlite')
    const mock = install()
    let backups = 0
    await clearAllData({ preBackup: async () => { backups += 1; return { ok: true } } })
    expect(backups).toBe(1)
    expect(mock.ops).toHaveLength(1)
    expect(mock.ops[0]!.some((op) => (op as { table?: string }).table === 'states')).toBe(true)
    expect(await getDb().states.count()).toBe(0)
    expect(await getDb().settings.count()).toBe(0)
    expect(await getDb().words.count()).toBe(0)
  })
  it('SQLite 清空失败：尝试重建 IDB 后抛错', async () => {
    await seed(); await persistLearningWriteSource('sqlite')
    install(true)
    await expect(clearAllData({ preBackup: async () => ({ ok: true }) })).rejects.toThrow(/SQLite 清空失败/)
  })
  it('preBackup 失败：拒绝且 IDB 未清', async () => {
    await seed(); await persistLearningWriteSource('sqlite')
    install(true)
    await expect(clearAllData({ preBackup: async () => ({ ok: false, error: 'mock' }) })).rejects.toThrow(/预备份失败/)
    expect(await getDb().states.count()).toBe(1)
  })
})
