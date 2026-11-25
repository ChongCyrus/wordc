import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
/**
 * 0.14 B4（续）：自定义 deck/word 编辑/删除写入口 + content tombstone。
 *
 * 约定：
 * - sqlite 内容写源：编辑走 upsert（`deck:<id>` / `word:<id>`），删除走 `deleted=1` tombstone；
 *   SQLite 成功后 helper 写 IDB cache，失败抛结构化错误且不回写 IDB。
 * - tombstone 保留（不硬删行），从 content_kv 重建 cache 时被删实体不复活。
 * - idb 模式行为不变（不调用 contentWrite）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addWord,
  createDeck,
  deleteDeck,
  deleteWord,
  ensureSingleDefaultDeck,
  getDb,
  importDeckFile,
  rebuildContentCacheFromSqlite,
  renameDeck,
  resetDatabase,
  setDefaultDeck,
  setSqliteTransport,
  updateDeck,
  updateWord,
} from '../../src/data'

interface NativeKvRow {
  key: string
  kind: string
  json: string
  updated_at: number
  revision: number
  deleted: 0 | 1
}

interface WritePayload {
  entries: Array<{ key: string; kind: string; json: string; updated_at: number }>
  deletes: string[]
}

/**
 * 内存版 content_kv 原生 mock：实现 contentCounts/contentWrite/contentGet/contentList 协议。
 * 每个 entry/delete 递增 revision（与增量分页语义一致），tombstone 保留 deleted=1 行。
 */
function installContentKvMock(opts: { failContentWrite?: boolean } = {}) {
  const rows = new Map<string, NativeKvRow>()
  const writes: WritePayload[] = []
  let revision = 0
  let seq = 0
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'contentCounts') {
          const all = [...rows.values()]
          cb?.(id, JSON.stringify({
            ok: true,
            total: all.filter((row) => row.deleted === 0).length,
            deleted: all.filter((row) => row.deleted === 1).length,
            byKind: {},
            revision,
          }))
          return
        }
        if (req.method === 'contentWrite') {
          if (opts.failContentWrite) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock sqlite fail' }))
            return
          }
          const payload = (req.payload ?? {}) as { entries?: Array<Record<string, unknown>>; deletes?: string[] }
          const entries = (payload.entries ?? []).map((entry) => ({
            key: String(entry.key),
            kind: String(entry.kind),
            json: String(entry.json),
            updated_at: Number(entry.updated_at ?? Date.now()),
          }))
          const deletes = payload.deletes ?? []
          for (const entry of entries) {
            revision += 1
            rows.set(entry.key, { ...entry, revision, deleted: 0 })
          }
          for (const key of deletes) {
            revision += 1
            const previous = rows.get(key)
            rows.set(key, {
              key,
              kind: previous?.kind ?? 'word',
              json: previous?.json ?? 'null',
              updated_at: Date.now(),
              revision,
              deleted: 1,
            })
          }
          writes.push({ entries, deletes })
          cb?.(id, JSON.stringify({ ok: true, revision, upserts: entries.length, tombstones: deletes.length }))
          return
        }
        if (req.method === 'contentList') {
          const payload = (req.payload ?? {}) as { fromRevision?: number; limit?: number }
          const from = Number(payload.fromRevision ?? 0)
          const limit = Number(payload.limit ?? 200)
          const matching = [...rows.values()].filter((row) => row.revision > from).sort((a, b) => a.revision - b.revision)
          const page = matching.slice(0, limit)
          cb?.(id, JSON.stringify({ ok: true, rows: page, revision, hasMore: matching.length > limit }))
          return
        }
        if (req.method === 'contentGet') {
          const payload = (req.payload ?? {}) as { keys?: string[] }
          const keys = payload.keys ?? []
          cb?.(id, JSON.stringify({ ok: true, rows: keys.map((key) => rows.get(key)).filter(Boolean), revision }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true, rows: [], revision }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  } as never)
  return {
    rows,
    writes,
    entries: () => writes.flatMap((write) => write.entries),
    deletedKeys: () => writes.flatMap((write) => write.deletes),
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
  await persistContentWriteSource('sqlite')
}

function deckFileText(deck: Record<string, unknown>, words: Array<Record<string, unknown>>): string {
  return JSON.stringify({
    format: 'momo-deck',
    formatVersion: 1,
    exportedAt: Date.now(),
    generator: 'test-suite',
    deck: { source: 'custom', wordCount: words.length, version: 1, createdAt: 1, updatedAt: 1, ...deck },
    words,
  })
}

beforeEach(async () => {
  await resetDatabase()
})

afterEach(async () => {
  setSqliteTransport(null)
})

describe('0.14 B4 自定义 deck/word 编辑写源', () => {
  it('updateWord/renameDeck/updateDeck/setDefaultDeck：sqlite upsert → cache 同步', async () => {
    const deck = await createDeck({ name: '编辑库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await useContentSqlite()
    const mock = installContentKvMock()

    const updated = await updateWord(word.id, { meanings: [{ cn: '甲（改）' }] })
    expect(updated.meanings[0]!.cn).toBe('甲（改）')
    expect(mock.entries().some((entry) => entry.key === `word:${word.id}` && entry.json.includes('甲（改）'))).toBe(true)
    expect((await getDb().words.get(word.id))?.meanings[0]?.cn).toBe('甲（改）')

    const renamed = await renameDeck(deck.id, '改名库')
    expect(renamed.name).toBe('改名库')
    expect(mock.entries().some((entry) => entry.key === `deck:${deck.id}` && entry.json.includes('改名库'))).toBe(true)
    expect((await getDb().decks.get(deck.id))?.name).toBe('改名库')

    await updateDeck(deck.id, { description: '新描述', license: 'MIT' })
    expect((await getDb().decks.get(deck.id))?.description).toBe('新描述')

    await setDefaultDeck(deck.id)
    expect((await getDb().decks.get(deck.id))?.isDefault).toBe(true)
  }, 30_000)

  it('编辑失败：抛结构化错误且 IDB 旧值不变', async () => {
    const deck = await createDeck({ name: '编辑失败库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await useContentSqlite()
    const mock = installContentKvMock({ failContentWrite: true })

    const code = await mock.errorCodeOf(updateWord(word.id, { meanings: [{ cn: '不应写入' }] }))
    expect(code).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect((await getDb().words.get(word.id))?.meanings[0]?.cn).toBe('甲')

    const renameCode = await mock.errorCodeOf(renameDeck(deck.id, '不应改名'))
    expect(renameCode).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect((await getDb().decks.get(deck.id))?.name).toBe('编辑失败库')
  }, 30_000)

  it('idb 模式：编辑/改名/默认不调用 contentWrite，仍写 IDB', async () => {
    const mock = installContentKvMock()
    const deck = await createDeck({ name: 'idb 编辑', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await updateWord(word.id, { meanings: [{ cn: '乙' }] })
    await renameDeck(deck.id, 'idb 改名')
    await updateDeck(deck.id, { description: 'idb 描述' })
    await setDefaultDeck(deck.id)
    expect(mock.writes).toHaveLength(0)
    expect((await getDb().words.get(word.id))?.meanings[0]?.cn).toBe('乙')
    expect((await getDb().decks.get(deck.id))?.name).toBe('idb 改名')
  }, 30_000)
})

describe('0.14 B4 自定义 deck/word 删除 tombstone', () => {
  it('deleteWord：sqlite 写 word tombstone + deck.wordCount，cache 同步', async () => {
    const deck = await createDeck({ name: '删词库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
    const words = await getDb().words.where('deckId').equals(deck.id).toArray()
    const alpha = words.find((word) => word.headword === 'alpha')!
    await useContentSqlite()
    const mock = installContentKvMock()

    await deleteWord(alpha.id)
    expect(mock.deletedKeys()).toContain(`word:${alpha.id}`)
    expect(await getDb().words.get(alpha.id)).toBeUndefined()
    expect((await getDb().decks.get(deck.id))?.wordCount).toBe(1)
    // tombstone 行保留 deleted=1（不硬删）
    expect(mock.rows.get(`word:${alpha.id}`)?.deleted).toBe(1)
  }, 30_000)

  it('deleteWord：sqlite 失败→抛结构化错误且 IDB 不删', async () => {
    const deck = await createDeck({ name: '删词失败库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await useContentSqlite()
    const mock = installContentKvMock({ failContentWrite: true })
    const code = await mock.errorCodeOf(deleteWord(word.id))
    expect(code).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect(await getDb().words.get(word.id)).toBeTruthy()
    expect((await getDb().decks.get(deck.id))?.wordCount).toBe(1)
  }, 30_000)

  it('deleteDeck：sqlite 写 deck+word tombstones；默认库删除时兜底库默认标记同批写', async () => {
    const first = await createDeck({ name: '默认库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const second = await createDeck({ name: '第二库', words: [{ headword: 'beta', meanings: [{ cn: '乙' }] }] })
    // 第二个库设为默认，再删它，验证兜底默认标记
    await setDefaultDeck(second.id)
    const secondWords = await getDb().words.where('deckId').equals(second.id).toArray()
    await useContentSqlite()
    const mock = installContentKvMock()

    await deleteDeck(second.id, { unsafe: true })
    expect(mock.deletedKeys()).toContain(`deck:${second.id}`)
    for (const word of secondWords) expect(mock.deletedKeys()).toContain(`word:${word.id}`)
    expect(await getDb().decks.get(second.id)).toBeUndefined()
    expect(await getDb().words.where('deckId').equals(second.id).count()).toBe(0)
    expect((await getDb().decks.get(first.id))?.isDefault).toBe(true)
    // 兜底默认标记也进了 content_kv（同批/后续 upsert）
    expect(mock.entries().some((entry) => entry.key === `deck:${first.id}` && entry.json.includes('"isDefault":true'))).toBe(true)
  }, 30_000)

  it('deleteDeck：sqlite 失败→抛结构化错误且 IDB 不删', async () => {
    const deck = await createDeck({ name: '删除失败库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    await useContentSqlite()
    const mock = installContentKvMock({ failContentWrite: true })
    const code = await mock.errorCodeOf(deleteDeck(deck.id, { unsafe: true }))
    expect(code).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect(await getDb().decks.get(deck.id)).toBeTruthy()
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
  }, 30_000)

  it('tombstone 后从 content_kv 重建 cache：被删 deck/word 不复活', async () => {
    await useContentSqlite()
    installContentKvMock()
    const deck = await createDeck({ name: '重建库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
    const words = await getDb().words.where('deckId').equals(deck.id).toArray()
    const alpha = words.find((word) => word.headword === 'alpha')!

    await deleteWord(alpha.id)
    // 模拟 cache 丢失：清 IDB 内容表后从 content_kv 重建（需写源=sqlite 且迁移 ready 的门禁）
    await persistContentWriteSource('sqlite')
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false }, updatedAt: Date.now() })
    await getDb().words.clear()
    await getDb().decks.clear()
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok, rebuilt.error).toBe(true)
    expect(await getDb().decks.get(deck.id)).toBeTruthy()
    expect(await getDb().words.get(alpha.id)).toBeUndefined()
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
  }, 120_000)

  it('idb 模式：删除不调用 contentWrite，行为不变', async () => {
    const mock = installContentKvMock()
    const deck = await createDeck({ name: 'idb 删除', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await deleteWord(word.id)
    expect(await getDb().words.get(word.id)).toBeUndefined()
    await deleteDeck(deck.id, { unsafe: true })
    expect(await getDb().decks.get(deck.id)).toBeUndefined()
    expect(mock.writes).toHaveLength(0)
  }, 30_000)
})

describe('0.14 B4 导入覆盖（tombstone/diff）', () => {
  it('importDeckFile replace 已有自定义库：写移除词 tombstone，cache 与 states 同步', async () => {
    const deck = await createDeck({
      name: '覆盖库',
      words: [
        { headword: 'alpha', meanings: [{ cn: '甲' }] },
        { headword: 'beta', meanings: [{ cn: '乙' }] },
      ],
    })
    const words = await getDb().words.where('deckId').equals(deck.id).toArray()
    const beta = words.find((word) => word.headword === 'beta')!
    await getDb().states.put({ wordId: beta.id, deckId: deck.id, phase: 'new' } as never)
    await useContentSqlite()
    const mock = installContentKvMock()

    const report = await importDeckFile(
      deckFileText(
        { id: deck.id, name: '覆盖后', source: 'custom' },
        [
          { headword: 'alpha', meanings: [{ cn: '甲（新）' }] },
          { headword: 'gamma', meanings: [{ cn: '伽马' }] },
        ],
      ),
      { strategy: 'replace', preBackup: async () => ({ ok: true }) },
    )
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(mock.deletedKeys()).toContain(`word:${beta.id}`)
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(2)
    expect(await getDb().words.get(beta.id)).toBeUndefined()
    expect(await getDb().words.where('deckId').equals(deck.id).toArray()).toEqual(
      expect.arrayContaining([expect.objectContaining({ headwordLower: 'gamma' })]),
    )
    // replace 语义：该库 states 清空
    expect(await getDb().states.where('deckId').equals(deck.id).count()).toBe(0)
  }, 30_000)

  it('importDeckFile merge 已有自定义库：只 upsert，不写 tombstone，保留本机词与 states', async () => {
    const deck = await createDeck({ name: '合并库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const alpha = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ wordId: alpha.id, deckId: deck.id, phase: 'new' } as never)
    await useContentSqlite()
    const mock = installContentKvMock()

    const report = await importDeckFile(
      deckFileText({ id: deck.id, name: '合并库', source: 'custom' }, [{ headword: 'gamma', meanings: [{ cn: '伽马' }] }]),
      { strategy: 'merge' },
    )
    expect(report.ok).toBe(true)
    expect(mock.deletedKeys()).toHaveLength(0)
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(2)
    expect(await getDb().states.where('deckId').equals(deck.id).count()).toBe(1)
  }, 30_000)

  it('importDeckFile 覆盖失败：report.ok=false 且 IDB 词表不变', async () => {
    const deck = await createDeck({ name: '覆盖失败库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    await useContentSqlite()
    installContentKvMock({ failContentWrite: true })
    const report = await importDeckFile(
      deckFileText({ id: deck.id, name: '覆盖失败库', source: 'custom' }, [{ headword: 'gamma', meanings: [{ cn: '伽马' }] }]),
      { strategy: 'replace', preBackup: async () => ({ ok: true }) },
    )
    expect(report.ok).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'E_IO')).toBe(true)
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
    expect((await getDb().words.where('deckId').equals(deck.id).toArray())[0]?.headwordLower).toBe('alpha')
  }, 30_000)
})

describe('0.14 B4 sqlite 学习 facts + sqlite 内容写源组合', () => {
  it('deleteWord（learning sqlite + content sqlite）：content tombstone 先于 SQLite facts tx', async () => {
    const deck = await createDeck({ name: '双 SQLite 库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await useContentSqlite()
    const methods: string[] = []
    let seq = 0
    setSqliteTransport({
      sqliteCall(json: string) {
        const req = JSON.parse(json) as { id: string; method: string }
        const id = `${req.id}-r${++seq}`
        methods.push(req.method)
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'contentWrite') { cb?.(id, JSON.stringify({ ok: true, revision: 1 })); return }
          if (req.method === 'contentCounts') { cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision: 1 })); return }
          cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    } as never)
    const { persistLearningWriteSource } = await import('../../src/data')
    await persistLearningWriteSource('sqlite')
    try {
      await deleteWord(word.id)
      expect(methods).toContain('contentWrite')
      expect(methods.indexOf('contentWrite')).toBeLessThan(methods.indexOf('tx'))
    } finally {
      await persistLearningWriteSource('idb')
    }
  }, 30_000)
})

describe('0.14 B4 收口：内置 deck 删除 fail-closed / 删除补偿 / 默认标记同步', () => {
  it('deleteDeck：sqlite 内容写源下删除内置 deck fail-closed（不写 tombstone）', async () => {
    const builtinDeck = await createDeck({
      name: '伪内置库',
      source: 'builtin',
      words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }],
    })
    await useContentSqlite()
    const mock = installContentKvMock()
    await expect(deleteDeck(builtinDeck.id, { unsafe: true })).rejects.toThrow(/E_UNSUPPORTED/)
    expect(await getDb().decks.get(builtinDeck.id)).toBeTruthy()
    expect(await getDb().words.where('deckId').equals(builtinDeck.id).count()).toBe(1)
    expect(mock.writes).toHaveLength(0)
  }, 30_000)

  it('deleteWord：content tombstone 成功后 facts 失败 → 用快照恢复 content 与 cache 再抛错', async () => {
    const deck = await createDeck({ name: '补偿词库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ wordId: word.id, deckId: deck.id, phase: 'new' } as never)
    await useContentSqlite()
    const mock = installContentKvMock()
    const failingHook = () => { throw new Error('mock facts fail') }
    getDb().states.hook('deleting', failingHook)
    await expect(deleteWord(word.id)).rejects.toThrow(/mock facts fail/)
    // content 行用删除前快照恢复（tombstone 被 upsert 回 deleted=0）
    const restoredWord = mock.rows.get(`word:${word.id}`)
    expect(restoredWord?.deleted).toBe(0)
    expect(restoredWord?.json).toContain('alpha')
    expect(mock.rows.get(`deck:${deck.id}`)?.deleted).toBe(0)
    // IDB cache 也恢复
    expect(await getDb().words.get(word.id)).toBeTruthy()
    expect((await getDb().decks.get(deck.id))?.wordCount).toBe(1)
    expect(await getDb().states.get(word.id)).toBeTruthy()
  }, 30_000)

  it('deleteDeck：content tombstone 成功后 facts 失败 → 用快照恢复 deck/word content 与 cache 再抛错', async () => {
    const deck = await createDeck({ name: '补偿删库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await useContentSqlite()
    const mock = installContentKvMock()
    const failingHook = () => { throw new Error('mock settings fail') }
    getDb().settings.hook('updating', failingHook)
    await expect(deleteDeck(deck.id, { unsafe: true })).rejects.toThrow(/mock settings fail/)
    expect(mock.rows.get(`deck:${deck.id}`)?.deleted).toBe(0)
    expect(mock.rows.get(`word:${word.id}`)?.deleted).toBe(0)
    expect(await getDb().decks.get(deck.id)).toBeTruthy()
    expect(await getDb().words.get(word.id)).toBeTruthy()
  }, 30_000)

  it('ensureSingleDefaultDeck：sqlite 内容写源下同步 content_kv deck 行与 cache', async () => {
    const first = await createDeck({ name: '默认一', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const second = await createDeck({ name: '默认二', words: [{ headword: 'beta', meanings: [{ cn: '乙' }] }] })
    await useContentSqlite()
    const mock = installContentKvMock()
    const preferred = await ensureSingleDefaultDeck(second.id)
    expect(preferred).toBe(second.id)
    const entries = mock.entries()
    expect(entries.some((entry) => entry.key === `deck:${second.id}` && entry.json.includes('"isDefault":true'))).toBe(true)
    expect(entries.some((entry) => entry.key === `deck:${first.id}` && entry.json.includes('"isDefault":false'))).toBe(true)
    expect((await getDb().decks.get(second.id))?.isDefault).toBe(true)
    expect((await getDb().decks.get(first.id))?.isDefault).toBe(false)
    // 再调用一次：已唯一默认 → 无额外 content 写
    const writesBefore = mock.writes.length
    expect(await ensureSingleDefaultDeck(second.id)).toBe(second.id)
    expect(mock.writes.length).toBe(writesBefore)
  }, 30_000)
})

describe('0.14 F1/F2：内置词保护 + word-overlay tombstone', () => {
  it('F1 内置词：sqlite 内容源下 updateWord/deleteWord fail-closed，IDB 与 content_kv 都不动', async () => {
    const deck = await createDeck({
      name: '伪内置词库',
      source: 'builtin',
      words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }],
    })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await useContentSqlite()
    const mock = installContentKvMock()
    await expect(updateWord(word.id, { meanings: [{ cn: '乙' }] })).rejects.toThrow(/E_UNSUPPORTED/)
    await expect(deleteWord(word.id)).rejects.toThrow(/E_UNSUPPORTED/)
    expect((await getDb().words.get(word.id))?.meanings[0]?.cn).toBe('甲')
    expect(mock.writes).toHaveLength(0)
  }, 30_000)

  it('F2 删词同批 tombstone word-overlay；重建 cache 后旧笔记不复活', async () => {
    const deck = await createDeck({ name: 'overlay 库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().words.put({ ...word, userNotes: [{ id: 'n1', text: '旧笔记' }] } as never)
    await useContentSqlite()
    const mock = installContentKvMock()

    await deleteWord(word.id)
    const writeWithWord = mock.writes.find((write) => write.deletes.includes(`word:${word.id}`))
    expect(writeWithWord?.deletes).toContain(`word-overlay:${word.id}`)

    // 重新添加同 id 词（新词无笔记），再从 content_kv 重建 cache：旧 overlay 不复活
    await addWord(deck.id, { headword: 'alpha', meanings: [{ cn: '甲' }] })
    expect((await getDb().words.get(word.id))?.userNotes).toBeUndefined()
    await persistContentWriteSource('sqlite')
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false }, updatedAt: Date.now() })
    await getDb().decks.clear()
    await getDb().words.clear()
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok, rebuilt.error ?? '').toBe(true)
    expect((await getDb().words.get(word.id))?.userNotes).toBeUndefined()
  }, 120_000)

  it('0.15 F1：内置 deck 中 custom=true 的后加词允许编辑/删除；打包正文仍 fail-closed', async () => {
    const deck = await createDeck({
      name: '内置 deck custom 词',
      source: 'builtin',
      words: [{ headword: 'packaged', meanings: [{ cn: '打包正文' }] }],
    })
    const packaged = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await useContentSqlite()
    const mock = installContentKvMock()
    await expect(updateWord(packaged.id, { meanings: [{ cn: '改打包' }] })).rejects.toThrow(/E_UNSUPPORTED/)
    await expect(deleteWord(packaged.id)).rejects.toThrow(/E_UNSUPPORTED/)
    expect(mock.writes).toHaveLength(0)

    const custom = await addWord(deck.id, { headword: 'user-added', meanings: [{ cn: '后加' }] })
    expect(custom.custom).toBe(true)
    const updated = await updateWord(custom.id, { meanings: [{ cn: '后加改' }] })
    expect(updated.meanings[0]?.cn).toBe('后加改')
    await deleteWord(custom.id)
    expect((await getDb().words.get(custom.id))).toBeUndefined()
    expect(mock.deletedKeys()).toContain(`word:${custom.id}`)
  }, 30_000)
})
