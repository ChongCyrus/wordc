import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { hashContentValue } from '../../src/data/content-snapshot'
import {
  CONTENT_MIGRATION_STATE_KEY,
  getDb,
  getSettings,
  rebuildContentCacheFromSqlite,
  resetDatabase,
  setSqliteTransport,
  switchContentWriteSource,
} from '../../src/data'

afterEach(() => setSqliteTransport(null))

const ROWS = [
  { key: 'deck:custom', kind: 'deck', json: JSON.stringify({ id: 'custom', name: 'C', source: 'custom', wordCount: 1, version: 1, isDefault: false, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 1, deleted: 0 },
  { key: 'word:custom:w', kind: 'word', json: JSON.stringify({ id: 'custom:w', deckId: 'custom', headword: 'w', headwordLower: 'w', meanings: [{ id: 'm', cn: '义' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 2, deleted: 0 },
  { key: 'word-overlay:custom:w', kind: 'word-overlay', json: JSON.stringify({ rootEtymology: { parts: [{ type: 'root', text: 'keep', meaning: '保持' }], etymology: 'QA_RESTART' }, updatedAt: 2 }), updated_at: 2, revision: 3, deleted: 0 },
  { key: 'content-reject:r1', kind: 'content-reject', json: JSON.stringify({ id: 'r1', kind: 'examples', headwordLower: 'w', hash: 'h', rejectedAt: 1 }), updated_at: 1, revision: 4, deleted: 0 },
]

function mockKv() {
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string }
      const id = `${req.id}-r`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: ROWS.length, deleted: 0, byKind: {}, revision: 10 }))
        else if (req.method === 'contentList') cb?.(id, JSON.stringify({ ok: true, revision: 10, rows: ROWS, hasMore: false }))
        else cb?.(id, JSON.stringify({ ok: true }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
}

async function contentHash(): Promise<string> {
  const db = getDb()
  const [decksAll, wordsAll, packs, items, rejects] = await Promise.all([db.decks.toArray(), db.words.toArray(), db.packs.toArray(), db.packItems.toArray(), db.contentRejects.toArray()])
  // 内容 hash 只纳入用户/导入内容；内置 seed 的 deck updatedAt 每次 force seed 会变，不是内容差异
  const customDecks = decksAll.filter((d) => !d.builtinKey && d.source !== 'builtin')
  const customDeckIds = new Set(customDecks.map((d) => d.id))
  const customWords = wordsAll.filter((w) => customDeckIds.has(w.deckId))
  const norm = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).sort()
  return hashContentValue({ decks: norm(customDecks), words: norm(customWords), packs: norm(packs), items: norm(items), rejects: norm(rejects) })
}

describe('0.14 final gate: switch → restart(cache loss) → rebuild → content hash', () => {
  it('切源后模拟重启丢 cache，重建后内容 hash 与前次一致', async () => {
    await resetDatabase()
    const db = getDb()
    await db.meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status: 'ready', writeCoverageComplete: true, revision: 10, written: ROWS.length }, updatedAt: Date.now() })
    mockKv()
    const switched = await switchContentWriteSource()
    expect(switched.ok).toBe(true)
    expect((await getSettings())['data.contentWriteSource']).toBe('sqlite')

    const first = await rebuildContentCacheFromSqlite()
    expect(first.ok).toBe(true)
    const before = await contentHash()
    expect((await db.words.get('custom:w'))?.rootEtymology?.etymology).toBe('QA_RESTART')
    expect(await db.contentRejects.get('r1')).toBeTruthy()

    // 模拟重启：content caches 全丢（settings/source、migration state、content_kv 保留）
    await db.transaction('rw', [db.decks, db.words, db.packs, db.packItems, db.contentRejects], async () => {
      await db.decks.clear(); await db.words.clear(); await db.packs.clear(); await db.packItems.clear(); await db.contentRejects.clear()
    })
    const second = await rebuildContentCacheFromSqlite()
    expect(second.ok).toBe(true)
    const after = await contentHash()
    expect(after).toBe(before)
    expect((await db.words.get('custom:w'))?.rootEtymology?.etymology).toBe('QA_RESTART')
    expect((await getSettings())['data.contentWriteSource']).toBe('sqlite')
  }, 120000)
})
