import { primeLegacySqliteContentSource } from './test-utils'
import './test-utils'
/**
 * 0.14 B4：自定义 deck/word 创建/导入写入口接入统一内容写源。
 *
 * 约定：
 * - sqlite 模式：先写 content_kv（`deck:<id>` / `word:<id>`，≤500/批），成功后由写源 helper 写 IDB cache；
 *   失败抛/返回结构化错误，**IDB 不回写**（避免双源）；内置词正文不写 content_kv。
 * - idb 模式：行为与改造前一致（只写 IDB，不调用 contentWrite）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  createDeck,
  exportDeck,
  getDb,
  getSettings,
  importCsv,
  importDeckFile,
  resetDatabase,
  setSqliteTransport,
  upsertWord,
  addWord,
  addWords,
} from '../../src/data'

interface MockCall {
  method: string
  payload: Record<string, unknown>
}

interface MockOptions {
  fail?: boolean
}

/** mock 原生 content* 协议；返回调用记录（可断言 contentWrite 批次） */
function installSqliteMock(opts: MockOptions = {}) {
  const calls: MockCall[] = []
  let revision = 0
  let seq = 0
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${req.id}-r${++seq}`
      calls.push({ method: req.method, payload: req.payload ?? {} })
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'contentWrite') {
          if (opts.fail) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock sqlite fail' }))
            return
          }
          revision += 1
          cb?.(id, JSON.stringify({ ok: true, revision }))
          return
        }
        if (req.method === 'contentCounts') {
          cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  } as never)
  return {
    calls,
    contentWrites: () => calls.filter((call) => call.method === 'contentWrite'),
    entries: () =>
      calls
        .filter((call) => call.method === 'contentWrite')
        .flatMap((call) => ((call.payload.entries as Array<{ key: string; kind: string; updated_at: number }> | undefined) ?? [])),
    /** contentWrite 失败返回的结构化错误码（ContentWriteError.code） */
    errorCodeOf: async (promise: Promise<unknown>): Promise<string | undefined> => {
      try {
        await promise
        return undefined
      } catch (error) {
        return (error as { code?: string }).code
      }
    },
  }
}

async function useContentSqlite(): Promise<void> {
  await primeLegacySqliteContentSource()
}

function customDeckFileText(deck: Record<string, unknown>, words: Array<Record<string, unknown>> = [{ headword: 'alpha', meanings: [{ cn: '甲' }] }]): string {
  return JSON.stringify({
    format: 'momo-deck',
    formatVersion: 1,
    exportedAt: Date.now(),
    generator: 'test-suite',
    deck: { wordCount: words.length, version: 1, createdAt: 1, updatedAt: 1, ...deck },
    words,
  })
}

beforeEach(async () => {
  await resetDatabase()
})

afterEach(async () => {
  setSqliteTransport(null)
})

describe('0.14 B4 自定义 deck/word 创建写源', () => {
  it('createDeck：sqlite 成功→deck/word 行写 content_kv + IDB cache', async () => {
    await useContentSqlite()
    const mock = installSqliteMock()
    const deck = await createDeck({
      name: 'sqlite 新建库',
      description: '自建',
      words: [{ headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }] }],
    })

    expect(mock.contentWrites()).toHaveLength(1)
    const entries = mock.entries()
    expect(entries.every((entry) => entry.kind === 'deck' || entry.kind === 'word')).toBe(true)
    expect(entries.map((entry) => entry.key)).toEqual([`deck:${deck.id}`, `word:${deck.id}:alpha`])

    // IDB cache 同步（SQLite 成功后）
    expect((await getDb().decks.get(deck.id))?.name).toBe('sqlite 新建库')
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
    expect((await getSettings())['data.selectedDeckId']).toBe(deck.id)
  }, 30_000)

  it('createDeck：sqlite 失败→结构化错误且 IDB 不回写', async () => {
    await useContentSqlite()
    const mock = installSqliteMock({ fail: true })
    const code = await mock.errorCodeOf(
      createDeck({ name: '失败库', words: [{ headword: 'beta', meanings: [{ cn: '乙' }] }] }),
    )
    expect(code).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect(await getDb().decks.count()).toBe(0)
    expect(await getDb().words.count()).toBe(0)
    expect(await getDb().settings.get('data.selectedDeckId')).toBeUndefined()
  }, 30_000)

  it('createDeck：>500 行按批切分（每批 ≤500）', async () => {
    await useContentSqlite()
    const mock = installSqliteMock()
    const words = Array.from({ length: 501 }, (_, index) => ({
      headword: `w${index + 1}`,
      meanings: [{ cn: `义${index + 1}` }],
    }))
    const deck = await createDeck({ name: '大库', words })
    const batches = mock.contentWrites().map(
      (call) => ((call.payload.entries as unknown[] | undefined) ?? []).length,
    )
    expect(batches.length).toBe(2)
    expect(batches.every((size) => size > 0 && size <= 500)).toBe(true)
    expect(batches.reduce((sum, size) => sum + size, 0)).toBe(502) // deck 行 + 501 词
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(501)
  }, 60_000)

  it('addWord/addWords/upsertWord：sqlite 成功→word 行 + deck.wordCount 行同步 cache', async () => {
    const deck = await createDeck({ name: 'idb 先建' }) // idb 模式（默认）
    await useContentSqlite()
    const mock = installSqliteMock()

    const word = await addWord(deck.id, { headword: 'one', meanings: [{ cn: '一' }] })
    expect(mock.entries().map((entry) => entry.key)).toContain(`word:${word.id}`)
    expect((await getDb().decks.get(deck.id))?.wordCount).toBe(1)

    await addWords(deck.id, [
      { headword: 'two', meanings: [{ cn: '二' }] },
      { headword: 'three', meanings: [{ cn: '三' }] },
    ])
    expect((await getDb().decks.get(deck.id))?.wordCount).toBe(3)
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(3)

    const before = mock.entries().length
    const upserted = await upsertWord(deck.id, { headword: 'two', meanings: [{ cn: '二' }, { cn: '两' }] })
    expect(mock.entries().length).toBeGreaterThan(before)
    expect((await getDb().words.get(upserted.id))?.meanings).toHaveLength(2)
    // upsert 已存在词：字数不变，不重复写 deck 行
    expect(mock.entries().filter((entry) => entry.key === `deck:${deck.id}`)).toHaveLength(2)
  }, 30_000)

  it('addWord：sqlite 失败→抛结构化错误且 IDB 不新增词', async () => {
    const deck = await createDeck({ name: 'idb 先建' })
    await useContentSqlite()
    const mock = installSqliteMock({ fail: true })
    const code = await mock.errorCodeOf(addWord(deck.id, { headword: 'beta', meanings: [{ cn: '乙' }] }))
    expect(code).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(0)
    expect((await getDb().decks.get(deck.id))?.wordCount).toBe(0)
  }, 30_000)

  it('idb 模式行为不变：不调用 contentWrite，仍写 IDB', async () => {
    const mock = installSqliteMock()
    const deck = await createDeck({ name: 'idb 库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    await addWord(deck.id, { headword: 'beta', meanings: [{ cn: '乙' }] })
    const csvReport = await importCsv('headword,meaning\ngamma,伽马')
    const importReport = await importDeckFile(customDeckFileText({ id: 'deck-idb-import', name: 'idb 导入库' }))

    expect(mock.contentWrites()).toHaveLength(0)
    expect(csvReport.ok).toBe(true)
    expect(importReport.ok).toBe(true)
    expect((await getDb().decks.get(deck.id))?.wordCount).toBe(2)
    expect(await getDb().decks.get('deck-idb-import')).toBeTruthy()
  }, 30_000)
})

describe('0.14 B4 自定义词库导入写源', () => {
  it('importDeckFile：sqlite 成功→content_kv + IDB cache；不写内置词正文', async () => {
    await useContentSqlite()
    const mock = installSqliteMock()
    const report = await importDeckFile(
      customDeckFileText({ id: 'deck-sqlite-import', name: 'sqlite 导入库', source: 'custom' }),
    )
    expect(report.ok).toBe(true)
    expect(report.counts.decks).toBe(1)
    expect(report.counts.words).toBe(1)
    expect(mock.entries().some((entry) => entry.key === 'deck:deck-sqlite-import')).toBe(true)
    expect(mock.entries().some((entry) => entry.key === 'word:deck-sqlite-import:alpha' && entry.kind === 'word')).toBe(true)
    // 内置词正文不进 content_kv：只有自定义 deck/word 两种 kind
    expect(new Set(mock.entries().map((entry) => entry.kind))).toEqual(new Set(['deck', 'word']))

    expect((await getDb().decks.get('deck-sqlite-import'))?.name).toBe('sqlite 导入库')
    expect(await getDb().words.where('deckId').equals('deck-sqlite-import').count()).toBe(1)
  }, 30_000)

  it('importDeckFile：sqlite 失败→report.ok=false（含已写/结构化错误）且 IDB 不回写', async () => {
    await useContentSqlite()
    installSqliteMock({ fail: true })
    const report = await importDeckFile(
      customDeckFileText({ id: 'deck-sqlite-fail', name: '失败导入库', source: 'custom' }),
    )
    expect(report.ok).toBe(false)
    const issue = report.issues.find((item) => item.code === 'E_IO')
    expect(issue?.message).toMatch(/SQLite 内容写入失败/)
    expect(issue?.message).toMatch(/失败批未回写 IDB/)
    expect(await getDb().decks.get('deck-sqlite-fail')).toBeUndefined()
    expect(await getDb().words.where('deckId').equals('deck-sqlite-fail').count()).toBe(0)
  }, 30_000)

  it('importDeckFile：sqlite 模式不把内置词库正文写入 content_kv', async () => {
    await useContentSqlite()
    const mock = installSqliteMock()
    await expect(
      importDeckFile(customDeckFileText({
        id: 'dagang-2025',
        name: '商业词表',
        source: 'builtin',
        builtinKey: 'dagang-2025',
      })),
    ).rejects.toThrow(/E_UNSUPPORTED/)
    expect(mock.contentWrites()).toHaveLength(0)
    expect(await getDb().decks.get('dagang-2025')).toBeUndefined()
  }, 30_000)

  it('importDeckFile：sqlite 模式拒绝覆盖已有内置词库（正文不进 content_kv）', async () => {
    const existing = await createDeck({
      name: '伪内置库',
      source: 'builtin',
      words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }],
    })
    await useContentSqlite()
    await expect(
      importDeckFile(
        customDeckFileText({ id: existing.id, name: '覆盖', source: 'custom' }),
        { preBackup: async () => ({ ok: true }) },
      ),
    ).rejects.toThrow(/E_UNSUPPORTED/)
  }, 30_000)

  it('importCsv：sqlite 成功→content_kv + IDB cache；失败→结构化 report 且不回写', async () => {
    await useContentSqlite()
    const mock = installSqliteMock()
    const report = await importCsv('headword,meaning\ngamma,伽马\ndelta,德尔塔', 'sqlite 词单')
    expect(report.ok).toBe(true)
    expect(report.counts.words).toBe(2)
    expect(mock.entries().filter((entry) => entry.kind === 'word')).toHaveLength(2)
    expect(await getDb().decks.count()).toBe(1)
    const cacheDeck = (await getDb().decks.toArray())[0]!
    expect(cacheDeck.name).toBe('sqlite 词单')
    expect(await getDb().words.where('deckId').equals(cacheDeck.id).count()).toBe(2)
  }, 30_000)

  it('importCsv：sqlite 失败→report.ok=false 且 IDB 不建库', async () => {
    await useContentSqlite()
    installSqliteMock({ fail: true })
    const report = await importCsv('headword,meaning\ngamma,伽马')
    expect(report.ok).toBe(false)
    expect(report.issues.some((item) => item.code === 'E_IO' && /失败批未回写 IDB/.test(item.message))).toBe(true)
    expect(await getDb().decks.count()).toBe(0)
    expect(await getDb().words.count()).toBe(0)
  }, 30_000)

  it('导出→清库→sqlite 导入往返：cache 与 deck 文件一致', async () => {
    const deck = await createDeck({ name: '往返库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const text = await (await exportDeck(deck.id)).text()
    await resetDatabase()
    await useContentSqlite()
    const mock = installSqliteMock()
    const report = await importDeckFile(text)
    expect(report.ok).toBe(true)
    expect(mock.contentWrites().length).toBeGreaterThan(0)
    const cached = await getDb().decks.get(deck.id)
    expect(cached).toBeTruthy()
    expect(cached!.name).toBe('往返库')
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
  }, 30_000)
})
