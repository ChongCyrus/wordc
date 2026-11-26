import './test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A2：恢复删除 content_kv 旧 key 时，tombstone 行的 kind 必须来自原行 kind
 * （不能统一写成 'meta'，否则 cache rebuild 会把 deck/word/pack 的删除落到 meta 表）。
 *
 * native contentWrite 的 deletes 只带 key，因此需要一个能截获 ContentWriteInput
 * 的 content-store mock 才能断言「交给 content_store 的删除行 kind 正确」。
 */
const state = vi.hoisted(() => {
  const rows = new Map<string, { key: string; kind: string; json: string; updatedAt: number; revision: number; deleted: 0 | 1 }>()
  const writes: Array<Array<{ key: string; kind: string; json: string; updatedAt?: number; deleted?: boolean }>> = []
  let revision = 0
  return {
    rows,
    writes,
    nextRevision: () => { revision += 1; return revision },
    currentRevision: () => revision,
  }
})

vi.mock('../../src/data/content-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/data/content-store')>()
  return {
    ...actual,
    listContentByRevision: vi.fn(async () => ({ ok: true, rows: [...state.rows.values()].map((row) => ({ ...row })), revision: state.currentRevision(), hasMore: false })),
    writeContentRows: vi.fn(async (input: Array<{ key: string; kind: string; json: string; updatedAt?: number; deleted?: boolean }>) => {
      state.writes.push(input.map((row) => ({ ...row })))
      const revision = state.nextRevision()
      for (const row of input) {
        const previous = state.rows.get(row.key)
        if (row.deleted === true) {
          if (previous) state.rows.set(row.key, { ...previous, deleted: 1, revision })
          continue
        }
        state.rows.set(row.key, { key: row.key, kind: row.kind, json: row.json, updatedAt: row.updatedAt ?? 0, revision, deleted: 0 })
      }
      return { ok: true, revision }
    }),
  }
})

import { getDb, resetDatabase } from './test-utils'
import { primeLegacySqliteContentSource } from './test-utils'
import { buildContentBaselineFile, buildContentSnapshot, restoreContentBaseline } from '../../src/data/content-snapshot'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { setSqliteTransport } from '../../src/data/native-sqlite'

const EXISTING = [
  { key: 'deck:old', kind: 'deck', json: '{"id":"old"}', updatedAt: 11, revision: 1, deleted: 0 as const },
  { key: 'word:old', kind: 'word', json: '{"id":"old"}', updatedAt: 12, revision: 2, deleted: 0 as const },
  { key: 'word-overlay:old', kind: 'word-overlay', json: '{"rootEtymology":{"v":1}}', updatedAt: 13, revision: 3, deleted: 0 as const },
  { key: 'pack:old', kind: 'pack', json: '{"id":"old"}', updatedAt: 14, revision: 4, deleted: 0 as const },
  { key: 'pack-item:old', kind: 'pack-item', json: '{"id":"old"}', updatedAt: 15, revision: 5, deleted: 0 as const },
  { key: 'content-reject:old', kind: 'content-reject', json: '{"id":"old"}', updatedAt: 16, revision: 6, deleted: 0 as const },
  { key: 'meta:userNote:old', kind: 'meta', json: '"old"', updatedAt: 17, revision: 7, deleted: 0 as const },
]

// 0.15：native content runtime（MomoBridge + 原生 SQLite）下 content_kv 才是事实源
function markNativeRuntime(): void {
  ;(globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }).MomoBridge = { isNativeApp: () => 'momo-apk' }
  // 通用响应：仅用于让 isSqliteAvailable()/v15 durable marker 读走通（content-store 已被 mock）
  setSqliteTransport({
    sqliteCall(json: string) {
      const request = JSON.parse(json) as { id: string }
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, payload: string) => void }).__momoSqliteResult
        callback?.(request.id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: request.id })
    },
  })
}

beforeEach(() => {
  state.rows.clear()
  state.writes.length = 0
  markNativeRuntime()
})

afterEach(async () => {
  delete (globalThis as unknown as { MomoBridge?: unknown }).MomoBridge
  setSqliteTransport(null)
  await persistContentWriteSource('idb')
})

describe('0.14 restore tombstone kind (A2)', () => {
  it('removeAll 删除旧 key 时 tombstone kind 来自原行 kind', async () => {
    await resetDatabase()
    await primeLegacySqliteContentSource()
    for (const row of EXISTING) state.rows.set(row.key, { ...row })
    expect(await getDb().words.count()).toBe(0)
    const base = await buildContentBaselineFile(await buildContentSnapshot({ revision: 1 })) // 空目标集合 → 全部旧 key 走 tombstone
    const result = await restoreContentBaseline(base)
    expect(result.ok).toBe(true)
    const deleted = state.writes.flat().filter((row) => row.deleted === true)
    const kindByKey = new Map(deleted.map((row) => [row.key, row.kind]))
    expect(deleted).toHaveLength(EXISTING.length)
    for (const row of EXISTING) expect(kindByKey.get(row.key), row.key).toBe(row.kind)
    // 只有内容是 meta 的 key 才允许 kind='meta'
    expect(deleted.filter((row) => row.kind === 'meta').map((row) => row.key)).toEqual(['meta:userNote:old'])
  })
})
