import './test-utils'
/**
 * 审计 E 复现（只读审计产物，不改 src）：
 * ensureContentSourceAfterImport → tombstoneStaleContentKvEntities 用「窄 overlay 字段表」
 * 判断 IDB 是否还有该词 overlay，导致仅有 senseMnemonics / rootMnemonic 等字段的
 * word-overlay content_kv 行被判为 stale 并 tombstone（事实上是唯一事实源里的有效用户内容）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { getDb, resetDatabase, setSqliteTransport } from '../../src/data'
import { ensureContentSourceAfterImport } from '../../src/data/content-switch'
import { invalidateContentMigrationV15Cache, CONTENT_MIGRATION_V15_KEY } from '../../src/data/content-write-source'
import { clearIdbCacheDirty } from '../../src/data/idb-cache'

afterEach(() => {
  setSqliteTransport(null)
  delete (globalThis as unknown as { MomoBridge?: unknown }).MomoBridge
})

describe('回归：导入后差集不会误删有效 overlay', () => {
  it('IDB 词只有 senseMnemonics 时，content_kv 的 word-overlay 行被判 stale 并删除', async () => {
    await resetDatabase()
    ;(globalThis as unknown as { MomoBridge?: unknown }).MomoBridge = { isNativeApp: () => 'momo-apk' }
    invalidateContentMigrationV15Cache()
    const db = getDb()
    // 原生 SQLite（mock）：migration_state 无行 → isContentMigrationV15Done 回退 IDB mirror=done
    await db.meta.put({ key: CONTENT_MIGRATION_V15_KEY, value: { status: 'done', at: 1 }, updatedAt: 1 })
    await clearIdbCacheDirty({ generation: 0, sqliteUserVersion: 3, dirty: false })

    // IDB cache：该词只有 senseMnemonics（不在 tombstoneStaleContentKvEntities 的窄字段表里）
    await db.words.put({
      id: 'w1', deckId: 'kaoyan-2027-dagang', headword: 'abandon', headwordLower: 'abandon',
      meanings: [{ id: 'm1', cn: '放弃' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1,
      senseMnemonics: [{ coreSenseIndex: 1, label: '核心', text: '用户手写的本义助记' }],
      createdAt: 1, updatedAt: 1,
    } as never)
    await db.decks.put({ id: 'kaoyan-2027-dagang', name: 'dagang', source: 'builtin', wordCount: 1, version: 1, isDefault: true, createdAt: 1, updatedAt: 1 } as never)

    const overlayJson = JSON.stringify({ senseMnemonics: [{ coreSenseIndex: 1, label: '核心', text: '用户手写的本义助记' }], updatedAt: 1 })
    const writes: Array<{ entries?: Array<{ key: string }>; deletes?: string[] }> = []
    setSqliteTransport({
      sqliteCall(json: string) {
        const req = JSON.parse(json) as { id: string; method: string }
        const id = `${req.id}-r`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'contentCounts') cb?.(id, JSON.stringify({ ok: true, total: 1, deleted: 0, byKind: { 'word-overlay': 1 }, revision: 5 }))
          else if (req.method === 'contentList') cb?.(id, JSON.stringify({ ok: true, revision: 5, hasMore: false, rows: [{ key: 'word-overlay:w1', kind: 'word-overlay', json: overlayJson, updated_at: 1, revision: 4, deleted: 0 }] }))
          else if (req.method === 'query') cb?.(id, JSON.stringify({ ok: true, rows: [] }))
          else if (req.method === 'contentWrite') {
            writes.push(JSON.parse(json).entryOrPayload ?? {})
            const payload = (JSON.parse(json) as { payload?: { entries?: Array<{ key: string }>; deletes?: string[] } }).payload
            writes[writes.length - 1] = payload ?? {}
            cb?.(id, JSON.stringify({ ok: true, revision: 6 }))
          } else cb?.(id, JSON.stringify({ ok: true }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })

    const result = await ensureContentSourceAfterImport()
    expect(result.ok).toBe(true)
    // 复现：唯一事实源里的有效 overlay 行被当成 stale 写 tombstone
    const tombstoned = writes.flatMap((row) => row.deletes ?? [])
    expect(tombstoned).not.toContain('word-overlay:w1')
  }, 30000)
})
