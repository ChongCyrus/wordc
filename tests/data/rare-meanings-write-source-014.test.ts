import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDeck,
  getDb,
  resetDatabase,
  setRareCoreSenses,
  setRareMeaningIds,
  setSqliteTransport,
} from '../../src/data'
afterEach(() => setSqliteTransport(null))

function mock(fail = false) {
  let rev = 0
  let seq = 0
  let writes = 0
  setSqliteTransport({ sqliteCall(json: string) {
    const req = JSON.parse(json) as { id: string; method: string }
    const id = `${req.id}-r${++seq}`
    setTimeout(() => {
      const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
      if (req.method === 'contentWrite') {
        writes += 1
        if (fail) { cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock fail' })); return }
        rev += 1
        cb?.(id, JSON.stringify({ ok: true, revision: rev }))
        return
      }
      if (req.method === 'contentCounts') { cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision: rev })); return }
      cb?.(id, JSON.stringify({ ok: true, rows: [] }))
    }, 0)
    return JSON.stringify({ requestId: id })
  } })
  return () => writes
}

async function makeWord() {
  const deck = await createDeck({ name: 'rare-write', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }, { cn: '乙' }] }] })
  const db = getDb()
  const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
  return { word, meaningId: word.meanings[0]!.id }
}

describe('0.14 rare-meanings SQLite 写源', () => {
  it('sqlite 成功→contentWrite 调用且 cache 更新', async () => {
    await resetDatabase()
    const { word, meaningId } = await makeWord()
    await persistContentWriteSource('sqlite')
    const writes = mock(false)
    const next = await setRareMeaningIds(word.id, [meaningId])
    expect(next).toEqual([meaningId])
    expect(writes()).toBeGreaterThan(0)
    expect((await getDb().words.get(word.id))?.rareMeaningIds).toEqual([meaningId])
  })

  it('sqlite 失败→抛错且 IDB 旧值不变', async () => {
    await resetDatabase()
    const { word, meaningId } = await makeWord()
    await persistContentWriteSource('sqlite')
    mock(true)
    await expect(setRareMeaningIds(word.id, [meaningId])).rejects.toThrow(/失败|fail|SQLite/)
    expect((await getDb().words.get(word.id))?.rareMeaningIds).toBeUndefined()
  })

  it('idb 模式行为不变：不调用 contentWrite，仍写 IDB', async () => {
    await resetDatabase()
    const { word, meaningId } = await makeWord()
    await persistContentWriteSource('idb')
    const writes = mock(false)
    await setRareMeaningIds(word.id, [meaningId])
    expect(writes()).toBe(0)
    expect((await getDb().words.get(word.id))?.rareMeaningIds).toEqual([meaningId])
  })

  it('rareCoreSenses 也走同一写源', async () => {
    await resetDatabase()
    const { word } = await makeWord()
    await persistContentWriteSource('sqlite')
    const writes = mock(false)
    await setRareCoreSenses(word.id, [{ coreSenseIndex: 1, label: '本义' }])
    expect(writes()).toBeGreaterThan(0)
    expect((await getDb().words.get(word.id))?.rareCoreSenses?.[0]?.label).toBe('本义')
  })
})
