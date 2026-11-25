import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildContentBaselineFile, buildContentIncrement, buildContentSnapshot, createContentBaseline, createDeck, exportContentEntities, getDb, listContentBackups, resetDatabase, restoreContentBackup, restoreContentBaseline, restoreContentBaselineIndexed, restoreContentIncrementChain, saveContentBaselineChunked, setContentBackupStorage, setSqliteTransport, withDataWriteLock } from '../../src/data'
import { hashContentValue } from '../../src/data/content-snapshot'
import { createContentBackupStorage } from '../../src/app/utils/content-backup-storage'

function markNativeRuntime(): void { ;(globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }).MomoBridge = { isNativeApp: () => 'momo-apk' } }
beforeEach(() => { markNativeRuntime() })
afterEach(async () => { delete (globalThis as unknown as { MomoBridge?: unknown }).MomoBridge; setContentBackupStorage(null); setSqliteTransport(null); await persistContentWriteSource('idb') })

type Row = { key: string; kind: string; json: string; updated_at: number; revision: number; deleted: number }
type NativeStoreOptions = { failWriteAt?: number; failAllAfterFail?: boolean }

/**
 * 尽量贴近 native 契约的 content_kv mock：
 * - contentList：`revision >= fromRevision`、默认不含 deleted、limit/offset、hasMore；
 * - contentWrite：单事务 entries upsert + deletes tombstone（保留原行 kind）+ revision+1；
 * - 可注入第 N 次 contentWrite 失败，用于验证失败补偿。
 */
function installNativeStore(initial: Row[] = [], opts: NativeStoreOptions = {}) {
  const rows = new Map<string, Row>(initial.map((row) => [row.key, { ...row }]))
  let revision = initial.reduce((max, row) => Math.max(max, row.revision), 0)
  let seq = 0
  let writes = 0
  let failing = false
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  setSqliteTransport({
    sqliteCall(requestJson: string) {
      const request = JSON.parse(requestJson) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${request.id}-r${++seq}`
      calls.push({ method: request.method, payload: request.payload ?? {} })
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
          writes += 1
          if ((opts.failWriteAt != null && writes === opts.failWriteAt) || (failing && opts.failAllAfterFail === true)) {
            if (opts.failWriteAt != null && writes === opts.failWriteAt) failing = true
            respond({ ok: false, code: 'E_IO', message: `mock content write ${writes} fail` })
            return
          }
          revision += 1
          const payload = request.payload as { entries?: Array<{ key: string; kind: string; json: string; updated_at: number }>; deletes?: string[] }
          for (const entry of payload.entries ?? []) rows.set(entry.key, { key: entry.key, kind: entry.kind, json: entry.json, updated_at: entry.updated_at, revision, deleted: 0 })
          for (const key of payload.deletes ?? []) {
            const previous = rows.get(key)
            if (previous) rows.set(key, { ...previous, deleted: 1, revision })
          }
          respond({ ok: true, revision, upserts: (payload.entries ?? []).length, tombstones: (payload.deletes ?? []).length })
          return
        }
        respond({ ok: true })
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { rows, calls }
}

type Entity = { type: string; key: string; hash: string; updatedAt: number; data: unknown }

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

/** 手写基线文件（manifest/entities/checksum 自洽），用于构造边界数据 */
function baselineFile(entities: Entity[], revision = 1) {
  const manifest = {
    format: 'momo-content-snapshot-manifest' as const,
    formatVersion: 1 as const,
    snapshotId: `snap-${revision}`,
    revision,
    createdAt: 1,
    counts: {} as Record<string, number>,
    entries: entities.map(({ type, key, hash, updatedAt }) => ({ type, key, hash, updatedAt })),
    entitySetVersion: 1,
  }
  return {
    format: 'momo-content-baseline' as const,
    formatVersion: 1 as const,
    manifest,
    entities,
    checksum: `fnv1a64:${hashContentValue({ snapshotId: manifest.snapshotId, revision: manifest.revision, entities })}`,
  }
}

async function entitiesOf(snapshot: Awaited<ReturnType<typeof buildContentSnapshot>>) {
  return (await exportContentEntities(snapshot.entries)).map(({ type, key, data }) => ({ type, key, data }))
}

describe('0.14 restore sync content_kv', () => {
  it('baseline sqlite 成功：content_kv 行/删除正确，IDB cache 一致，非内容 meta 不碰（A9）', async () => {
    await resetDatabase()
    await createDeck({ name: 'kv', words: [{ headword: 'kvword', meanings: [{ cn: '义' }] }] })
    await getDb().meta.put({ key: 'learningFact.some', value: 'keep', updatedAt: 1 })
    await getDb().settings.put({ key: 'study.dailyGoal', value: 30, updatedAt: 1 } as never)
    await persistContentWriteSource('sqlite')
    const base = await buildContentBaselineFile(await buildContentSnapshot({ revision: 1 }))
    const old = { key: 'meta:userNote:old', kind: 'meta', json: '"x"', updated_at: 1, revision: 1, deleted: 0 }
    const foreign = { key: 'meta:learningFact.some', kind: 'meta', json: '"keep"', updated_at: 1, revision: 2, deleted: 0 }
    const { rows } = installNativeStore([old, foreign])
    const result = await restoreContentBaseline(base)
    expect(result.ok).toBe(true)
    expect([...rows.keys()].some((key) => key.startsWith('word:'))).toBe(true)
    expect([...rows.keys()].some((key) => key.startsWith('deck:'))).toBe(true)
    expect(rows.get('meta:userNote:old')?.deleted).toBe(1)
    // A9：content_kv 里非内容 meta key 与 IDB 非内容 meta 都不被恢复触碰
    expect(rows.get('meta:learningFact.some')?.deleted).toBe(0)
    expect((await getDb().meta.get('learningFact.some'))?.value).toBe('keep')
    expect((await getDb().settings.get('study.dailyGoal'))?.value).toBe(30)
    expect(await getDb().words.count()).toBe(1)
  })

  it('A1/A2：replaceAll 全量分页 tombstone >500 行旧 key，kind 保留原行', async () => {
    await resetDatabase()
    await createDeck({ name: 'seed', words: [{ headword: 'seedword', meanings: [{ cn: '义' }] }] })
    await persistContentWriteSource('sqlite')
    const base = await buildContentBaselineFile(await buildContentSnapshot({ revision: 1 }))
    const kinds = ['deck', 'word', 'pack', 'pack-item', 'content-reject', 'meta']
    const initial: Row[] = Array.from({ length: 1200 }, (_, index) => {
      const kind = kinds[index % kinds.length]!
      const key = kind === 'meta' ? `meta:userNote:old-${index}` : `${kind}:old-${index}`
      return { key, kind, json: '"old"', updated_at: 7, revision: index + 1, deleted: 0 }
    })
    const foreign = { key: 'meta:learningFact.paged', kind: 'meta', json: '"keep"', updated_at: 1, revision: 1300, deleted: 0 }
    const { rows } = installNativeStore([...initial, foreign])
    const result = await restoreContentBaseline(base)
    expect(result.ok).toBe(true)
    // 旧实现只取第一页 500 行；这里 1200 行旧 key 必须全部被 tombstone
    for (const row of initial) {
      const after = rows.get(row.key)
      expect(after?.deleted, row.key).toBe(1)
      expect(after?.kind, row.key).toBe(row.kind)
    }
    expect(rows.get('meta:learningFact.paged')?.deleted).toBe(0)
  })

  it('A3：增量链 delete→re-add 后 content_kv 与 IDB 都保留最终值', async () => {
    await resetDatabase()
    await getDb().meta.put({ key: 'userNote:chain', value: 'base', updatedAt: 1 })
    const snap1 = await buildContentSnapshot({ revision: 1 })
    const base = await buildContentBaselineFile(snap1)
    await getDb().meta.delete('userNote:chain')
    const snap2 = await buildContentSnapshot({ revision: 2 })
    const inc1 = buildContentIncrement(base.manifest, snap2, { entities: await entitiesOf(snap2) })
    if (!('format' in inc1)) throw new Error('expected inc1')
    await getDb().meta.put({ key: 'userNote:chain', value: 'again', updatedAt: 3 })
    const snap3 = await buildContentSnapshot({ revision: 3 })
    const inc2 = buildContentIncrement({ ...base.manifest, snapshotId: inc1.snapshotId, revision: inc1.newRevision }, snap3, { entities: await entitiesOf(snap3) })
    if (!('format' in inc2)) throw new Error('expected inc2')
    await persistContentWriteSource('sqlite')
    const { rows } = installNativeStore([])
    const restored = await restoreContentIncrementChain(base, [inc1, inc2])
    expect(restored.ok).toBe(true)
    const row = rows.get('meta:userNote:chain')
    expect(row?.deleted).toBe(0)
    expect(JSON.parse(row!.json)).toBe('again')
    expect((await getDb().meta.get('userNote:chain'))?.value).toBe('again')
  })

  it('A4：base checksum / revision 不符拒绝，且不写 content_kv / IDB', async () => {
    await resetDatabase()
    await createDeck({ name: 'a4', words: [{ headword: 'a4word', meanings: [{ cn: '义' }] }] })
    const base = await buildContentBaselineFile(await buildContentSnapshot({ revision: 1 }))
    await getDb().meta.put({ key: 'userNote:a4', value: 'v', updatedAt: 2 })
    const snap2 = await buildContentSnapshot({ revision: 2 })
    const pkg = buildContentIncrement(base.manifest, snap2, { entities: await entitiesOf(snap2) })
    if (!('format' in pkg)) throw new Error('expected increment')
    await persistContentWriteSource('sqlite')
    const { rows } = installNativeStore([])
    const badChecksum = await restoreContentIncrementChain({ ...base, checksum: 'fnv1a64:0000000000000000' }, [pkg])
    expect(badChecksum.ok).toBe(false)
    expect(badChecksum.error).toMatch(/checksum/)
    expect(rows.size).toBe(0)
    // revision 篡改：同步重算 checksum，确保失败点是 revision 不一致
    const tamperedManifest = { ...base.manifest, revision: 5 }
    const tamperedBase = {
      ...base,
      manifest: tamperedManifest,
      checksum: `fnv1a64:${hashContentValue({ snapshotId: tamperedManifest.snapshotId, revision: 5, entities: base.entities })}`,
    }
    const badRevision = await restoreContentIncrementChain(tamperedBase as never, [pkg])
    expect(badRevision.ok).toBe(false)
    expect(badRevision.error).toMatch(/revision/)
    expect(rows.size).toBe(0)
    expect((await getDb().meta.get('userNote:a4'))?.value).toBe('v')
  })

  it('A5：同步失败时 undo 失败不被吞（错误含回滚信息），且不写链成功标记', async () => {
    await resetDatabase()
    await persistContentWriteSource('sqlite')
    const entities = Array.from({ length: 501 }, (_, index) => ({ type: 'meta', key: `userNote:batch-${index}`, hash: 'h', updatedAt: 1, data: { index } }))
    const file = baselineFile(entities)
    const chainBefore = { baseSnapshotId: 'before', revision: 1, sequence: 0, needsFullSnapshot: false, consecutiveFailures: 0, updatedAt: 1 }
    await getDb().meta.put({ key: 'backup.contentChain', value: chainBefore, updatedAt: 1 })
    installNativeStore([], { failWriteAt: 2, failAllAfterFail: true })
    const result = await restoreContentBaseline(file as never)
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/回滚失败/)
    expect(result.error).toContain('E_CONTENT_KV_ROLLBACK_FAILED')
    expect((await getDb().meta.get('backup.contentChain'))?.value).toMatchObject({ baseSnapshotId: 'before' })
    expect((await getDb().meta.get('backup.contentRestore.diag'))?.value).toMatchObject({ stage: 'content_kv', rollbackFailed: true })
  })

  it('A6：恢复行 updatedAt 保留原值；data:null 实体按 tombstone 跳过', async () => {
    await resetDatabase()
    await persistContentWriteSource('sqlite')
    const kept: Entity = { type: 'meta', key: 'userNote:keep', hash: 'h-keep', updatedAt: 12345, data: 'keep' }
    const vanished: Entity = { type: 'words', key: 'gone-word', hash: 'h-gone', updatedAt: 222, data: null }
    const deck: Entity = {
      type: 'decks',
      key: 'deck-1',
      hash: 'h-deck',
      updatedAt: 333,
      data: { id: 'deck-1', name: 'D', source: 'custom', wordCount: 0, version: 1, isDefault: false, createdAt: 1, updatedAt: 333 },
    }
    const file = baselineFile([kept, vanished, deck])
    const { rows } = installNativeStore([])
    const result = await restoreContentBaseline(file as never)
    expect(result.ok).toBe(true)
    expect(rows.get('meta:userNote:keep')?.updated_at).toBe(12345)
    expect(rows.get('deck:deck-1')?.updated_at).toBe(333)
    expect(rows.get('word:gone-word')).toBeUndefined()
    expect(rows.get('meta:userNote:keep')?.json).toBe('"keep"')
    expect(await getDb().meta.get('userNote:keep')).toMatchObject({ value: 'keep', updatedAt: 12345 })
    expect(await getDb().decks.get('deck-1')).toBeTruthy()
  })

  it('A8：多批失败补偿覆盖所有已写/已删 key（旧内容恢复、已写新行删除）', async () => {
    await resetDatabase()
    await persistContentWriteSource('sqlite')
    const oldRows: Row[] = Array.from({ length: 700 }, (_, index) => ({
      key: `meta:userNote:old-${index}`,
      kind: 'meta',
      json: JSON.stringify(`old-${index}`),
      updated_at: 10 + index,
      revision: index + 1,
      deleted: 0,
    }))
    const entities = Array.from({ length: 1100 }, (_, index) => ({ type: 'meta', key: `userNote:new-${index}`, hash: 'h', updatedAt: 5000 + index, data: { index } }))
    const file = baselineFile(entities)
    // deletes 700（2 批）+ upserts 1100（3 批）；第 4 批失败（此前已删 700 + 写 500~800 行）
    const { rows } = installNativeStore(oldRows, { failWriteAt: 4 })
    const result = await restoreContentBaseline(file as never)
    expect(result.ok).toBe(false)
    for (const row of oldRows) {
      const after = rows.get(row.key)
      expect(after?.deleted, row.key).toBe(0)
      expect(after?.json, row.key).toBe(row.json)
      expect(after?.kind, row.key).toBe('meta')
    }
    expect([...rows.values()].some((row) => row.key.startsWith('meta:userNote:new-') && row.deleted === 0)).toBe(false)
    expect(await getDb().meta.get('userNote:new-0')).toBeUndefined()
  })

  it('B-A7：非白名单 meta key 恢复时不误删（全量/链恢复都保留）', async () => {
    await resetDatabase()
    await getDb().meta.put({ key: 'aiNote:alpha', value: { text: 'ai' }, updatedAt: 2 })
    const base = await buildContentBaselineFile(await buildContentSnapshot({ revision: 1 })) // 快照只覆盖白名单 meta
    await getDb().meta.put({ key: 'userNote:inc', value: 'v', updatedAt: 3 })
    const current = await buildContentSnapshot({ revision: 2 })
    const pkg = buildContentIncrement(base.manifest, current, { entities: await entitiesOf(current) })
    if (!('format' in pkg)) throw new Error('expected increment')
    await persistContentWriteSource('sqlite')
    const preserved = [
      { key: 'meta:aiNote:alpha', kind: 'meta', json: '{"text":"ai"}', updated_at: 2, revision: 1, deleted: 0 },
      { key: 'meta:futureKind:beta', kind: 'meta', json: '"future"', updated_at: 3, revision: 2, deleted: 0 },
      { key: 'future-kind:gamma', kind: 'future-kind', json: '"future"', updated_at: 4, revision: 3, deleted: 0 },
    ]
    const whitelisted = { key: 'meta:userNote:old', kind: 'meta', json: '"old"', updated_at: 5, revision: 4, deleted: 0 }
    const { rows } = installNativeStore([...preserved, whitelisted])
    const baseline = await restoreContentBaseline(base)
    expect(baseline.ok).toBe(true)
    for (const row of preserved) expect(rows.get(row.key)?.deleted, row.key).toBe(0)
    // 白名单内的内容 meta 仍按 replaceAll 正常 tombstone
    expect(rows.get('meta:userNote:old')?.deleted).toBe(1)
    // IDB 非白名单 meta 同样保留
    expect((await getDb().meta.get('aiNote:alpha'))?.value).toMatchObject({ text: 'ai' })
    // 链恢复同样不误删非白名单 key
    const chain = await restoreContentIncrementChain(base, [pkg])
    expect(chain.ok).toBe(true)
    for (const row of preserved) expect(rows.get(row.key)?.deleted, row.key).toBe(0)
  })

  it('idb 写源：恢复只写 IDB，不写 content_kv', async () => {
    await resetDatabase()
    await createDeck({ name: 'idb-only', words: [{ headword: 'idbword', meanings: [{ cn: '义' }] }] })
    const base = await buildContentBaselineFile(await buildContentSnapshot({ revision: 1 }))
    const { rows, calls } = installNativeStore([])
    const result = await restoreContentBaseline(base)
    expect(result.ok).toBe(true)
    expect(rows.size).toBe(0)
    expect(calls.some((call) => call.method === 'contentWrite')).toBe(false)
    expect(await getDb().words.count()).toBe(1)
  })
  it('A8：restoreContentBaseline 持全局写锁（与并发破坏性写串行）', async () => {
    await resetDatabase()
    await createDeck({ name: 'lock', words: [{ headword: 'lockword', meanings: [{ cn: '义' }] }] })
    await persistContentWriteSource('sqlite')
    const base = await buildContentBaselineFile(await buildContentSnapshot({ revision: 1 }))
    const { rows } = installNativeStore([])
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holder = withDataWriteLock(async () => { await gate })
    const restorePromise = restoreContentBaseline(base)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 写锁被占：恢复必须排队，尚未写 content_kv
    expect(rows.size).toBe(0)
    release()
    await holder
    const result = await restorePromise
    expect(result.ok).toBe(true)
    expect(rows.size).toBeGreaterThan(0)
  })

  it('A8：restoreContentBackup 入口持锁，内部恢复 skipWriteLock 无嵌套死锁', async () => {
    await resetDatabase()
    await createDeck({ name: 'entry-lock', words: [{ headword: 'entryword', meanings: [{ cn: '义' }] }] })
    const bridge = new FakeBridge()
    setContentBackupStorage(createContentBackupStorage(bridge as never))
    const baseline = await createContentBaseline()
    expect(baseline.ok).toBe(true)
    const item = (await listContentBackups()).find((entry) => entry.kind === 'baseline')
    expect(item).toBeTruthy()
    await getDb().words.clear()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const holder = withDataWriteLock(async () => { await gate })
    const restorePromise = restoreContentBackup(item!.id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    // 入口在等锁：IDB 仍是清空后的状态
    expect(await getDb().words.count()).toBe(0)
    release()
    await holder
    const result = await restorePromise
    expect(result.ok).toBe(true)
    expect(await getDb().words.count()).toBe(1)
  })

  it('A9：分块基线 index checksum / part 正文篡改被拒绝', async () => {
    await resetDatabase()
    await createDeck({ name: 'chunked', words: [{ headword: 'chunkword', meanings: [{ cn: '义' }] }] })
    const files = new Map<string, string>()
    const storage = {
      save: async (text: string, name: string) => { files.set(name, text); return { ok: true, name } },
      read: (name: string) => files.get(name) ?? null,
      list: () => [...files.keys()].map((name) => ({ name, size: 0, mtime: 1 })),
      delete: (name: string) => files.delete(name),
    }
    const snapshot = await buildContentSnapshot({ revision: 1 })
    const saved = await saveContentBaselineChunked(storage as never, snapshot, { chunkSize: 100 })
    expect(saved.ok).toBe(true)
    const indexName = [...files.keys()].find((name) => name.includes('-index'))!
    const partName = [...files.keys()].find((name) => name.includes('-part-'))!
    const index = JSON.parse(String(files.get(indexName))) as { checksum: string; chunks: Array<{ checksum: string }> }
    // 正常恢复可用
    expect((await restoreContentBaselineIndexed(storage as never, indexName)).ok).toBe(true)
    // 篡改 index.checksum → 拒绝（manifest/chunks 被伪造）
    files.set(indexName, JSON.stringify({ ...index, checksum: 'fnv1a64:0000000000000000' }))
    const badIndex = await restoreContentBaselineIndexed(storage as never, indexName)
    expect(badIndex.ok).toBe(false)
    expect(badIndex.error).toMatch(/index checksum/)
    files.set(indexName, JSON.stringify(index))
    // 篡改 part 正文但保留 entity.hash（part checksum 只覆盖 {type,key,hash}，不含正文）
    const part = JSON.parse(String(files.get(partName))) as { entities: Array<{ data: unknown }> }
    part.entities[0]!.data = { tampered: true }
    files.set(partName, JSON.stringify(part))
    const badPart = await restoreContentBaselineIndexed(storage as never, indexName)
    expect(badPart.ok).toBe(false)
    expect(badPart.error).toMatch(/hash/)
  })

})
