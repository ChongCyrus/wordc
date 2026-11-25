import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { afterEach, describe, expect, it } from 'vitest'
import {
  applyCoreSenseMnemonicImportParsed,
  createDeck,
  getDb,
  resetDatabase,
  setSqliteTransport,
} from '../../src/data'
import type { CoreSenseMnemonicPreviewReport } from '../../src/data/core-sense-mnemonics'

afterEach(() => setSqliteTransport(null))

function mockSqlite(fail = false) {
  let revision = 0
  let seq = 0
  let writes = 0
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, json: string) => void }).__momoSqliteResult
        if (req.method === 'contentCounts') {
          cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision }))
          return
        }
        if (req.method === 'contentWrite') {
          writes += 1
          if (fail) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock fail' }))
            return
          }
          revision += 1
          cb?.(id, JSON.stringify({ ok: true, revision, upserts: 1, tombstones: 0, deletes: 0 }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return () => writes
}

function preview(wordId: string): CoreSenseMnemonicPreviewReport {
  return {
    ok: true,
    counts: {
      words: 1,
      wordsMatched: 1,
      sensesImported: 0,
      overviewsImported: 1,
      skippedExisting: 0,
      skippedManual: 0,
      stale: 0,
      emptySkipped: 0,
      unresolvedWords: 0,
    },
    issues: [],
    parsed: {
      file: { format: 'wordc-core-sense-mnemonics', version: 1, exportedAt: 1, words: [], senses: [] },
      senses: [],
      overviews: [{ wordId, text: 'SQLITE 本义助记', source: 'ai', updatedAt: 2 }],
    },
  }
}

describe('0.14 core-sense mnemonic SQLite write source', () => {
  it('sqlite 成功→写 contentWrite 并更新 IDB cache；失败→抛错且 IDB 不变', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'core', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const db = getDb()
    const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    await persistContentWriteSource('sqlite')

    const writes = mockSqlite(false)
    const okReport = await applyCoreSenseMnemonicImportParsed(preview(word.id))
    expect(okReport.ok).toBe(true)
    expect(writes()).toBeGreaterThan(0)
    expect((await db.words.get(word.id))?.coreSenseOverview?.text).toBe('SQLITE 本义助记')

    mockSqlite(true)
    await expect(
      applyCoreSenseMnemonicImportParsed(preview(word.id), { overwrite: true }),
    ).rejects.toMatchObject({ code: 'CONTENT_SQLITE_WRITE_FAILED' })
    expect((await db.words.get(word.id))?.coreSenseOverview?.text).toBe('SQLITE 本义助记')
  })
})
