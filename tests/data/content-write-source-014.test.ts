import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeck, getDb, getSettings, resetDatabase, saveWordOverlay, setSqliteTransport, updateSettings } from '../../src/data'
afterEach(() => setSqliteTransport(null))
function mock(fail = false) {
  let rev = 0; let seq = 0; let writes = 0
  setSqliteTransport({ sqliteCall(json: string) {
    const req = JSON.parse(json) as { id: string; method: string }; const id = `${req.id}-r${++seq}`
    setTimeout(() => { const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
      if (req.method === 'contentWrite') { writes += 1; if (fail) { cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'fail' })); return } rev += 1; cb?.(id, JSON.stringify({ ok: true, revision: rev })); return }
      if (req.method === 'contentCounts') { cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision: rev })); return }
      cb?.(id, JSON.stringify({ ok: true, rows: [] }))
    }, 0); return JSON.stringify({ requestId: id })
  } })
  return () => writes
}
describe('0.14 content write source root/notes', () => {
  it('sqlite 成功→IDB cache 同步；失败→不写 IDB', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'c', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    const db = getDb(); const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    await persistContentWriteSource('sqlite')
    mock(false)
    await saveWordOverlay({ ...word, rootEtymology: { parts: [{ type: 'root', text: 'ok' }] }, updatedAt: 2 } as never)
    expect((await db.words.get(word.id))?.rootEtymology).toBeTruthy()
    mock(true)
    await expect(saveWordOverlay({ ...word, rootEtymology: { parts: [{ type: 'root', text: 'bad' }] }, updatedAt: 3 } as never)).rejects.toThrow(/fail|SQLite 内容写入失败/)
    expect((await db.words.get(word.id))?.rootEtymology).toBeTruthy()
    expect((await getSettings())['data.contentWriteSource']).toBe('sqlite')
  })
})

describe('0.14 contentWriteSource protected', () => {
  it('updateSettings 直写被拒绝；switch 内部允许', async () => {
    await resetDatabase()
    await expect(updateSettings({ 'data.contentWriteSource': 'sqlite' })).rejects.toThrow(/switchContentWriteSource/)
    await persistContentWriteSource('idb')
  })
})
