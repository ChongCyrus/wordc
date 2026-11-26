import './test-utils'
import { primeIdbCacheReady, primeLegacySqliteContentSource, resetContentSourceToIdb } from './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  applyApproved,
  approveItems,
  clearRejects,
  createDeck,
  deletePack,
  getDb,
  importPack,
  listPackItems,
  rejectItems,
  resetDatabase,
  setSqliteTransport,
  updateSettings,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1, PackKind } from '../../src/data'

const NOW = new Date(2026, 11, 5, 10, 0, 0).getTime()

async function makePack(items: PackItemV1[], kind: PackKind = 'mixed', extras: Partial<PackFileV1> = {}): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind,
    createdAt: NOW,
    generator: 'test@1',
    items,
    ...extras,
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

async function setupDeck() {
  const deck = await createDeck({
    name: 'pack write source',
    words: [
      { headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }] },
      { headword: 'beta', meanings: [{ pos: 'n.', cn: '乙' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

function examplePackFile(): Promise<PackFileV1> {
  return makePack([
    { headword: 'alpha', headwordLower: 'alpha', examples: [{ en: 'Alpha one.', cn: '甲一' }] },
  ])
}

/** 不同 checksum 的第二个包（避免命中「已存在同 checksum → reused」快路径） */
function secondPackFile(): Promise<PackFileV1> {
  return makePack([
    { headword: 'beta', headwordLower: 'beta', examples: [{ en: 'Beta two.', cn: '乙二' }] },
  ])
}

interface MockSqliteState {
  writes: number
  keys: string[]
  kinds: string[]
  deletes: number
  maxEntriesPerWrite: number
  revision: number
  seq: number
}

/** 记录 contentWrite 的 key/kind/deletes；fail=true 时所有 contentWrite 返回 E_IO */
function mockSqlite(opts: { fail?: boolean } = {}): MockSqliteState {
  const state: MockSqliteState = { writes: 0, keys: [], kinds: [], deletes: 0, maxEntriesPerWrite: 0, revision: 0, seq: 0 }
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as {
        id: string
        method: string
        payload?: { entries?: Array<{ key: string; kind: string }>; deletes?: string[] }
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
          const entries = req.payload?.entries ?? []
          state.maxEntriesPerWrite = Math.max(state.maxEntriesPerWrite, entries.length + (req.payload?.deletes?.length ?? 0))
          for (const entry of entries) {
            state.keys.push(entry.key)
            state.kinds.push(entry.kind)
          }
          state.deletes += req.payload?.deletes?.length ?? 0
          state.revision += 1
          cb?.(id, JSON.stringify({ ok: true, revision: state.revision }))
          return
        }
        if (req.method === 'contentCounts') {
          cb?.(id, JSON.stringify({ ok: true, total: 0, deleted: 0, byKind: {}, revision: state.revision }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return state
}

async function importInIdb(file: PackFileV1): Promise<string> {
  // C-04：meta 缺失时 settings 读回源 SQLite（mock 空行）→ selectedDeckId 读不到 → 词库匹配失败
  await primeIdbCacheReady()
  await persistContentWriteSource('idb')
  const imported = await importPack(JSON.stringify(file))
  expect(imported.ok, imported.issues.map((issue) => issue.message).join('; ')).toBe(true)
  return imported.packId!
}

async function approveAllInIdb(packId: string): Promise<string[]> {
  const items = await listPackItems(packId)
  const pending = items.filter((item) => item.status === 'pending').map((item) => item.id)
  await approveItems(packId, pending)
  return pending
}

async function switchToSqlite(): Promise<void> {
  // C-04 后 settings 读路径 cache meta 缺失会 fail-closed 回源 SQLite（mock 无 settings）→ 写源被判 idb
  await primeLegacySqliteContentSource()
}

beforeEach(async () => {
  await resetDatabase()
  await resetContentSourceToIdb()
})

afterEach(() => {
  setSqliteTransport(null)
})

describe('0.14 内容包写入口 → 统一内容写源（packs/packItems/contentRejects）', () => {
  it('importPack(sqlite) 成功：contentWrite 带 pack:/pack-item: key，IDB cache 同步', async () => {
    await setupDeck()
    await switchToSqlite()
    const state = mockSqlite()
    const imported = await importPack(JSON.stringify(await examplePackFile()))
    expect(imported.ok, imported.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(state.writes).toBeGreaterThan(0)
    expect(state.keys.some((key) => key.startsWith('pack:'))).toBe(true)
    expect(state.keys.some((key) => key.startsWith('pack-item:'))).toBe(true)
    const db = getDb()
    expect((await db.packs.get(imported.packId!))?.id).toBe(imported.packId)
    expect(await listPackItems(imported.packId!)).toHaveLength(1)
  })

  it('importPack(sqlite) 大批量：按 ≤500/批写 content_kv', async () => {
    await setupDeck()
    await switchToSqlite()
    const state = mockSqlite()
    const items = Array.from({ length: 501 }, (_, index) => ({
      headword: 'alpha',
      headwordLower: 'alpha',
      examples: [{ en: `Alpha example ${index}.`, cn: `甲例句 ${index}` }],
    }))
    const imported = await importPack(JSON.stringify(await makePack(items)))
    expect(imported.ok, imported.issues.map((issue) => issue.message).join('; ')).toBe(true)
    expect(state.writes).toBeGreaterThanOrEqual(2)
    expect(state.maxEntriesPerWrite).toBeLessThanOrEqual(500)
    expect(state.keys.filter((key) => key.startsWith('pack-item:')).length).toBe(501)
  })

  it('importPack(sqlite) 失败：返回结构化错误与 written=0，IDB 不写（无 pack/packItems）', async () => {
    await setupDeck()
    await switchToSqlite()
    const state = mockSqlite({ fail: true })
    const imported = await importPack(JSON.stringify(await examplePackFile()))
    expect(imported.ok).toBe(false)
    expect(imported.written).toBe(0)
    expect(imported.issues.some((issue) => issue.code === 'E_IO')).toBe(true)
    expect(state.writes).toBe(1)
    const db = getDb()
    expect(await db.packs.count()).toBe(0)
    expect(await db.packItems.count()).toBe(0)
  })

  it('importPack(idb) 行为不变：不调用 contentWrite，仍写 IDB', async () => {
    await setupDeck()
    await persistContentWriteSource('idb')
    const state = mockSqlite()
    const imported = await importPack(JSON.stringify(await examplePackFile()))
    expect(imported.ok).toBe(true)
    expect(state.writes).toBe(0)
    const db = getDb()
    expect(await db.packs.count()).toBe(1)
    expect(await db.packItems.count()).toBe(1)
  })

  it('approveItems(sqlite)：先写 content_kv（item+pack 计数），失败抛错且 IDB 状态不变', async () => {
    await setupDeck()
    const packId = await importInIdb(await examplePackFile())
    const items = await listPackItems(packId)
    const pending = items.filter((item) => item.status === 'pending').map((item) => item.id)

    await switchToSqlite()
    const state = mockSqlite()
    await approveItems(packId, pending)
    expect(state.writes).toBeGreaterThan(0)
    expect(state.keys.filter((key) => key.startsWith('pack-item:')).length).toBeGreaterThan(0)
    expect((await getDb().packItems.get(pending[0]!))?.status).toBe('approved')

    // 失败批次：另一个新包，approve 失败 -> 抛错，IDB 仍为 pending
    const packId2 = await importInIdb(await secondPackFile())
    const pending2 = (await listPackItems(packId2)).filter((item) => item.status === 'pending').map((item) => item.id)
    await switchToSqlite()
    const failState = mockSqlite({ fail: true })
    await expect(approveItems(packId2, pending2)).rejects.toThrow(/失败|fail|SQLite/)
    expect(failState.writes).toBe(1)
    expect((await getDb().packItems.get(pending2[0]!))?.status).toBe('pending')
  })

  it('rejectItems(sqlite)：写 pack-item + content-reject；失败不回写 IDB', async () => {
    await setupDeck()
    const packId = await importInIdb(await examplePackFile())
    const pending = await approveAllInIdb(packId)

    await switchToSqlite()
    const state = mockSqlite()
    await rejectItems(packId, pending)
    expect(state.keys.some((key) => key.startsWith('content-reject:'))).toBe(true)
    expect((await getDb().packItems.get(pending[0]!))?.status).toBe('rejected')
    expect(await getDb().contentRejects.count()).toBe(1)

    // 失败：新包仍 approved，拒绝记录不写入
    const packId2 = await importInIdb(await secondPackFile())
    const pending2 = await approveAllInIdb(packId2)
    await switchToSqlite()
    const failState = mockSqlite({ fail: true })
    await expect(rejectItems(packId2, pending2)).rejects.toThrow(/失败|fail|SQLite/)
    expect(failState.writes).toBe(1)
    expect((await getDb().packItems.get(pending2[0]!))?.status).toBe('approved')
    expect(await getDb().contentRejects.count()).toBe(1)
  })

  it('clearRejects(sqlite)：写 tombstone；失败保留 IDB 拒绝记录', async () => {
    await setupDeck()
    const packId = await importInIdb(await examplePackFile())
    const pending = await approveAllInIdb(packId)
    await rejectItems(packId, pending)
    expect(await getDb().contentRejects.count()).toBe(1)

    await switchToSqlite()
    const failState = mockSqlite({ fail: true })
    await expect(clearRejects()).rejects.toThrow(/失败|fail|SQLite/)
    expect(failState.writes).toBe(1)
    expect(await getDb().contentRejects.count()).toBe(1)

    const state = mockSqlite()
    await clearRejects()
    expect(state.deletes).toBeGreaterThan(0)
    expect(await getDb().contentRejects.count()).toBe(0)
  })

  it('applyApproved(sqlite)：成功写 pack-item 并更新 IDB cache；失败返回已写/错误且不回写 IDB', async () => {
    await setupDeck()
    const packId = await importInIdb(await examplePackFile())
    await approveAllInIdb(packId)
    await switchToSqlite()
    const state = mockSqlite()
    const result = await applyApproved(packId)
    expect(result.applied).toBe(1)
    expect(state.keys.filter((key) => key.startsWith('pack-item:')).length).toBeGreaterThan(0)
    const db = getDb()
    const items = await listPackItems(packId)
    expect(items[0]!.status).toBe('applied')
    const word = (await db.words.where('headwordLower').equals('alpha').toArray())[0]!
    expect(word.examples.map((example) => example.en)).toContain('Alpha one.')

    // 失败：新包 apply 时 SQLite 写失败 -> 返回 errors、applied=0，IDB 条目仍 approved、Word 未合并
    const packId2 = await importInIdb(await secondPackFile())
    await approveAllInIdb(packId2)
    await switchToSqlite()
    const failState = mockSqlite({ fail: true })
    const failed = await applyApproved(packId2)
    expect(failed.applied).toBe(0)
    expect(failed.errors?.length).toBeGreaterThan(0)
    expect(failState.writes).toBe(1)
    expect((await listPackItems(packId2))[0]!.status).toBe('approved')
    const beta = (await getDb().words.where('headwordLower').equals('beta').toArray())[0]!
    expect(beta.examples.map((example) => example.en)).not.toContain('Beta two.')
  })

  it('deletePack(sqlite)：成功写 pack/pack-item tombstone；失败不删 IDB cache', async () => {
    await setupDeck()
    const packId = await importInIdb(await examplePackFile())
    await switchToSqlite()
    const failState = mockSqlite({ fail: true })
    await expect(deletePack(packId)).rejects.toThrow(/失败|fail|SQLite/)
    expect(failState.writes).toBe(1)
    expect(await getDb().packs.get(packId)).toBeTruthy()

    const state = mockSqlite()
    await deletePack(packId)
    expect(state.deletes).toBeGreaterThanOrEqual(2) // pack + pack-item
    expect(await getDb().packs.get(packId)).toBeUndefined()
    expect(await getDb().packItems.where('packId').equals(packId).count()).toBe(0)
  })

  it('idb 模式 approve/reject/apply 全链路行为不变：不调用 contentWrite', async () => {
    await setupDeck()
    await persistContentWriteSource('idb')
    const state = mockSqlite()
    const packId = await importInIdb(await examplePackFile())
    const pending = await approveAllInIdb(packId)
    await rejectItems(packId, [])
    await applyApproved(packId)
    expect(state.writes).toBe(0)
    expect(pending).toHaveLength(1)
    expect((await listPackItems(packId))[0]!.status).toBe('applied')
  })
})
