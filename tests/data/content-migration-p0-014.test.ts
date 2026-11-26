import './test-utils'
import { primeIdbCacheReady, primeLegacySqliteContentSource } from './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
/**
 * 0.14 QA P0：清空数据必须清 content_kv（否则重建 cache 内容复活）；facts-only 迁移自定义 deck/words 写 content_kv。
 *
 * 约定：
 * - clearAllData 在 content_kv 有内容（sqlite 写源 / 影子迁移存在）时先写 tombstone 清空；
 *   失败用快照恢复已清行并抛结构化错误，IDB 完全未动。
 * - importMigrationSqlite（facts-only）自定义 deck/words 先写 content_kv（≤500/批）→ 失败不写 IDB；
 *   成功后重建 cache 仍保留自定义内容。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildMigrationFile,
  clearAllData,
  createDeck,
  getDb,
  getSettings,
  importMigration,
  rebuildContentCacheFromSqlite,
  resetDatabase,
  setSqliteTransport,
  persistLearningWriteSource,
} from '../../src/data'
import { importMigrationSqlite } from '../../src/data/import-export'
import { persistSettingsWriteMode } from '../../src/data/settings.repo'

interface NativeKvRow {
  key: string
  kind: string
  json: string
  updated_at: number
  revision: number
  deleted: 0 | 1
}

interface WritePayload {
  entries: Array<{ key: string; kind: string; json: string }>
  deletes: string[]
}

/**
 * 原生 mock：content_* 协议 + 迁移所需 facts 协议（health/query/tx/backup/restore）。
 * - content_kv 为内存 Map（revision 每次 contentWrite +1，同批行共享 revision）；
 * - health/query 按当前 IDB facts 动态返回，保证 facts-only 迁移的 counts 校验可过。
 */
function installNativeMock() {
  const rows = new Map<string, NativeKvRow>()
  const writes: WritePayload[] = []
  let revision = 0
  let seq = 0
  let contentWriteCount = 0
  let failAtWrite: number | null = null
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        void (async () => {
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
              contentWriteCount += 1
              if (failAtWrite !== null && contentWriteCount === failAtWrite) {
                cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock content write fail' }))
                return
              }
              const payload = (req.payload ?? {}) as { entries?: Array<Record<string, unknown>>; deletes?: string[] }
              revision += 1
              const entries = (payload.entries ?? []).map((entry) => ({
                key: String(entry.key),
                kind: String(entry.kind),
                json: String(entry.json),
                updated_at: Number(entry.updated_at ?? Date.now()),
              }))
              const deletes = payload.deletes ?? []
              for (const entry of entries) rows.set(entry.key, { ...entry, revision, deleted: 0 })
              for (const key of deletes) {
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
              const payload = (req.payload ?? {}) as { fromRevision?: number }
              const from = Number(payload.fromRevision ?? 0)
              const listed = [...rows.values()].filter((row) => row.revision > from).sort((a, b) => a.revision - b.revision)
              cb?.(id, JSON.stringify({ ok: true, rows: listed, revision, hasMore: false }))
              return
            }
            if (req.method === 'contentGet') {
              const payload = (req.payload ?? {}) as { keys?: string[] }
              cb?.(id, JSON.stringify({ ok: true, rows: (payload.keys ?? []).map((key) => rows.get(key)).filter(Boolean), revision }))
              return
            }
            if (req.method === 'health') {
              const db = getDb()
              const [states, plans, settings, reviewLogs] = await Promise.all([
                db.states.count(), db.plans.count(), db.settings.count(), db.reviewLogs.count(),
              ])
              cb?.(id, JSON.stringify({ ok: true, userVersion: 3, readOnly: false, counts: { states, plans, settings, review_logs: reviewLogs } }))
              return
            }
            if (req.method === 'query') {
              const table = String((req.payload ?? {}).table ?? '')
              const db = getDb()
              let queryRows: unknown[] = []
              if (table === 'settings') {
                queryRows = (await db.settings.toArray()).map((row) => ({ key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updatedAt }))
              }
              cb?.(id, JSON.stringify({ ok: true, rows: queryRows }))
              return
            }
            if (req.method === 'backup') {
              cb?.(id, JSON.stringify({ ok: true, name: 'mock-facts.db', path: '/tmp/mock-facts.db', bytes: 1024, checksum: 'mock', createdAt: Date.now(), integrityOk: true }))
              return
            }
            cb?.(id, JSON.stringify({ ok: true, rows: [] }))
          } catch (error) {
            cb?.(id, JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }))
          }
        })()
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  } as never)
  return {
    rows,
    writes,
    entries: () => writes.flatMap((write) => write.entries),
    deletedKeys: () => writes.flatMap((write) => write.deletes),
    failContentWriteAt(n: number | null) {
      failAtWrite = n
      contentWriteCount = 0
    },
    resetWriteCounter() {
      contentWriteCount = 0
    },
  }
}

async function useContentSqlite(): Promise<void> {
  // C-04 后 settings 读路径 cache meta 缺失会 fail-closed 回源 SQLite，写源会被判成 idb
  await primeLegacySqliteContentSource()
}

/** 重建 cache 的门禁：写源=sqlite 且 contentMigrationState=ready */
async function enableCacheRebuild(): Promise<void> {
  await persistContentWriteSource('sqlite')
  await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false }, updatedAt: Date.now() })
}

beforeEach(async () => {
  await resetDatabase(); await primeIdbCacheReady()
})

afterEach(async () => {
  setSqliteTransport(null)
  await persistLearningWriteSource('idb').catch(() => undefined)
  await persistSettingsWriteMode('idb').catch(() => undefined)
})

describe('0.14 QA P0 clearAllData：清 content_kv', () => {
  it('sqlite 内容写源：clearAllData 写 tombstone 清空 content_kv；重建 cache 后自定义内容不复活', async () => {
    await useContentSqlite()
    const mock = installNativeMock()
    const deck = await createDeck({ name: '清空库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    expect(mock.rows.size).toBeGreaterThan(0)

    await clearAllData({ unsafe: true })

    // content_kv 全部 tombstone
    expect([...mock.rows.values()].every((row) => row.deleted === 1)).toBe(true)
    expect(mock.rows.has(`deck:${deck.id}`)).toBe(true)
    // IDB 已清空
    expect(await getDb().decks.count()).toBe(0)
    expect(await getDb().words.count()).toBe(0)

    // 重建 cache：被清内容不复活（内置词库来自资源不计入）
    await enableCacheRebuild()
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok, rebuilt.error ?? '').toBe(true)
    expect(await getDb().decks.get(deck.id)).toBeUndefined()
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(0)
  }, 120_000)

  it('迁移存在但写源已是 idb：仍清 content_kv（防之后切源复活）', async () => {
    await useContentSqlite()
    const mock = installNativeMock()
    const deck = await createDeck({ name: '影子迁移库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    // 模拟影子迁移存在、写源回 idb
    await persistContentWriteSource('idb')
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false }, updatedAt: Date.now() })

    await clearAllData({ unsafe: true })
    expect([...mock.rows.values()].every((row) => row.deleted === 1)).toBe(true)
    expect(mock.rows.has(`deck:${deck.id}`)).toBe(true)
    expect(await getDb().decks.count()).toBe(0)
  }, 30_000)

  it('清 content_kv 失败：用快照恢复已清行并抛结构化错误，IDB 完全未动', async () => {
    await useContentSqlite()
    const mock = installNativeMock()
    const deck = await createDeck({
      name: '清空失败库',
      words: Array.from({ length: 501 }, (_, index) => ({ headword: `w${index + 1}`, meanings: [{ cn: `义${index + 1}` }] })),
    })
    expect(mock.rows.size).toBe(502) // deck + 501 words
    mock.failContentWriteAt(2) // 清空第 2 批失败
    const error = await clearAllData({ unsafe: true }).catch((reason: unknown) => reason)
    // 0.16（4d60f6c）：clearAllData 失败统一包成 Error（原 code 只保留在 message 里）；
    // 本 mock 未实现 restoreDb，安全快照回滚会报失败，因此 message 带“安全快照回滚失败”。
    expect(String((error as Error).message)).toMatch(/清空 content_kv 失败/)
    expect(String((error as Error).message)).toMatch(/安全快照回滚失败/)
    // 已清批次被快照恢复，全部回到 deleted=0；IDB 未被清空
    expect([...mock.rows.values()].every((row) => row.deleted === 0)).toBe(true)
    expect(await getDb().decks.get(deck.id)).toBeTruthy()
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(501)
  }, 120_000)
})

describe('0.14 QA P0 importMigration facts-only：自定义 deck/words 写 content_kv', () => {
  it('迁移后内容写 content_kv；重建 cache 保留自定义 deck/word', async () => {
    const deck = await createDeck({ name: 'facts 迁移库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const migrationText = JSON.stringify(await buildMigrationFile())
    await resetDatabase(); await primeIdbCacheReady()
    await useContentSqlite()
    const mock = installNativeMock()

    const report = await importMigrationSqlite(migrationText, { preBackup: async () => ({ ok: true }) })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(mock.entries().some((entry) => entry.key === `deck:${deck.id}`)).toBe(true)
    expect(mock.entries().some((entry) => entry.key === `word:${deck.id}:alpha` && entry.kind === 'word')).toBe(true)
    // IDB cache 由写源 helper 同步
    expect(await getDb().decks.get(deck.id)).toBeTruthy()

    // 模拟 cache 丢失后从 content_kv 重建：自定义内容保留
    await getDb().decks.clear()
    await getDb().words.clear()
    await enableCacheRebuild()
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok, rebuilt.error ?? '').toBe(true)
    expect((await getDb().decks.get(deck.id))?.name).toBe('facts 迁移库')
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
  }, 120_000)

  it('内容写 content_kv 失败：结构化错误且 IDB 不写自定义 deck/word', async () => {
    const deck = await createDeck({ name: 'facts 失败库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const migrationText = JSON.stringify(await buildMigrationFile())
    await resetDatabase(); await primeIdbCacheReady()
    await useContentSqlite()
    const mock = installNativeMock()
    mock.failContentWriteAt(1)

    const error = await importMigrationSqlite(migrationText, { preBackup: async () => ({ ok: true }) }).catch((reason: unknown) => reason)
    expect((error as { code?: string }).code).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect(await getDb().decks.get(deck.id)).toBeUndefined()
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(0)
  }, 120_000)
})

describe('0.14 G1 importMigration 主路径：自定义 deck/words 写 content_kv', () => {
  it('迁移后 content_kv 有 deck:/word:；重建 cache 保留自定义 deck/word', async () => {
    const deck = await createDeck({ name: '主迁移库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const migrationText = JSON.stringify(await buildMigrationFile())
    await resetDatabase(); await primeIdbCacheReady()
    await useContentSqlite()
    const mock = installNativeMock()
    const report = await importMigration(migrationText, { force: true })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(mock.entries().some((entry) => entry.key === `deck:${deck.id}`)).toBe(true)
    expect(mock.entries().some((entry) => entry.key === `word:${deck.id}:alpha` && entry.kind === 'word')).toBe(true)

    await getDb().decks.clear()
    await getDb().words.clear()
    await enableCacheRebuild()
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok, rebuilt.error ?? '').toBe(true)
    expect((await getDb().decks.get(deck.id))?.name).toBe('主迁移库')
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(1)
  }, 120_000)

  it('content 写失败：结构化错误且 IDB 不写自定义 deck/word', async () => {
    const deck = await createDeck({ name: '主迁移失败库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const migrationText = JSON.stringify(await buildMigrationFile())
    await resetDatabase(); await primeIdbCacheReady()
    await useContentSqlite()
    const mock = installNativeMock()
    mock.failContentWriteAt(1)
    await expect(importMigration(migrationText, { force: true })).rejects.toMatchObject({
      code: 'CONTENT_SQLITE_WRITE_FAILED',
    })
    expect(await getDb().decks.get(deck.id)).toBeUndefined()
    expect(await getDb().words.where('deckId').equals(deck.id).count()).toBe(0)
  }, 60_000)
})

describe('0.14 G2 恢复包写源：强制 idb + 清迁移状态', () => {
  it('包内 data.contentWriteSource=sqlite 恢复后仍 idb，contentMigrationState 清空', async () => {
    const deck = await createDeck({ name: '写源包', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    await persistContentWriteSource('sqlite')
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    const migrationText = JSON.stringify(await buildMigrationFile())
    await resetDatabase(); await primeIdbCacheReady()

    const report = await importMigration(migrationText, { force: true })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    // 包内 settings 里的 sqlite 写源被排除；恢复后强制 idb
    expect((await getSettings())['data.contentWriteSource']).toBe('idb')
    expect(await getDb().meta.get('contentMigrationState')).toBeUndefined()
    // 内容走 IDB 事实源，不产生双源
    expect((await getDb().decks.get(deck.id))?.name).toBe('写源包')
  }, 60_000)
})

describe('0.14 QA 闭环 B-G2/B-G3/packs 分批 + S2', () => {
  async function buildMigrationWithPacks(itemCount: number): Promise<string> {
    const db = getDb()
    await db.packs.put({
      id: 'pack-a', name: 'pack-a', kind: 'mixed', formatVersion: 1, checksum: 'x', source: 'manual',
      status: 'reviewing', counts: { items: 0, pending: 0, approved: 0, applied: 0, rejected: 0, skipped: 0 },
      createdAt: 1, updatedAt: 1,
    } as never)
    for (let index = 0; index < itemCount; index += 1) {
      await db.packItems.put({
        id: `item-${index}`, packId: 'pack-a', seq: index, headword: 'alpha', headwordLower: 'alpha',
        payload: { headword: 'alpha' }, status: 'pending', contentHashes: [], createdAt: 1,
      } as never)
    }
    await db.contentRejects.put({ id: 'reject-a', kind: 'examples', headwordLower: 'alpha', hash: 'h', rejectedAt: 1 } as never)
    return JSON.stringify(await buildMigrationFile({ includeContentPacks: true }))
  }

  it('B-G2：replace 只 tombstone 差集，同一批 entries/deletes 无同 key', async () => {
    const migrationText = await buildMigrationWithPacks(1)
    await resetDatabase(); await primeIdbCacheReady()
    await useContentSqlite()
    // 本机已有同 id pack（应 upsert 而非 tombstone）与额外 item/reject（差集，应 tombstone）
    await getDb().packs.put({
      id: 'pack-a', name: 'old-a', kind: 'mixed', formatVersion: 1, checksum: 'old', source: 'manual',
      status: 'reviewing', counts: { items: 0, pending: 0, approved: 0, applied: 0, rejected: 0, skipped: 0 },
      createdAt: 1, updatedAt: 1,
    } as never)
    await getDb().packItems.put({ id: 'item-old', packId: 'pack-a', seq: 9, headword: 'beta', headwordLower: 'beta', payload: { headword: 'beta' }, status: 'pending', contentHashes: [], createdAt: 1 } as never)
    await getDb().contentRejects.put({ id: 'reject-old', kind: 'examples', headwordLower: 'beta', hash: 'h2', rejectedAt: 1 } as never)
    const mock = installNativeMock()
    const report = await importMigration(migrationText, { force: true })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    const entryKeys = new Set(mock.entries().map((entry) => entry.key))
    const deleteKeys = new Set(mock.deletedKeys())
    // 同 key 不同时出现在 entries/deletes
    expect([...entryKeys].filter((key) => deleteKeys.has(key))).toEqual([])
    expect(deleteKeys).toContain('pack-item:item-old')
    expect(deleteKeys).toContain('content-reject:reject-old')
    expect(deleteKeys.has('pack:pack-a')).toBe(false)
    expect(entryKeys.has('pack:pack-a')).toBe(true)
  }, 60_000)

  it('B-G3：contentPacks content_kv 写后 IDB 事务失败 → 快照补偿 content_kv', async () => {
    const migrationText = await buildMigrationWithPacks(1)
    await resetDatabase(); await primeIdbCacheReady()
    await useContentSqlite()
    const mock = installNativeMock()
    const failingHook = () => { throw new Error('mock idb transaction fail') }
    getDb().packs.hook('creating', failingHook)
    await expect(importMigration(migrationText, { force: true })).rejects.toThrow(/mock idb transaction fail|Transaction has already completed or failed/)
    // 文件里的 pack 已 tombstones（写前不存在），本机旧内容不会被 content_kv 领先保留
    expect(mock.rows.get('pack:pack-a')?.deleted).toBe(1)
  }, 60_000)

  it('packs 第 2 批失败：结构化失败 + 已写批次补偿 + IDB 不写', async () => {
    const migrationText = await buildMigrationWithPacks(501)
    await resetDatabase(); await primeIdbCacheReady()
    await useContentSqlite()
    const mock = installNativeMock()
    mock.failContentWriteAt(2)
    const report = await importMigration(migrationText, { force: true })
    expect(report.ok).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'E_IO' && /内容包写入失败/.test(issue.message))).toBe(true)
    expect(await getDb().packs.count()).toBe(0)
    expect(await getDb().packItems.count()).toBe(0)
    expect([...mock.rows.values()].every((row) => row.deleted === 1)).toBe(true)
  }, 120_000)

  it('S2：facts-only 恢复丢弃包内 sqlite 写源并清迁移状态', async () => {
    await createDeck({ name: 'S2 库', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    await persistContentWriteSource('sqlite')
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    const migrationText = JSON.stringify(await buildMigrationFile())
    await resetDatabase(); await primeIdbCacheReady()
    await useContentSqlite()
    installNativeMock()
    const report = await importMigrationSqlite(migrationText, { preBackup: async () => ({ ok: true }) })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect((await getSettings())['data.contentWriteSource']).toBe('idb')
    expect(await getDb().meta.get('contentMigrationState')).toBeUndefined()
  }, 60_000)
})
