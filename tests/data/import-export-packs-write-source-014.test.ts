import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  createDeck,
  exportMigrationText,
  getDb,
  importMigration,
  importPack,
  rebuildContentCacheFromSqlite,
  rejectGeneratedItem,
  resetDatabase,
  setSqliteTransport,
  updateSettings,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1, PackKind } from '../../src/data'

const NOW = new Date(2026, 11, 5, 10, 0, 0).getTime()

async function makePack(items: PackItemV1[], kind: PackKind = 'mixed'): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind,
    createdAt: NOW,
    generator: 'test@1',
    items,
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

async function makeMigrationText(): Promise<string> {
  await resetDatabase()
  const deck = await createDeck({
    name: 'mig-packs',
    words: [
      { headword: 'alpha', meanings: [{ cn: '甲' }] },
      { headword: 'beta', meanings: [{ cn: '乙' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const imported = await importPack(
    JSON.stringify(
      await makePack([
        { headword: 'alpha', headwordLower: 'alpha', examples: [{ en: 'Alpha one.', cn: '甲一' }] },
        { headword: 'beta', headwordLower: 'beta', examples: [{ en: 'Beta two.', cn: '乙二' }] },
      ]),
    ),
  )
  expect(imported.ok, imported.issues.map((issue) => issue.message).join('; ')).toBe(true)
  await rejectGeneratedItem({
    headword: 'gamma',
    headwordLower: 'gamma',
    examples: [{ en: 'Gamma three.', cn: '丙三' }],
  } as PackItemV1)
  return exportMigrationText({ includeContentPacks: true })
}

interface MockRow {
  key: string
  kind: string
  json: string
  updated_at: number
  revision: number
  deleted: 0 | 1
}

interface MockState {
  writes: number
  keys: string[]
  deletes: number
  maxEntriesPerWrite: number
  revision: number
  seq: number
  rows: Map<string, MockRow>
}

/** 内存版 content_kv：支持 contentWrite/contentCounts/contentList/contentGet；fail=true 时 contentWrite 失败 */
function mockSqlite(opts: { fail?: boolean } = {}): MockState {
  const state: MockState = {
    writes: 0,
    keys: [],
    deletes: 0,
    maxEntriesPerWrite: 0,
    revision: 0,
    seq: 0,
    rows: new Map<string, MockRow>(),
  }
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as {
        id: string
        method: string
        payload?: {
          entries?: Array<{ key: string; kind: string; json: string; updated_at?: number }>
          deletes?: string[]
          fromRevision?: number
          limit?: number
          keys?: string[]
        }
      }
      const id = `${req.id}-r${++state.seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'contentWrite') {
          state.writes += 1
          if (opts.fail) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock sqlite fail' }))
            return
          }
          const revision = ++state.revision
          const entries = req.payload?.entries ?? []
          state.maxEntriesPerWrite = Math.max(state.maxEntriesPerWrite, entries.length)
          for (const entry of entries) {
            state.keys.push(entry.key)
            state.rows.set(entry.key, {
              key: entry.key,
              kind: entry.kind,
              json: entry.json,
              updated_at: entry.updated_at ?? Date.now(),
              revision,
              deleted: 0,
            })
          }
          for (const key of req.payload?.deletes ?? []) {
            state.deletes += 1
            state.rows.set(key, {
              key,
              kind: state.rows.get(key)?.kind ?? 'pack',
              json: 'null',
              updated_at: Date.now(),
              revision,
              deleted: 1,
            })
          }
          cb?.(id, JSON.stringify({ ok: true, revision }))
          return
        }
        if (req.method === 'contentCounts') {
          const rows = [...state.rows.values()]
          const alive = rows.filter((row) => row.deleted === 0)
          const byKind: Record<string, number> = {}
          for (const row of alive) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
          cb?.(id, JSON.stringify({ ok: true, total: alive.length, deleted: rows.length - alive.length, byKind, revision: state.revision }))
          return
        }
        if (req.method === 'contentList') {
          const fromRevision = req.payload?.fromRevision ?? 0
          const limit = req.payload?.limit ?? 200
          const rows = [...state.rows.values()]
            .filter((row) => row.revision > fromRevision)
            .sort((a, b) => a.revision - b.revision)
            .slice(0, limit)
          cb?.(id, JSON.stringify({ ok: true, rows, revision: state.revision, hasMore: false }))
          return
        }
        if (req.method === 'contentGet') {
          const keys = req.payload?.keys ?? []
          cb?.(id, JSON.stringify({ ok: true, rows: keys.map((key) => state.rows.get(key)).filter(Boolean) }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return state
}

async function packCounts(): Promise<{ packs: number; items: number; rejects: number }> {
  const db = getDb()
  return {
    packs: await db.packs.count(),
    items: await db.packItems.count(),
    rejects: await db.contentRejects.count(),
  }
}

beforeEach(async () => {
  await resetDatabase()
})

afterEach(() => {
  setSqliteTransport(null)
})

describe('0.14 P0-4：迁移包内容包三表 → content_kv', () => {
  it('sqlite 内容写源 importMigration(replace)：pack/pack-item/content-reject 进 content_kv，IDB cache 同步', async () => {
    const text = await makeMigrationText()
    await resetDatabase()
    await persistContentWriteSource('sqlite')
    const state = mockSqlite()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(state.writes).toBeGreaterThan(0)
    expect(state.maxEntriesPerWrite).toBeLessThanOrEqual(500)
    expect(state.keys.some((key) => key.startsWith('pack:'))).toBe(true)
    expect(state.keys.some((key) => key.startsWith('pack-item:'))).toBe(true)
    expect(state.keys.some((key) => key.startsWith('content-reject:'))).toBe(true)
    // content_kv 存活行 = 1 pack + 2 items + 1 reject
    expect([...state.rows.values()].filter((row) => row.deleted === 0 && ['pack','pack-item','content-reject'].includes(row.kind))).toHaveLength(4)
    expect(await packCounts()).toEqual({ packs: 1, items: 2, rejects: 1 })
  })

  it('sqlite 内容写源 importMigration(merge)：只补本机没有的内容包行', async () => {
    const text = await makeMigrationText()
    // 本机先有一个不同的包（sqlite 内容写源）
    await resetDatabase()
    await persistContentWriteSource('sqlite')
    const state = mockSqlite()
    const local = await importPack(
      JSON.stringify(
        await makePack([{ headword: 'alpha', headwordLower: 'alpha', examples: [{ en: 'Local one.', cn: '本机一' }] }]),
      ),
    )
    expect(local.ok).toBe(true)
    const before = state.keys.length
    const beforePacks = await getDb().packs.count()
    const report = await importMigration(text, { strategy: 'merge' })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    // merge 只写迁移包中本机没有的 pack：均为新增行，不含 tombstone
    expect(state.keys.length).toBeGreaterThan(before)
    expect(state.deletes).toBe(0)
    const db = getDb()
    expect(await db.packs.count()).toBe(beforePacks + 1)
    expect(await db.packItems.count()).toBe(3)
    expect(await db.contentRejects.count()).toBe(1)
  })

  it('sqlite 内容写源 importMigration 失败：结构化错误且 IDB 不回写', async () => {
    const text = await makeMigrationText()
    await resetDatabase()
    await persistContentWriteSource('sqlite')
    const state = mockSqlite({ fail: true })
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.ok).toBe(false)
    expect(report.issues.some((issue) => issue.code === 'E_IO' && issue.path === 'data.contentPacks')).toBe(true)
    // 首次写失败后会尝试补偿（可能再写一次）；关键是不写 IDB/半成品
    expect(state.writes).toBeGreaterThanOrEqual(1)
    // 事务尚未开始：IDB 三表与 decks 都未被写
    expect(await packCounts()).toEqual({ packs: 0, items: 0, rejects: 0 })
    expect(await getDb().decks.count()).toBe(0)
  })

  it('idb 内容写源行为不变：不调 contentWrite，仍写 IDB', async () => {
    const text = await makeMigrationText()
    await resetDatabase()
    await persistContentWriteSource('idb')
    const state = mockSqlite()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(state.writes).toBe(0)
    expect(await packCounts()).toEqual({ packs: 1, items: 2, rejects: 1 })
  })

  it('sqlite 迁移后从 content_kv rebuild cache 一致', async () => {
    const text = await makeMigrationText()
    await resetDatabase()
    await persistContentWriteSource('sqlite')
    const state = mockSqlite()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.ok, report.issues.map((issue) => issue.message).join('; ')).toBe(true)
    const before = await packCounts()
    const filePackIds = [...state.rows.values()]
      .filter((row) => row.deleted === 0 && row.kind === 'pack')
      .map((row) => row.key.replace(/^pack:/, ''))
    // 清空 IDB 内容包 cache，模拟 cache 丢失
    const db = getDb()
    await db.packs.clear()
    await db.packItems.clear()
    await db.contentRejects.clear()
    await persistContentWriteSource('sqlite')
    await db.meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false, written: 4 }, updatedAt: Date.now() })
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok, rebuilt.error).toBe(true)
    const after = await packCounts()
    expect(after).toEqual(before)
    expect((await db.packs.toArray()).map((pack) => pack.id).sort()).toEqual(filePackIds.sort())
  })
})
