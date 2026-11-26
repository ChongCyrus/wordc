import { primeLegacySqliteContentSource } from './test-utils'
/**
 * 0.15 task-294：导入/恢复在原生 v15 单一事实源下不再回退 idb。
 *
 * 契约（依赖 task-293，本地 TODO 兼容适配）：
 * - native APK + `contentMigrationV15=done` + sqlite→ 导入后 `contentWriteSource` 仍 sqlite，
 *   content_kv 旧 live 行按差集 tombstone（不 reset 迁移状态）；
 * - web / v15 未完成 → 仍 idb（0.14 语义）；
 * - 导入内容写 content_kv 失败 / 后续 IDB 事务失败 → 快照补偿，content_kv 与 IDB 不分叉。
 */
import './test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMigrationFile,
  createDeck,
  getDb,
  getContentWriteSource,
  importMigration,
  resetDatabase,
  setSqliteTransport,
} from '../../src/data'

interface NativeKvRow {
  key: string
  kind: string
  json: string
  updated_at: number
  revision: number
  deleted: 0 | 1
}

/** content_kv 内存 mock：contentCounts/contentWrite/contentGet/contentList(offset/orderBy) */
function installContentMock() {
  const rows = new Map<string, NativeKvRow>()
  let revision = 0
  let seq = 0
  let writeCount = 0
  let failAtWrite: number | null = null
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        try {
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
            writeCount += 1
            if (failAtWrite !== null && writeCount === failAtWrite) {
              cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock content write fail' }))
              return
            }
            const payload = (req.payload ?? {}) as { entries?: Array<Record<string, unknown>>; deletes?: string[] }
            revision += 1
            for (const entry of payload.entries ?? []) {
              const row = {
                key: String(entry.key), kind: String(entry.kind), json: String(entry.json),
                updated_at: Number(entry.updated_at ?? Date.now()), revision, deleted: 0 as const,
              }
              rows.set(row.key, row)
            }
            for (const key of payload.deletes ?? []) {
              const previous = rows.get(key)
              rows.set(key, {
                key, kind: previous?.kind ?? 'word', json: previous?.json ?? 'null',
                updated_at: Date.now(), revision, deleted: 1,
              })
            }
            cb?.(id, JSON.stringify({ ok: true, revision }))
            return
          }
          if (req.method === 'contentList') {
            const payload = (req.payload ?? {}) as {
              offset?: number; limit?: number; includeDeleted?: boolean; orderBy?: string; fromRevision?: number
            }
            const limit = Number(payload.limit ?? 200)
            const offset = Number(payload.offset ?? 0)
            let listed = [...rows.values()]
            if (payload.fromRevision !== undefined) listed = listed.filter((row) => row.revision > Number(payload.fromRevision))
            if (payload.includeDeleted === false) listed = listed.filter((row) => row.deleted === 0)
            listed.sort(payload.orderBy === 'revision'
              ? (a, b) => a.revision - b.revision || a.key.localeCompare(b.key)
              : (a, b) => a.key.localeCompare(b.key))
            cb?.(id, JSON.stringify({ ok: true, rows: listed.slice(offset, offset + limit), revision, hasMore: offset + limit < listed.length }))
            return
          }
          if (req.method === 'contentGet') {
            const keys = ((req.payload ?? {}) as { keys?: string[] }).keys ?? []
            cb?.(id, JSON.stringify({ ok: true, rows: keys.map((key) => rows.get(key)).filter(Boolean), revision }))
            return
          }
          cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        } catch (error) {
          cb?.(id, JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }))
        }
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  } as never)
  return {
    rows,
    seed(key: string, kind: string, value: unknown) {
      revision += 1
      rows.set(key, { key, kind, json: JSON.stringify(value), updated_at: Date.now(), revision, deleted: 0 })
    },
    failContentWriteAt(n: number | null) {
      failAtWrite = n
      writeCount = 0
    },
    liveEntityRows() {
      return [...rows.values()].filter((row) => row.deleted === 0 && (row.kind === 'deck' || row.kind === 'word'))
    },
    tombstonedKeys() {
      return [...rows.values()].filter((row) => row.deleted === 1).map((row) => row.key)
    },
  }
}

function stubNativeApk(): void {
  ;(globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }).MomoBridge = { isNativeApp: () => 'momo-apk' }
}

async function enableNativeV15(): Promise<void> {
  stubNativeApk()
  await primeLegacySqliteContentSource()
  await getDb().meta.put({ key: 'contentMigrationV15', value: 'done', updatedAt: Date.now() })
}

/** content_kv live 实体行（deck/word）应与 IDB 自定义内容一致（hash/JSON 比对） */
async function expectContentCacheParity(mock: ReturnType<typeof installContentMock>): Promise<void> {
  const db = getDb()
  const live = new Map(mock.liveEntityRows().map((row) => [row.key, row]))
  const decks = await db.decks.toArray()
  const customDeckIds = new Set(decks.filter((deck) => !deck.builtinKey && deck.source !== 'builtin').map((deck) => deck.id))
  for (const deck of decks) {
    if (!customDeckIds.has(deck.id)) continue
    const row = live.get(`deck:${deck.id}`)
    expect(row, `content_kv 缺 deck:${deck.id}`).toBeTruthy()
    expect(JSON.parse(row!.json)).toEqual(deck)
  }
  for (const word of await db.words.toArray()) {
    if (!customDeckIds.has(word.deckId)) continue
    const row = live.get(`word:${word.id}`)
    expect(row, `content_kv 缺 word:${word.id}`).toBeTruthy()
    expect(JSON.parse(row!.json)).toEqual(word)
  }
  // 反向：content_kv live deck/word 行都能在 cache 找到（旧行已被差集 tombstone）
  for (const key of live.keys()) {
    if (key.startsWith('deck:')) expect(await db.decks.get(key.slice('deck:'.length))).toBeTruthy()
    if (key.startsWith('word:')) expect(await db.words.get(key.slice('word:'.length))).toBeTruthy()
  }
}

async function makeMigrationText(): Promise<{ text: string; deckId: string }> {
  await resetDatabase()
  const deck = await createDeck({
    name: '0.15 导入库',
    words: [
      { headword: 'alpha', meanings: [{ cn: '甲' }] },
      { headword: 'beta', meanings: [{ cn: '乙' }] },
    ],
  })
  return { text: JSON.stringify(await buildMigrationFile()), deckId: deck.id }
}

beforeEach(async () => {
  await resetDatabase()
})

afterEach(async () => {
  setSqliteTransport(null)
  delete (globalThis as unknown as { MomoBridge?: unknown }).MomoBridge
})

describe('0.15 B：原生 sqlite 导入后写源不回退 idb', () => {
  it('native v15：导入后 source 仍 sqlite、content_kv/IDB 内容一致、旧 live 行差集 tombstone', async () => {
    const { text, deckId } = await makeMigrationText()
    await resetDatabase()
    await enableNativeV15()
    const mock = installContentMock()
    // 旧 live 行（不在 IDB 内容里）应在导入后被差集 tombstone
    mock.seed('deck:ghost-deck', 'deck', { id: 'ghost-deck', name: 'ghost' })
    mock.seed('word:ghost-deck:ghost', 'word', { id: 'ghost-deck:ghost', deckId: 'ghost-deck' })

    const report = await importMigration(text, { force: true })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    // source 仍 sqlite（0.15 native-aware：v15 done 时恒 sqlite，不依赖 settings）
    expect(await getContentWriteSource()).toBe('sqlite')
    expect(await getDb().decks.get(deckId)).toBeTruthy()
    // 差集 tombstone
    expect(mock.tombstonedKeys()).toContain('deck:ghost-deck')
    expect(mock.tombstonedKeys()).toContain('word:ghost-deck:ghost')
    // 内容一致
    await expectContentCacheParity(mock)
    // 模拟重启：v15 标记仍在、写源仍 sqlite（不因导入被清/重置）
    const marker = (await getDb().meta.get('contentMigrationV15'))?.value as { status?: string } | string
    expect(marker === 'done' || (typeof marker === 'object' && marker.status === 'done')).toBe(true)
    expect(await getContentWriteSource()).toBe('sqlite')
  }, 120_000)

  it('web（无 native 桥 / v15 未完成）：导入后仍 idb', async () => {
    const { text, deckId } = await makeMigrationText()
    await resetDatabase()
    const report = await importMigration(text, { force: true })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(await getContentWriteSource()).toBe('idb')
    expect(await getDb().decks.get(deckId)).toBeTruthy()
  }, 60_000)

  it('内容写 content_kv 第 2 批失败：快照补偿、IDB 不写、无双源分叉', async () => {
    await resetDatabase()
    const deck = await createDeck({
      name: '0.15 大库',
      words: Array.from({ length: 501 }, (_, index) => ({ headword: `w${index + 1}`, meanings: [{ cn: `义${index + 1}` }] })),
    })
    const text = JSON.stringify(await buildMigrationFile())
    await resetDatabase()
    await enableNativeV15()
    const mock = installContentMock()
    mock.failContentWriteAt(2)
    await expect(importMigration(text, { force: true })).rejects.toMatchObject({ code: 'CONTENT_SQLITE_WRITE_FAILED' })
    // 已写批次被补偿为 tombstone，content_kv 无导入 live 行；IDB 未写
    expect(mock.liveEntityRows()).toHaveLength(0)
    expect(await getDb().decks.get(deck.id)).toBeUndefined()
    expect(await getDb().words.count()).toBe(0)
  }, 120_000)

  it('content_kv 写成功但 IDB 事务失败：恢复 content_kv 写前快照，cache 不分叉', async () => {
    const { text, deckId } = await makeMigrationText()
    await resetDatabase()
    await enableNativeV15()
    const mock = installContentMock()
    const failingHook = () => { throw new Error('mock idb transaction fail') }
    getDb().decks.hook('creating', failingHook)
    await expect(importMigration(text, { force: true })).rejects.toThrow(/mock idb transaction fail/)
    // 失败补偿：content_kv 无导入 live 行（写前不存在 → tombstone），IDB 也无该库
    expect(mock.liveEntityRows()).toHaveLength(0)
    expect(await getDb().decks.get(deckId)).toBeUndefined()
  }, 120_000)
})
