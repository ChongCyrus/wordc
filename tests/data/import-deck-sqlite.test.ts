import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeck, exportDeck, getDb, importDeckFile, persistLearningWriteSource, resetDatabase, setSqliteTransport } from '../../src/data'

function install(rows: unknown[] = []) {
  let seq = 0
  setSqliteTransport({ sqliteCall(json: string) {
    const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string } }
    const id = `${req.id}-r${++seq}`
    setTimeout(() => {
      const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
      if (req.method === 'query') cb?.(id, JSON.stringify({ ok: true, rows: req.payload?.table === 'states' ? rows : [] }))
      else cb?.(id, JSON.stringify({ ok: true }))
    }, 0)
    return JSON.stringify({ requestId: id })
  } } as never)
}
afterEach(async () => { setSqliteTransport(null); await persistLearningWriteSource('idb') })

async function deckText() {
  await resetDatabase()
  const deck = await createDeck({ name: 'deckimport', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
  const blob = await exportDeck(deck.id)
  return { id: deck.id, text: await blob.text() }
}

describe('rc15 deck sqlite import', () => {
  it('新词库：写 IDB decks/words，不写 IDB states', async () => {
    const { id, text } = await deckText()
    await getDb().decks.delete(id)
    await getDb().words.where('deckId').equals(id).delete()
    await persistLearningWriteSource('sqlite')
    install([])
    const report = await importDeckFile(text, { preBackup: async () => ({ ok: true }) })
    expect(report.ok).toBe(true)
    expect(await getDb().decks.get(id)).toBeTruthy()
    expect(await getDb().words.where('deckId').equals(id).count()).toBe(1)
    expect(await getDb().states.where('deckId').equals(id).count()).toBe(0)
  })
  it('已有词库拒绝覆盖', async () => {
    const { text } = await deckText()
    await persistLearningWriteSource('sqlite')
    install([])
    await expect(importDeckFile(text, { preBackup: async () => ({ ok: true }) })).rejects.toThrow(/E_UNSUPPORTED/)
  })
})
