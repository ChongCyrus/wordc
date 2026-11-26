import './test-utils'
import { primeLegacySqliteContentSource } from './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeck, ensureRootEtymologyPreinstall, getDb, resetDatabase, restoreSqliteFactsBackup, setSqliteTransport } from '../../src/data'
afterEach(() => setSqliteTransport(null))
describe('task-321 R4 preinstall vs restoreDb mutual exclusion', () => {
  it('preinstall 批次 in-flight 时 restore 等锁；无 E_CONFLICT，restoreDb 在批次完成后才执行', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'r4', words: [{ headword: 'r4word', meanings: [{ cn: '义' }] }] })
    const db = getDb(); const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    await primeLegacySqliteContentSource()
    const events: string[] = []
    let releaseWrite: () => void = () => undefined
    const writeGate = new Promise<void>((resolve) => { releaseWrite = resolve })
    let contentWriteStarted = false
    let seq = 0
    setSqliteTransport({ sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`
      const reply = (payload: unknown) => setTimeout(() => (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult?.(id, JSON.stringify(payload)), 0)
      if (req.method === 'contentCounts') { reply({ ok: true, total: 0, deleted: 0, byKind: {}, revision: 0 }); return JSON.stringify({ requestId: id }) }
      if (req.method === 'contentWrite') { contentWriteStarted = true; events.push('contentWrite-start'); void writeGate.then(() => { events.push('contentWrite-end'); reply({ ok: true, revision: 1 }) }); return JSON.stringify({ requestId: id }) }
      if (req.method === 'backup') { reply({ ok: true, name: 'safety.db', path: '/p/safety.db', bytes: 4096, integrityOk: true }); return JSON.stringify({ requestId: id }) }
      if (req.method === 'health') { reply({ ok: true, userVersion: 3, counts: { states: 1, plans: 0, settings: 0, review_logs: 0 }, readOnly: false, integrityOk: true, wal: true, synchronous: 'FULL' }); return JSON.stringify({ requestId: id }) }
      if (req.method === 'restoreDb') { events.push('restoreDb'); reply({ ok: true }); return JSON.stringify({ requestId: id }) }
      if (req.method === 'integrity') { reply({ ok: true, integrityOk: true }); return JSON.stringify({ requestId: id }) }
      reply({ ok: true, rows: [] }); return JSON.stringify({ requestId: id })
    } })
    const bundleText = JSON.stringify({ format: 'momo-root-etymology-bundle', formatVersion: 1, version: '0.3.98', createdAt: 1, generator: 'test', counts: { items: 1 }, items: [{ wordId: word.id, headword: 'r4word', deckId: deck.id, rootEtymology: { parts: [{ type: 'root', text: 'r4', meaning: '义' }], source: 'ai', updatedAt: 2 } }] })
    const preinstallPromise = ensureRootEtymologyPreinstall({ bundleText, force: true, repairMissingDecks: false, chunkSize: 200 })
    while (!contentWriteStarted) await new Promise((resolve) => setTimeout(resolve, 5))
    const restorePromise = restoreSqliteFactsBackup({ path: '/p/target.db' }, { preBackup: async () => ({ ok: true }), skipPostRestoreCacheRebuild: true })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(events).not.toContain('restoreDb') // preinstall 持锁，restore 尚未换库
    releaseWrite()
    const [preinstall, restored] = await Promise.all([preinstallPromise, restorePromise])
    expect(preinstall.ok).toBe(true)
    expect(restored.ok).toBe(true)
    expect(events.filter((e) => e === 'restoreDb')).toHaveLength(1)
    expect(events.indexOf('contentWrite-end')).toBeLessThan(events.indexOf('restoreDb'))
  }, 60000)
})
