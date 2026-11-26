import { primeLegacySqliteContentSource } from './test-utils'
import './test-utils'
import { beforeEach, afterEach, describe, expect, it } from 'vitest'
import {
  applyApproved,
  approveItems,
  createDeck,
  deletePack,
  getDb,
  importPack,
  listPackItems,
  rebuildContentCacheFromSqlite,
  resetDatabase,
  setSqliteTransport,
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

async function setupCustomDeck(): Promise<{ deckId: string; wordId: string }> {
  const deck = await createDeck({ name: 'custom-pack-word', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
  const db = getDb()
  const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
  return { deckId: deck.id, wordId: word.id }
}

interface MockRow {
  key: string
  kind: string
  json: string
  updated_at: number
  revision: number
  deleted: 0 | 1
}

interface MockOptions {
  fail?: boolean
  /** 第 N 次 contentWrite 失败（1-based；可运行时改回 0） */
  failAt?: number
}

interface MockState {
  writes: number
  keys: string[]
  deletes: number
  revision: number
  seq: number
  rows: Map<string, MockRow>
}

/** 内存版 content_kv（支持 contentWrite/Counts/List/Get；用于 F5/F6/F7 与 rebuild 一致性断言） */
function mockSqlite(opts: MockOptions = {}): MockState {
  const state: MockState = { writes: 0, keys: [], deletes: 0, revision: 0, seq: 0, rows: new Map<string, MockRow>() }
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
          if (opts.fail || (opts.failAt != null && opts.failAt > 0 && state.writes === opts.failAt)) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock sqlite fail' }))
            return
          }
          const revision = ++state.revision
          for (const entry of req.payload?.entries ?? []) {
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

function aliveRows(state: MockState): MockRow[] {
  return [...state.rows.values()].filter((row) => row.deleted === 0)
}

async function clearContentCache(): Promise<void> {
  const db = getDb()
  await Promise.all([db.packs.clear(), db.packItems.clear(), db.contentRejects.clear(), db.decks.clear(), db.words.clear()])
}

beforeEach(async () => {
  await resetDatabase()
})

afterEach(() => {
  setSqliteTransport(null)
})

describe('0.14 P1 F5：importPack 部分批失败可重试补齐（pack 行最后写）', () => {
  it('chunk2 失败 → 退出无 pack 行/补偿前缀；重试后 700 条 item 全部补齐', async () => {
    const { deckId } = await setupCustomDeck()
    void deckId
    await primeLegacySqliteContentSource()
    const opts: MockOptions = { failAt: 2 }
    const state = mockSqlite(opts)
    const items: PackItemV1[] = Array.from({ length: 700 }, (_, index) => ({
      headword: 'alpha',
      headwordLower: 'alpha',
      examples: [{ en: `Alpha example ${index}.`, cn: `甲例句 ${index}` }],
    }))
    const file = await makePack(items)
    const first = await importPack(JSON.stringify(file))
    expect(first.ok).toBe(false)
    expect(first.written).toBe(500)
    // 失败 attempt 不应留下 pack 行（否则重试命中 reused:true 假成功）
    expect(aliveRows(state).filter((row) => row.kind === 'pack')).toHaveLength(0)
    // 已写前缀行被补偿删除
    expect(aliveRows(state).filter((row) => row.kind === 'pack-item')).toHaveLength(0)

    opts.failAt = 0
    const retry = await importPack(JSON.stringify(file))
    expect(retry.ok, retry.issues.map((issue) => issue.message).join('; ')).toBe(true)
    const retryItems = await listPackItems(retry.packId!)
    expect(retryItems).toHaveLength(700)
    expect(await getDb().packItems.count()).toBe(700)
    expect(aliveRows(state).filter((row) => row.kind === 'pack')).toHaveLength(1)
    expect(aliveRows(state).filter((row) => row.kind === 'pack-item')).toHaveLength(700)
  })
})

describe('0.14 P1 F6：pack apply/delete 同步自定义词 body 到 content_kv', () => {
  it('apply 写 `word:<id>`；rebuild 后内容仍在；删除 pack 后 rebuild 不复活', async () => {
    const { wordId, deckId } = await setupCustomDeck()
    await primeLegacySqliteContentSource()
    const state = mockSqlite()
    const deck = await getDb().decks.get(deckId)
    if (deck) state.rows.set(`deck:${deckId}`, { key: `deck:${deckId}`, kind: 'deck', json: JSON.stringify(deck), updated_at: deck.updatedAt ?? 1, revision: 1, deleted: 0 })
    const imported = await importPack(
      JSON.stringify(
        await makePack([{ headword: 'alpha', headwordLower: 'alpha', examples: [{ en: 'Alpha one.', cn: '甲一' }] }]),
      ),
    )
    expect(imported.ok).toBe(true)
    const pending = (await listPackItems(imported.packId!)).filter((item) => item.status === 'pending').map((item) => item.id)
    await approveItems(imported.packId!, pending)
    const applied = await applyApproved(imported.packId!)
    expect(applied.ok).toBe(true)
    expect(applied.applied).toBe(1)
    // content_kv 有自定义词整行，且包含 apply 后的例句
    const wordRow = state.rows.get(`word:${wordId}`)
    expect(wordRow).toBeTruthy()
    expect(JSON.parse(wordRow!.json).examples.map((example: { en: string }) => example.en)).toContain('Alpha one.')

    // 模拟 cache 丢失 → rebuild：apply 的内容不丢失
    await clearContentCache()
    await primeLegacySqliteContentSource()
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false, written: 4 }, updatedAt: Date.now() })
    const rebuilt = await rebuildContentCacheFromSqlite()
    expect(rebuilt.ok, rebuilt.error).toBe(true)
    const wordAfterRebuild = (await getDb().words.get(wordId))!
    expect(wordAfterRebuild.examples.map((example) => example.en)).toContain('Alpha one.')

    // 删除 pack（removeAppliedContent）→ content_kv 中的自定义词行同步移除内容
    await deletePack(imported.packId!, { removeAppliedContent: true })
    const wordRowAfterDelete = state.rows.get(`word:${wordId}`)
    expect(wordRowAfterDelete).toBeTruthy()
    expect(JSON.parse(wordRowAfterDelete!.json).examples.map((example: { en: string }) => example.en)).not.toContain('Alpha one.')

    // 再次模拟 cache 丢失 → rebuild：已删除内容不复活
    await clearContentCache()
    await primeLegacySqliteContentSource()
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false, written: 4 }, updatedAt: Date.now() })
    const rebuilt2 = await rebuildContentCacheFromSqlite()
    expect(rebuilt2.ok, rebuilt2.error).toBe(true)
    const wordAfterDeleteRebuild = (await getDb().words.get(wordId))!
    expect(wordAfterDeleteRebuild.examples.map((example) => example.en)).not.toContain('Alpha one.')
  })
})

describe('0.14 P1 F7：applyApproved 返回 ok/错误码/已应用/失败项', () => {
  it('成功返回 ok:true/failed:0；sqlite 写失败返回 ok:false + 错误码 + 失败项且 IDB 不回写', async () => {
    await setupCustomDeck()
    await primeLegacySqliteContentSource()
    const opts: MockOptions = {}
    const state = mockSqlite(opts)
    const imported = await importPack(
      JSON.stringify(
        await makePack([{ headword: 'alpha', headwordLower: 'alpha', examples: [{ en: 'Alpha one.', cn: '甲一' }] }]),
      ),
    )
    expect(imported.ok).toBe(true)
    const itemIds = (await listPackItems(imported.packId!)).filter((item) => item.status === 'pending').map((item) => item.id)
    await approveItems(imported.packId!, itemIds)

    // 让下一次 contentWrite 失败（即 apply 的 pack-item 写入）
    opts.failAt = state.writes + 1
    const failed = await applyApproved(imported.packId!)
    expect(failed.ok).toBe(false)
    expect(failed.errorCode).toBe('CONTENT_SQLITE_WRITE_FAILED')
    expect(failed.applied).toBe(0)
    expect(failed.failed).toBe(1)
    expect(failed.failedItems?.map((item) => item.itemId)).toEqual(itemIds)
    expect(failed.errors?.length).toBeGreaterThan(0)
    // 失败批未回写 IDB：条目仍 approved、Word 未被合并
    expect((await getDb().packItems.get(itemIds[0]!))?.status).toBe('approved')
    const word = (await getDb().words.where('headwordLower').equals('alpha').toArray())[0]!
    expect(word.examples.map((example) => example.en)).not.toContain('Alpha one.')

    // 恢复成功：重试 apply -> ok:true / failed:0
    opts.failAt = 0
    const retry = await applyApproved(imported.packId!)
    expect(retry.ok).toBe(true)
    expect(retry.errorCode).toBeUndefined()
    expect(retry.applied).toBe(1)
    expect(retry.failed).toBe(0)
    expect(retry.failedItems).toBeUndefined()
    const db = getDb()
    expect((await db.packItems.get(itemIds[0]!))?.status).toBe('applied')
    const merged = (await db.words.where('headwordLower').equals('alpha').toArray())[0]!
    expect(merged.examples.map((example) => example.en)).toContain('Alpha one.')
  })
})
