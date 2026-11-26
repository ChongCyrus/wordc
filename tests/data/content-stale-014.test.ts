import { primeLegacySqliteContentSource } from './test-utils'
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  canSwitchContentWriteSource,
  discardStaleContentKv,
  getDb,
  getSettings,
  resetContentWriteSourceForImport,
  resetDatabase,
  setSqliteTransport,
} from '../../src/data'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { CONTENT_KV_STALE_KEY } from '../../src/data/content-store'

type Row = { key: string; kind: string; json: string; updatedAt: number; revision: number; deleted: number }

afterEach(async () => {
  setSqliteTransport(null)
  await persistContentWriteSource('idb')
})

function mockKv(rows: Row[]) {
  const state = { rows: new Map(rows.map((row) => [row.key, { ...row }])), writes: [] as unknown[] }
  let seq = 0
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: { deletes?: string[]; entries?: Array<{ key: string }> } }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'contentCounts') {
          const live = [...state.rows.values()]
          cb?.(id, JSON.stringify({ ok: true, total: live.length, deleted: live.filter((r) => r.deleted === 1).length, byKind: {}, revision: 3 }))
        } else if (req.method === 'contentList') {
          cb?.(id, JSON.stringify({ ok: true, rows: [...state.rows.values()], hasMore: false, revision: 3 }))
        } else if (req.method === 'contentWrite') {
          for (const key of req.payload?.deletes ?? []) {
            const old = state.rows.get(key)
            if (old) state.rows.set(key, { ...old, deleted: 1 })
          }
          for (const entry of req.payload?.entries ?? []) {
            const old = state.rows.get(entry.key)
            if (old) state.rows.set(entry.key, { ...old, deleted: 0 })
          }
          cb?.(id, JSON.stringify({ ok: true, revision: 4 }))
        } else {
          cb?.(id, JSON.stringify({ ok: true, rows: [], hasMore: false, revision: 3 }))
        }
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return state
}

describe('0.14 导入回退后的 content_kv stale 防护', () => {
  it('reset 后标记 stale、禁止切源；清理后 tombstone 旧 live 行', async () => {
    await resetDatabase()
    await primeLegacySqliteContentSource()
    const state = mockKv([
      { key: 'word:a', kind: 'word', json: '{}', updatedAt: 1, revision: 1, deleted: 0 },
      { key: 'deck:d', kind: 'deck', json: '{}', updatedAt: 1, revision: 2, deleted: 0 },
    ])
    await resetContentWriteSourceForImport()
    expect((await getSettings())['data.contentWriteSource']).toBe('idb')
    expect(await getDb().meta.get(CONTENT_KV_STALE_KEY)).toBeTruthy()
    expect((await canSwitchContentWriteSource()).ok).toBe(false)

    const cleared = await discardStaleContentKv()
    expect(cleared.ok, cleared.error).toBe(true)
    expect(cleared.cleared).toBe(2)
    expect([...state.rows.values()].every((row) => row.deleted === 1)).toBe(true)
    expect(await getDb().meta.get(CONTENT_KV_STALE_KEY)).toBeUndefined()
    expect((await canSwitchContentWriteSource()).ok).toBe(false)
  })
})
