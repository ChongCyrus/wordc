import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { deleteContentRow, getContentRow, listContentByRevision, putContentRow, readContentCounts, readContentRevision, setSqliteTransport, writeContentRows } from '../../src/data'
afterEach(() => setSqliteTransport(null))
function mock() {
  const rows = new Map<string, { key: string; kind: string; json: string; updated_at: number; revision: number; deleted: number }>()
  let rev = 0; let seq = 0
  setSqliteTransport({ sqliteCall(json: string) {
    const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }; const id = `${req.id}-r${++seq}`
    setTimeout(() => {
      const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
      if (req.method === 'contentWrite') {
        const p = req.payload as { expectedRevision: number; entries: Array<{ key: string; kind: string; json: string; updated_at: number }>; deletes: string[] }
        if (p.expectedRevision !== rev) { cb?.(id, JSON.stringify({ ok: false, code: 'E_CONFLICT', message: 'conflict' })); return }
        rev += 1
        for (const entry of p.entries) rows.set(entry.key, { ...entry, deleted: 0, revision: rev })
        for (const key of p.deletes) { const old = rows.get(key); if (old) rows.set(key, { ...old, deleted: 1, revision: rev }) }
        cb?.(id, JSON.stringify({ ok: true, revision: rev, upserts: p.entries.length, deletes: p.deletes.length })); return
      }
      if (req.method === 'contentCounts') { cb?.(id, JSON.stringify({ ok: true, total: rows.size, deleted: [...rows.values()].filter((r) => r.deleted).length, byKind: {}, revision: rev })); return }
      if (req.method === 'contentGet') { const keys = (req.payload?.keys as string[]) ?? []; cb?.(id, JSON.stringify({ ok: true, rows: keys.map((k) => rows.get(k)).filter(Boolean) })); return }
      if (req.method === 'contentList') { const since = Number(req.payload?.fromRevision ?? 0); cb?.(id, JSON.stringify({ ok: true, revision: rev, rows: [...rows.values()].filter((r) => r.revision > since), hasMore: false })); return }
      cb?.(id, JSON.stringify({ ok: true }))
    }, 0)
    return JSON.stringify({ requestId: id })
  } })
  return rows
}
describe('0.14 content store native protocol', () => {
  it('put/get/list/revision/delete/E_CONFLICT', async () => {
    const map = mock()
    expect(await readContentRevision()).toBe(0)
    expect(await putContentRow({ key: 'meta:userNote:a', kind: 'meta', json: '{"v":1}' })).toBe(1)
    const row = await getContentRow('meta:userNote:a')
    expect(row?.kind).toBe('meta')
    expect(row?.updatedAt).toBeGreaterThan(0)
    await writeContentRows([{ key: 'word-overlay:w', kind: 'word-overlay', json: '{"root":1}' }, { key: 'deck:d', kind: 'deck', json: '{}' }])
    expect(await readContentRevision()).toBe(2)
    expect((await readContentCounts()).total).toBe(3)
    const listed = await listContentByRevision(0)
    expect(listed.rows.length).toBe(3)
    expect(listed.rows.filter((item) => item.revision > 1).length).toBe(2)
    await deleteContentRow('meta:userNote:a', 'meta')
    expect((await getContentRow('meta:userNote:a'))?.deleted).toBe(1)
    expect(map.size).toBe(3)
  })
})
