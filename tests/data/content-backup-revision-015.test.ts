import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildContentSnapshot,
  createContentBaseline,
  createContentIncrement,
  createDeck,
  getContentWriteSource,
  getDb,
  invalidateContentMigrationV15Cache,
  listContentBackups,
  resetDatabase,
  restoreContentBackup,
  setContentBackupStorage,
  setSqliteTransport,
} from '../../src/data'
import { CONTENT_MIGRATION_V15_KEY } from '../../src/data/content-write-source'
import { CONTENT_KV_STALE_KEY } from '../../src/data/content-store'
import { createContentBackupStorage } from '../../src/app/utils/content-backup-storage'

type Row = { key: string; kind: string; json: string; updated_at: number; revision: number; deleted: number }
type NativeStoreOptions = { failWrites?: boolean }

/** 贴近 native 契约的 content_kv mock（contentList 只返回 live 行） */
function installStore(initial: Row[] = [], opts: NativeStoreOptions = {}) {
  const rows = new Map<string, Row>(initial.map((row) => [row.key, { ...row }]))
  let revision = initial.reduce((max, row) => Math.max(max, row.revision), 0)
  let seq = 0
  setSqliteTransport({
    sqliteCall(requestJson: string) {
      const request = JSON.parse(requestJson) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${request.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, json: string) => void }).__momoSqliteResult
        const respond = (value: unknown) => callback?.(id, JSON.stringify(value))
        if (request.method === 'contentCounts') {
          respond({ ok: true, total: [...rows.values()].filter((row) => row.deleted === 0).length, deleted: [...rows.values()].filter((row) => row.deleted === 1).length, byKind: {}, revision })
          return
        }
        if (request.method === 'contentList') {
          const fromRevision = Number(request.payload?.fromRevision ?? 0)
          const limit = Math.max(1, Math.min(Number(request.payload?.limit ?? 500), 1000))
          const offset = Number(request.payload?.offset ?? 0)
          const active = [...rows.values()]
            .filter((row) => row.revision >= fromRevision && row.deleted === 0)
            .sort((a, b) => a.revision - b.revision || a.key.localeCompare(b.key))
          const page = active.slice(offset, offset + limit)
          respond({ ok: true, revision, rows: page, hasMore: offset + page.length < active.length })
          return
        }
        if (request.method === 'contentGet') {
          const keys = (request.payload?.keys as string[]) ?? []
          respond({ ok: true, rows: keys.map((key) => rows.get(key)).filter(Boolean) })
          return
        }
        if (request.method === 'contentWrite') {
          if (opts.failWrites) {
            respond({ ok: false, code: 'E_IO', message: 'mock content write fail' })
            return
          }
          revision += 1
          const payload = request.payload as { entries?: Array<{ key: string; kind: string; json: string; updated_at: number }>; deletes?: string[] }
          for (const entry of payload.entries ?? []) rows.set(entry.key, { key: entry.key, kind: entry.kind, json: entry.json, updated_at: entry.updated_at, revision, deleted: 0 })
          for (const key of payload.deletes ?? []) {
            const previous = rows.get(key)
            if (previous) rows.set(key, { ...previous, deleted: 1, revision })
          }
          respond({ ok: true, revision })
          return
        }
        respond({ ok: true })
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { rows }
}

function markNativeRuntime(): void {
  ;(globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }).MomoBridge = { isNativeApp: () => 'momo-apk' }
}

async function seedKvContent() {
  return installStore([
    { key: 'deck:kv-deck', kind: 'deck', json: JSON.stringify({ id: 'kv-deck', name: 'KV', source: 'custom', wordCount: 1, version: 1, isDefault: false, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 1, deleted: 0 },
    { key: 'word:kv-word', kind: 'word', json: JSON.stringify({ id: 'kv-word', deckId: 'kv-deck', headword: 'kvword', headwordLower: 'kvword', meanings: [{ id: 'm', cn: '义' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1, createdAt: 1, updatedAt: 1 }), updated_at: 1, revision: 2, deleted: 0 },
    { key: 'meta:userNote:old', kind: 'meta', json: '"old"', updated_at: 2, revision: 3, deleted: 0 },
  ])
}

class FakeBridge {
  files = new Map<string, { text: string; mtime: number }>()
  seq = 0
  isAvailable() { return true }
  save(text: string, name: string) { const actual = name.endsWith('.gz') ? name : `${name}.gz`; this.files.set(actual, { text, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name: actual } }
  list() { return [...this.files.entries()].map(([name, file]) => ({ name, size: file.text.length, mtime: file.mtime, path: `/auto/${name}` })) }
  read(name: string) { return this.files.get(name)?.text ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag() { return '' }
  setFlag() { return true }
  appendDiagLog() {}
}

afterEach(async () => {
  setContentBackupStorage(null)
  setSqliteTransport(null)
  delete (globalThis as unknown as { MomoBridge?: unknown }).MomoBridge
  try { await persistContentWriteSource('idb') } catch { /* 0.15 平台化后可能不可用 */ }
})

describe('0.15 backup/restore single source', () => {
  it('native v15 默认：kv 生成 baseline/increment，IDB cache stale 不影响 hash；恢复后 source 仍 sqlite', async () => {
    await resetDatabase()
    // 0.15 默认：native + v15 done → content_kv 是事实源；旧 settings 保持默认 idb 也必须被忽略
    markNativeRuntime()
    await getDb().meta.put({ key: CONTENT_MIGRATION_V15_KEY, value: { status: 'done', at: Date.now() }, updatedAt: Date.now() })
    const { rows } = await seedKvContent()
    const storage = new FakeBridge()
    setContentBackupStorage(createContentBackupStorage(storage as never))
    expect(await getContentWriteSource()).toBe('sqlite')
    const baseline = await createContentBaseline()
    expect(baseline.ok).toBe(true)
    // IDB cache 是空/stale：快照与正文都必须来自 content_kv
    expect(await getDb().words.count()).toBe(0)
    expect(baseline.counts).toMatchObject({ decks: 1, words: 1, meta: 1 })
    // 变更 kv：新增 note、改 word 正文、删除旧 note（tombstone）
    rows.get('meta:userNote:old')!.deleted = 1
    rows.set('meta:userNote:new', { key: 'meta:userNote:new', kind: 'meta', json: '"new"', updated_at: 5, revision: 10, deleted: 0 })
    const word = { ...JSON.parse(rows.get('word:kv-word')!.json), headword: 'kvword2', updatedAt: 6 }
    rows.set('word:kv-word', { key: 'word:kv-word', kind: 'word', json: JSON.stringify(word), updated_at: 6, revision: 11, deleted: 0 })
    const increment = await createContentIncrement()
    expect(increment.ok).toBe(true)
    expect(increment.tombstones).toBe(1)
    const expected = await buildContentSnapshot({ revision: 99 })
    const target = (await listContentBackups()).find((item) => item.kind === 'increment')!
    const restored = await restoreContentBackup(target.id)
    expect(restored.ok).toBe(true)
    // 恢复后：kv 快照 hash 与恢复前一致；IDB cache 被同步
    expect((await buildContentSnapshot({ revision: 100 })).snapshotId).toBe(expected.snapshotId)
    expect(await getDb().words.count()).toBe(1)
    expect(await getDb().meta.get('userNote:old')).toBeUndefined()
    expect((await getDb().meta.get('userNote:new'))?.value).toBe('new')
    // 0.15：恢复不会把写源打回 idb（settings 迁移输入保持 idb，平台判定仍 sqlite），也不依赖旧 contentMigrationState
    expect(await getContentWriteSource()).toBe('sqlite')
    expect((await getDb().settings.get('data.contentWriteSource'))?.value ?? 'idb').toBe('idb')
    // 模拟重启（清 v15 缓存后重新判定）source 仍是 sqlite
    invalidateContentMigrationV15Cache()
    expect(await getContentWriteSource()).toBe('sqlite')
    expect(await getDb().meta.get('contentMigrationState')).toBeUndefined()
  })

  it('web：只认 IDB（stale 标记不影响、恢复走 IDB、source 仍 idb）', async () => {
    await resetDatabase()
    await createDeck({ name: 'web', words: [{ headword: 'webword', meanings: [{ cn: '义' }] }] })
    await getDb().meta.put({ key: 'userNote:web', value: 'v', updatedAt: 2 })
    // web 没有原生 SQLite；即使残留 stale 标记也只认 IDB
    await getDb().meta.put({ key: CONTENT_KV_STALE_KEY, value: { at: 1 }, updatedAt: 1 })
    expect(await getContentWriteSource()).toBe('idb')
    const storage = new FakeBridge()
    setContentBackupStorage(createContentBackupStorage(storage as never))
    expect((await createContentBaseline()).ok).toBe(true)
    await getDb().meta.put({ key: 'userNote:web2', value: 'v2', updatedAt: 3 })
    expect((await createContentIncrement()).ok).toBe(true)
    const expected = await buildContentSnapshot({ revision: 9 })
    const target = (await listContentBackups()).find((item) => item.kind === 'increment')!
    expect((await restoreContentBackup(target.id)).ok).toBe(true)
    expect((await buildContentSnapshot({ revision: 10 })).snapshotId).toBe(expected.snapshotId)
    expect((await getDb().meta.get('userNote:web2'))?.value).toBe('v2')
    expect(await getContentWriteSource()).toBe('idb')
  })

  it('native 但 v15 未就绪（source=idb）：内容恢复 fail-closed 拒绝，不写库', async () => {
    await resetDatabase()
    markNativeRuntime()
    // native runtime 就绪（MomoBridge + 原生 SQLite），但 0.15 迁移未完成：settings 仍是 idb
    installStore([])
    await persistContentWriteSource('idb')
    await createDeck({ name: 'pending', words: [{ headword: 'pendingword', meanings: [{ cn: '义' }] }] })
    const storage = new FakeBridge()
    setContentBackupStorage(createContentBackupStorage(storage as never))
    expect((await createContentBaseline()).ok).toBe(true)
    const target = (await listContentBackups()).find((item) => item.kind === 'baseline')!
    const before = await getDb().words.count()
    const restored = await restoreContentBackup(target.id)
    expect(restored.ok).toBe(false)
    expect(restored.error).toMatch(/E_CONTENT_SOURCE_NOT_SQLITE|事实源/)
    expect(await getDb().words.count()).toBe(before)
    expect(await getContentWriteSource()).toBe('idb')
  })

  it('native 恢复失败：content_kv 补偿错误显式返回，source 仍 sqlite、IDB 不变', async () => {
    await resetDatabase()
    await persistContentWriteSource('sqlite')
    await getDb().meta.put({ key: 'contentMigrationV15', value: { status: 'done', at: Date.now() }, updatedAt: Date.now() })
    markNativeRuntime()
    const good = await seedKvContent()
    const storage = new FakeBridge()
    setContentBackupStorage(createContentBackupStorage(storage as never))
    expect((await createContentBaseline()).ok).toBe(true)
    const target = (await listContentBackups()).find((item) => item.kind === 'baseline')!
    expect(good.rows.size).toBeGreaterThan(0)
    // 恢复时 contentWrite 全部失败（含补偿）→ fail-closed，错误里必须带补偿失败
    installStore([], { failWrites: true })
    const before = await getDb().words.count()
    const restored = await restoreContentBackup(target.id)
    expect(restored.ok).toBe(false)
    expect(restored.error).toMatch(/回滚失败|E_CONTENT_KV_ROLLBACK_FAILED|content_kv/)
    expect(await getDb().words.count()).toBe(before)
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('0.14 旧内容备份兼容：idb 时代 baseline/increment 在 0.15 native 下恢复，hash 一致', async () => {
    await resetDatabase()
    // 阶段 A：0.14（IDB 事实源，无原生 SQLite）生成旧备份
    await createDeck({ name: 'legacy', words: [{ headword: 'legacyword', meanings: [{ cn: '义' }] }] })
    await getDb().meta.put({ key: 'userNote:a', value: 'A', updatedAt: 1 })
    const storage = new FakeBridge()
    setContentBackupStorage(createContentBackupStorage(storage as never))
    expect((await createContentBaseline()).ok).toBe(true)
    await getDb().meta.put({ key: 'userNote:b', value: 'B', updatedAt: 2 })
    await getDb().meta.delete('userNote:a')
    expect((await createContentIncrement()).ok).toBe(true)
    const expected = await buildContentSnapshot({ revision: 20 })
    // 阶段 B：0.15 native 单一事实源，kv 为空 → 用旧包恢复
    await persistContentWriteSource('sqlite')
    await getDb().meta.put({ key: 'contentMigrationV15', value: { status: 'done', at: Date.now() }, updatedAt: Date.now() })
    markNativeRuntime()
    installStore([])
    const target = (await listContentBackups()).find((item) => item.kind === 'increment')!
    const restored = await restoreContentBackup(target.id)
    expect(restored.ok).toBe(true)
    expect((await buildContentSnapshot({ revision: 21 })).snapshotId).toBe(expected.snapshotId)
    expect(await getContentWriteSource()).toBe('sqlite')
    // IDB cache 同步后可再从 IDB 得到同一 hash（切回 web/idb 语义）
    delete (globalThis as unknown as { MomoBridge?: unknown }).MomoBridge
    setSqliteTransport(null)
    await persistContentWriteSource('idb')
    expect((await buildContentSnapshot({ revision: 22 })).snapshotId).toBe(expected.snapshotId)
    expect((await getDb().meta.get('userNote:a'))).toBeUndefined()
    expect((await getDb().meta.get('userNote:b'))?.value).toBe('B')
  })
  it('native 事实源 + stale：快照/备份 fail-closed 拒绝；恢复成功后清 stale 且 source 仍 sqlite', async () => {
    await resetDatabase()
    markNativeRuntime()
    await getDb().meta.put({ key: CONTENT_MIGRATION_V15_KEY, value: { status: 'done', at: Date.now() }, updatedAt: Date.now() })
    await seedKvContent()
    const storage = new FakeBridge()
    setContentBackupStorage(createContentBackupStorage(storage as never))
    // 干净状态下生成一份 baseline（后续用于恢复修复 stale）
    expect((await createContentBaseline()).ok).toBe(true)
    const target = (await listContentBackups()).find((item) => item.kind === 'baseline')!
    // 标记 stale：备份快照必须 fail-closed，不能回落 IDB cache
    await getDb().meta.put({ key: CONTENT_KV_STALE_KEY, value: { at: 1 }, updatedAt: 1 })
    await expect(buildContentSnapshot({ revision: 50 })).rejects.toThrow(/E_CONTENT_KV_STALE|stale/)
    const blocked = await createContentBaseline()
    expect(blocked.ok).toBe(false)
    expect(blocked.error).toMatch(/stale|E_CONTENT_KV_STALE/)
    // 恢复是合法修复路径：成功后 stale 标记清除，写源仍 sqlite
    const restored = await restoreContentBackup(target.id)
    expect(restored.ok).toBe(true)
    expect(await getDb().meta.get(CONTENT_KV_STALE_KEY)).toBeUndefined()
    expect(await getContentWriteSource()).toBe('sqlite')
  })

})
