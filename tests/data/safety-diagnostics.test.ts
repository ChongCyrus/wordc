/** 0.10.0：数据安全诊断包 gather（只读） */
import './test-utils'
import { describe, expect, it } from 'vitest'
import {
  buildInitialState,
  createDeck,
  gatherDataSafetyDiagnostics,
  getDb,
  resetDatabase,
  saveStateCheckpoint,
  serializeSafetyDiagnostics,
  updateSettings,
  type AutoBackupBridge,
  type AutoBackupEntry,
} from '../../src/data'

class FakeBridge implements AutoBackupBridge {
  files = new Map<string, string>()
  isAvailable() { return true }
  save(text: string, name: string) { this.files.set(name, text); return { ok: true, mode: 'native' as const, name, path: `/p/${name}` } }
  list(): AutoBackupEntry[] { return [...this.files.entries()].map(([name, text], index) => ({ name, size: text.length, mtime: index + 1, path: `/p/${name}` })) }
  read(name: string) { return this.files.get(name) ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag() { return '' }
  setFlag() { return true }
  appendDiagLog() {}
}

describe('0.10.0 · safety diagnostics', () => {
  it('gather counts/epoch/checkpoint/backup/diag/storage', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'diag', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()
    const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    await db.states.put({ ...buildInitialState(word, Date.now()), phase: 'review' })
    await db.meta.put({ key: 'diag.lastWordMutation', value: { reason: 'test', removed: 1 }, updatedAt: Date.now() })
    const bridge = new FakeBridge()
    await saveStateCheckpoint(bridge)
    bridge.files.set('auto-backup-2026-11-23.migration.json.gz', 'x')
    const pkg = await gatherDataSafetyDiagnostics({
      bridge,
      appVersion: '0.10.0',
      diagLogs: Array.from({ length: 25 }, (_, i) => `log-${i}`),
      errors: ['e1'],
    })
    expect(pkg.format).toBe('momo-data-safety-diagnostics')
    expect(pkg.counts).toMatchObject({ decks: 1, words: 1, states: 1 })
    expect(pkg.dataEpoch).toBe(0)
    expect(pkg.checkpoint).toMatchObject({ latest: true })
    expect(pkg.backups.some((backup) => backup.name.startsWith('auto-backup'))).toBe(true)
    expect(pkg.lastWordMutation).toMatchObject({ reason: 'test' })
    expect(pkg.diagLogs).toHaveLength(20)
    expect(pkg.diagLogs.at(-1)).toBe('log-24')
    expect(pkg.errors).toEqual(['e1'])
    expect(JSON.parse(serializeSafetyDiagnostics(pkg)).format).toBe('momo-data-safety-diagnostics')
  })
})
