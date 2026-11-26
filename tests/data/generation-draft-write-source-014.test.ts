import './test-utils'
import { primeLegacySqliteContentSource } from './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
/**
 * 0.14 B3：AI 生成草稿写入口统一走 content-write-source。
 *
 * 覆盖 generation-draft 的四个写点（pack 记录 / packItems 追加 / 断点更新 / 草稿删除）：
 * - sqlite 成功 → 先写 content_kv（key `pack:<id>` / `pack-item:<id>`），成功后 IDB cache 同步
 * - sqlite 失败 → 抛结构化 ContentWriteError（code CONTENT_SQLITE_WRITE_FAILED），IDB 不回写
 * - idb 模式 → 不调用 contentWrite，行为与改造前一致
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ContentWriteError } from '../../src/data'
import {
  appendGenerationDraftItems,
  clearGenerationDraft,
  createGenerationDraft,
  getDb,
  getGenerationDraft,
  listGenerationDraftItems,
  listGenerationDrafts,
  resetDatabase,
  setSqliteTransport,
  updateGenerationDraftCursor,
} from '../../src/data'
import type { PackItemV1 } from '../../src/data'

afterEach(() => setSqliteTransport(null))

function payload(headword: string, meaningIndex?: number): PackItemV1 {
  return {
    headword,
    ...(meaningIndex != null ? { meaningIndex } : {}),
    examples: [{ en: `${headword} example`, cn: '例句' }],
  }
}

function input(headword: string, meaningIndex?: number) {
  return {
    headwordLower: headword.toLowerCase(),
    ...(meaningIndex != null ? { meaningIndex } : {}),
    payload: payload(headword, meaningIndex),
  }
}

interface CapturedEntry { key: string; kind: string; json: string; updated_at?: number }

interface MockSqliteState {
  writes: number
  entries: CapturedEntry[]
  deletes: string[]
  maxEntriesPerWrite: number
  revision: number
  seq: number
}

/** 记录 contentWrite 的 entries/deletes；fail=true 时所有 contentWrite 返回 E_IO */
function mockSqlite(opts: { fail?: boolean } = {}): MockSqliteState {
  const state: MockSqliteState = { writes: 0, entries: [], deletes: [], maxEntriesPerWrite: 0, revision: 0, seq: 0 }
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as {
        id: string
        method: string
        payload?: { entries?: CapturedEntry[]; deletes?: string[] }
      }
      const id = `${req.id}-r${++state.seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, json: string) => void }).__momoSqliteResult
        if (req.method === 'contentWrite') {
          state.writes += 1
          if (opts.fail) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock sqlite fail' }))
            return
          }
          const entries = req.payload?.entries ?? []
          const deletes = req.payload?.deletes ?? []
          state.maxEntriesPerWrite = Math.max(state.maxEntriesPerWrite, entries.length + deletes.length)
          state.entries.push(...entries)
          state.deletes.push(...deletes)
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

async function useSource(source: 'idb' | 'sqlite'): Promise<void> {
  if (source === 'sqlite') {
    // C-04 后 settings 读路径 cache meta 缺失会 fail-closed 回源 SQLite，必须同时置 meta ready
    await primeLegacySqliteContentSource()
    return
  }
  await persistContentWriteSource('idb')
}

/** 断言写入失败为结构化 ContentWriteError（sqlite 失败），返回错误对象 */
async function expectStructuredFailure(promise: Promise<unknown>): Promise<ContentWriteError> {
  const error = await promise.then(
    () => null,
    (err: unknown) => err,
  )
  expect(error).toBeInstanceOf(ContentWriteError)
  expect((error as ContentWriteError).code).toBe('CONTENT_SQLITE_WRITE_FAILED')
  expect((error as Error).message).toMatch(/内容写入 SQLite 失败/)
  return error as ContentWriteError
}

function packEntries(state: MockSqliteState, draftId: string): CapturedEntry[] {
  return state.entries.filter((entry) => entry.key === `pack:${draftId}`)
}

beforeEach(async () => {
  await resetDatabase()
})

describe('0.14 生成草稿写入口 → 统一内容写源（generation-draft）', () => {
  it('sqlite 成功：create 写 `pack:` 完整行，IDB cache 同步', async () => {
    await useSource('sqlite')
    const state = mockSqlite()
    const draft = await createGenerationDraft({
      scope: { kind: 'deck', deckId: 'd1' },
      kind: ['examples', 'mnemonics'],
      name: '草稿A',
    })

    expect(state.writes).toBe(1)
    const entries = packEntries(state, draft.id)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.kind).toBe('pack')
    const row = JSON.parse(entries[0]!.json) as Record<string, unknown>
    expect(row.id).toBe(draft.id)
    expect(row.name).toBe('草稿A')
    expect(row.source).toBe('ai')
    expect(row.status).toBe('reviewing')
    expect(row.draft).toMatchObject({ scope: { kind: 'deck', deckId: 'd1' }, kind: ['examples', 'mnemonics'], cursor: 0 })
    expect(row.counts).toMatchObject({ items: 0, pending: 0 })
    expect(entries[0]!.updated_at).toBeGreaterThan(0)

    // IDB cache 同步（事实源写成功后）
    const db = getDb()
    expect((await db.packs.get(draft.id))?.name).toBe('草稿A')
    expect((await listGenerationDrafts()).map((entry) => entry.id)).toEqual([draft.id])
  })

  it('sqlite 成功：append 写 pack 行 + pack-item 完整行，IDB cache/计数同步', async () => {
    await useSource('sqlite')
    const state = mockSqlite()
    const draft = await createGenerationDraft({ scope: null, kind: ['examples'], name: '草稿B' })
    const before = state.entries.length

    const first = await appendGenerationDraftItems(draft.id, [
      input('alpha', 1),
      input('beta'),
    ])
    expect(first).toEqual({ done: 2, added: 2 })

    const appended = state.entries.slice(before)
    const itemEntries = appended.filter((entry) => entry.key.startsWith('pack-item:'))
    expect(itemEntries.map((entry) => entry.key)).toEqual([`pack-item:${draft.id}:1`, `pack-item:${draft.id}:2`])
    expect(itemEntries.every((entry) => entry.kind === 'pack-item')).toBe(true)
    const itemRow = JSON.parse(itemEntries[0]!.json) as Record<string, unknown>
    expect(itemRow).toMatchObject({ id: `${draft.id}:1`, packId: draft.id, seq: 1, headwordLower: 'alpha', status: 'pending' })

    // pack 行在追加后仍是完整记录（counts/draft 已更新）
    const packRow = JSON.parse(packEntries(state, draft.id).at(-1)!.json) as Record<string, unknown>
    expect(packRow.counts).toMatchObject({ items: 2, pending: 2 })
    expect((packRow.draft as { cursor: number }).cursor).toBe(0)

    const db = getDb()
    expect(await db.packItems.where('packId').equals(draft.id).count()).toBe(2)
    expect((await getGenerationDraft(draft.id))!.done).toBe(2)
    expect((await listGenerationDraftItems(draft.id)).map((item) => item.headwordLower)).toEqual(['alpha', 'beta'])
  })

  it('sqlite 成功：cursor 更新写完整 pack 行（断点），IDB cache 同步', async () => {
    await useSource('sqlite')
    const state = mockSqlite()
    const draft = await createGenerationDraft({ scope: null, kind: ['examples'], name: '草稿C' })
    await appendGenerationDraftItems(draft.id, [input('gamma')])
    const before = state.entries.length

    await updateGenerationDraftCursor(draft.id, {
      cursor: 5,
      targetTotal: 12,
      errors: [{ index: 2, code: 'AI_TIMEOUT', message: '超时' }],
    })

    const updated = state.entries.slice(before)
    expect(updated).toHaveLength(1)
    expect(updated[0]!.key).toBe(`pack:${draft.id}`)
    const row = JSON.parse(updated[0]!.json) as { draft: Record<string, unknown> }
    expect(row.draft).toMatchObject({
      cursor: 5,
      targetTotal: 12,
      errors: [{ index: 2, code: 'AI_TIMEOUT', message: '超时' }],
    })
    const db = getDb()
    const cached = await db.packs.get(draft.id)
    expect((cached?.draft as { cursor: number }).cursor).toBe(5)
    expect((await getGenerationDraft(draft.id))!.meta.targetTotal).toBe(12)
  })

  it('sqlite 成功：大批量 append 按 ≤500/批写 content_kv，IDB cache 完整', async () => {
    await useSource('sqlite')
    const state = mockSqlite()
    const draft = await createGenerationDraft({ scope: null, kind: ['examples'], name: '大批量' })
    const writesBefore = state.writes
    const items = Array.from({ length: 501 }, (_, index) => input(`word${index}`, 1))

    const result = await appendGenerationDraftItems(draft.id, items)
    expect(result).toEqual({ done: 501, added: 501 })
    expect(state.writes - writesBefore).toBeGreaterThanOrEqual(2)
    expect(state.maxEntriesPerWrite).toBeLessThanOrEqual(500)
    expect(state.entries.filter((entry) => entry.key.startsWith('pack-item:')).length).toBe(501)
    // 每批都带完整 pack 行（counts 与批内 items 一致，不丢字段）
    for (const entry of packEntries(state, draft.id)) {
      expect(JSON.parse(entry.json)).toMatchObject({ id: draft.id, status: 'reviewing' })
    }
    expect(await getDb().packItems.where('packId').equals(draft.id).count()).toBe(501)
  })

  it('sqlite 成功：clear 写 pack/pack-item tombstone，IDB cache 删除', async () => {
    await useSource('sqlite')
    const state = mockSqlite()
    const draft = await createGenerationDraft({ scope: null, kind: ['examples'], name: '待删除' })
    await appendGenerationDraftItems(draft.id, [input('alpha', 1), input('beta', 1)])
    state.deletes.length = 0

    await clearGenerationDraft(draft.id)

    expect(state.deletes.sort()).toEqual(
      [`pack:${draft.id}`, `pack-item:${draft.id}:1`, `pack-item:${draft.id}:2`].sort(),
    )
    const db = getDb()
    expect(await db.packs.get(draft.id)).toBeUndefined()
    expect(await db.packItems.where('packId').equals(draft.id).count()).toBe(0)
    expect(await listGenerationDrafts()).toEqual([])
  })

  it('sqlite 失败：create/append/cursor/clear 抛结构化错误且不回写 IDB', async () => {
    // 先在 idb 模式准备一个已有草稿（作为失败时不应被改动的基线）
    await useSource('idb')
    const draft = await createGenerationDraft({ scope: null, kind: ['examples'], name: '基线' })
    await appendGenerationDraftItems(draft.id, [input('alpha')])
    const db = getDb()
    const baselinePack = (await db.packs.get(draft.id))!
    const baselineUpdatedAt = baselinePack.updatedAt
    const baselineDraft = JSON.parse(JSON.stringify(baselinePack.draft))

    await useSource('sqlite')
    const state = mockSqlite({ fail: true })

    // create 失败：不落新草稿
    const packsBefore = await db.packs.count()
    await expectStructuredFailure(createGenerationDraft({ scope: null, kind: ['examples'], name: '不应创建' }))
    expect(await db.packs.count()).toBe(packsBefore)

    // append 失败：已有条目/计数保持
    await expectStructuredFailure(appendGenerationDraftItems(draft.id, [input('beta')]))
    expect(await db.packItems.where('packId').equals(draft.id).count()).toBe(1)
    expect((await db.packs.get(draft.id))!.counts.items).toBe(1)

    // cursor 失败：断点保持基线
    await expectStructuredFailure(updateGenerationDraftCursor(draft.id, { cursor: 9, targetTotal: 20 }))
    const afterCursor = (await db.packs.get(draft.id))!
    expect(afterCursor.draft).toEqual(baselineDraft)
    expect(afterCursor.updatedAt).toBe(baselineUpdatedAt)

    // clear 失败：草稿与条目都保留
    await expectStructuredFailure(clearGenerationDraft(draft.id))
    expect(await db.packs.get(draft.id)).toBeTruthy()
    expect(await db.packItems.where('packId').equals(draft.id).count()).toBe(1)

    expect(state.writes).toBeGreaterThanOrEqual(4)
    // 失败批不写 IDB：最终仍是 idb 基线数据
    expect((await getGenerationDraft(draft.id))!.done).toBe(1)
  })

  it('sqlite 幂等 append：重复条目 added=0，仅更新 pack 行，IDB 条目数不变', async () => {
    await useSource('sqlite')
    const state = mockSqlite()
    const draft = await createGenerationDraft({ scope: null, kind: ['examples'], name: '幂等' })
    await appendGenerationDraftItems(draft.id, [input('alpha', 1)])
    const beforeEntries = state.entries.length

    const again = await appendGenerationDraftItems(draft.id, [input('alpha', 1), input('alpha', 1)])
    expect(again).toEqual({ done: 1, added: 0 })
    const appended = state.entries.slice(beforeEntries)
    expect(appended).toHaveLength(1)
    expect(appended[0]!.key).toBe(`pack:${draft.id}`)
    expect(await getDb().packItems.where('packId').equals(draft.id).count()).toBe(1)
    expect((await getGenerationDraft(draft.id))!.done).toBe(1)
  })

  it('idb 模式行为不变：不调用 contentWrite，create/append/cursor/clear 仍走原 IDB 写路径', async () => {
    await useSource('idb')
    const state = mockSqlite()
    const db = getDb()

    const draft = await createGenerationDraft({ scope: { kind: 'words' }, kind: ['phrases'], name: 'idb 草稿' })
    expect(state.writes).toBe(0)
    expect((await db.packs.get(draft.id))?.name).toBe('idb 草稿')

    const first = await appendGenerationDraftItems(draft.id, [input('alpha', 1), input('beta', 1)])
    expect(first).toEqual({ done: 2, added: 2 })
    await updateGenerationDraftCursor(draft.id, { cursor: 2, targetTotal: 4 })
    expect(state.writes).toBe(0)
    expect((await getGenerationDraft(draft.id))!.meta.cursor).toBe(2)
    expect(await db.packItems.where('packId').equals(draft.id).count()).toBe(2)

    await clearGenerationDraft(draft.id)
    expect(state.writes).toBe(0)
    expect(await db.packs.get(draft.id)).toBeUndefined()
    expect(await db.packItems.where('packId').equals(draft.id).count()).toBe(0)
  })
})
