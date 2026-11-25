import '../test-utils'
import { persistContentWriteSource } from '../../../src/data/content-write-source'
/**
 * 0.14 B5：墨墨导入写 `maimemoVocId`（内置词 overlay）走统一内容写源。
 *
 * 覆盖：
 * - content sqlite + learning sqlite：先 contentWrite 写 overlay，成功后才更新 IDB cache；facts 走原 SQLite tx
 * - content sqlite 失败：抛 ContentWriteError、不回写 IDB overlay cache、facts 备份恢复
 * - content sqlite + learning idb（双源独立）：overlay 进 content_kv，学习 facts 仍写 IDB
 * - content idb（默认）：行为不变，不调用 contentWrite
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  createDeck,
  getDb,
  importMaimemoRecords,
  persistLearningWriteSource,
  resetDatabase,
  setSqliteTransport,
} from '../../../src/data'
import { formatMaimemoDate } from '../../../src/data/api/maimemo-client'

const DAY = 86_400_000
const NOW = new Date(2026, 10, 10, 12, 0, 0).getTime()
const WORD = 'alpha'
const VOC_ID = 'voc-alpha'

interface ContentWriteEntry { key: string; kind: string; json: string; updated_at?: number }

function installSqliteMock(opts: { failContent?: boolean } = {}) {
  let seq = 0
  let contentRevision = 0
  const methods: string[] = []
  const contentWrites: Array<{ entries: ContentWriteEntry[]; deletes: string[] }> = []
  const factsCounts = { states: 0, plans: 0, settings: 0, review_logs: 0 }
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${req.id}-r${++seq}`
      methods.push(req.method)
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, json: string) => void }).__momoSqliteResult
        if (req.method === 'health') {
          cb?.(id, JSON.stringify({ ok: true, userVersion: 3, sizeBytes: 4096, integrityOk: true, readOnly: false, counts: { ...factsCounts } }))
          return
        }
        if (req.method === 'backup') {
          cb?.(id, JSON.stringify({ ok: true, bytes: 4096, name: 'sqlite-backup-x.db', path: '/p/x', checksum: 'abc', integrityOk: true }))
          return
        }
        if (req.method === 'contentCounts') {
          cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision: contentRevision }))
          return
        }
        if (req.method === 'contentWrite') {
          const payload = (req.payload ?? {}) as { entries?: ContentWriteEntry[]; deletes?: string[] }
          contentWrites.push({ entries: payload.entries ?? [], deletes: payload.deletes ?? [] })
          if (opts.failContent) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock content fail' }))
            return
          }
          contentRevision += 1
          cb?.(id, JSON.stringify({ ok: true, revision: contentRevision }))
          return
        }
        if (req.method === 'restoreDb') {
          cb?.(id, JSON.stringify({ ok: true }))
          return
        }
        if (req.method === 'integrity') {
          cb?.(id, JSON.stringify({ ok: true, integrityOk: true }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return {
    methods,
    contentWrites,
    entries: () => contentWrites.flatMap((write) => write.entries),
  }
}

async function seedWord() {
  await resetDatabase()
  const deck = await createDeck({
    name: 'maimemo-write-source',
    words: [{ headword: WORD, meanings: [{ cn: '甲' }] }],
  })
  return (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
}

function maimemoRecords() {
  return [
    {
      voc_id: VOC_ID,
      voc_spelling: WORD,
      first_study_date: formatMaimemoDate(NOW - 3 * DAY),
      last_study_date: formatMaimemoDate(NOW - DAY),
      next_study_date: formatMaimemoDate(NOW + 2 * DAY),
      last_response: 'FAMILIAR',
      study_count: 2,
      tags: [],
    },
  ]
}

afterEach(async () => {
  setSqliteTransport(null)
  await persistLearningWriteSource('idb').catch(() => undefined)
})

describe('0.14 B5 墨墨导入 overlay 写源', () => {
  it('sqlite 写源：先 contentWrite 写 overlay，成功后 IDB cache 才有 maimemoVocId；facts 走 SQLite tx', async () => {
    const word = await seedWord()
    await persistContentWriteSource('sqlite')
    await persistLearningWriteSource('sqlite')
    const mock = installSqliteMock()

    const result = await importMaimemoRecords(maimemoRecords())

    expect(result.ok).toBe(true)
    expect(result.matched).toBe(1)
    // overlay 写入内容事实源：key/kind/json 正确
    const overlay = mock.entries().find((entry) => entry.key === `word-overlay:${word.id}`)
    expect(overlay).toBeTruthy()
    expect(overlay!.kind).toBe('word-overlay')
    expect(JSON.parse(overlay!.json).maimemoVocId).toBe(VOC_ID)
    // 学习 facts 仍走原 SQLite tx（不被本次改动影响）
    expect(mock.methods).toContain('tx')
    expect(mock.methods).toContain('backup')
    // overlay 成功后 IDB cache 同步
    expect((await getDb().words.get(word.id))?.maimemoVocId).toBe(VOC_ID)
    expect(await getDb().states.count()).toBe(1)
    expect((await getDb().meta.get('import:last'))?.value).toMatchObject({ kind: 'maimemo' })
  })

  it('sqlite 写源失败：抛 ContentWriteError、不回写 IDB overlay，且回滚 facts 备份', async () => {
    const word = await seedWord()
    await persistContentWriteSource('sqlite')
    await persistLearningWriteSource('sqlite')
    const mock = installSqliteMock({ failContent: true })

    await expect(importMaimemoRecords(maimemoRecords())).rejects.toMatchObject({
      name: 'ContentWriteError',
      code: 'CONTENT_SQLITE_WRITE_FAILED',
    })

    // 尝试过写 content_kv，失败后没有双写 IDB
    expect(mock.contentWrites.length).toBeGreaterThan(0)
    expect((await getDb().words.get(word.id))?.maimemoVocId).toBeUndefined()
    // 失败发生在 IDB facts cache 之前 → IDB 无半套导入数据
    expect(await getDb().states.count()).toBe(0)
    // SQLite facts 走备份恢复（失败不留下半套 states）
    expect(mock.methods).toContain('restoreDb')
  })

  it('content sqlite + learning idb（双源独立）：overlay 进 content_kv，学习 facts 仍写 IDB', async () => {
    const word = await seedWord()
    await persistContentWriteSource('sqlite')
    const mock = installSqliteMock()

    const result = await importMaimemoRecords(maimemoRecords())

    expect(result.ok).toBe(true)
    const overlay = mock.entries().find((entry) => entry.key === `word-overlay:${word.id}`)
    expect(JSON.parse(overlay!.json).maimemoVocId).toBe(VOC_ID)
    expect((await getDb().words.get(word.id))?.maimemoVocId).toBe(VOC_ID)
    // learning source 仍为 idb：facts 走 IDB，不触发 SQLite facts 备份/tx
    expect(mock.methods).not.toContain('tx')
    expect(await getDb().states.count()).toBe(1)
  })

  it('content idb 模式行为不变：不调用 contentWrite，仍写 IDB overlay', async () => {
    const word = await seedWord()
    const mock = installSqliteMock()

    const result = await importMaimemoRecords(maimemoRecords())

    expect(result.ok).toBe(true)
    expect(mock.contentWrites.length).toBe(0)
    expect(mock.methods).not.toContain('contentWrite')
    expect((await getDb().words.get(word.id))?.maimemoVocId).toBe(VOC_ID)
    expect(await getDb().states.count()).toBe(1)
  })

  it('idb 模式重复导入幂等：maimemoVocId 不重复写、不报错', async () => {
    const word = await seedWord()

    await importMaimemoRecords(maimemoRecords())
    await importMaimemoRecords(maimemoRecords())

    expect(await getDb().states.count()).toBe(1)
    expect((await getDb().words.get(word.id))?.maimemoVocId).toBe(VOC_ID)
  })
})
