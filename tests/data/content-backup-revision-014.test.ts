import './test-utils'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildContentBaselineFile,
  buildContentIncrement,
  buildContentSnapshot,
  createDeck,
  diffContentEntries,
  exportContentEntities,
  getDb,
  
  resetDatabase,
  restoreContentBaseline,
  restoreContentIncrementChain,
  setSqliteTransport,
} from '../../src/data'
import { CONTENT_META_PREFIXES, hashContentValue, wordOverlayOf } from '../../src/data/content-snapshot'

function markNativeRuntime(): void { ;(globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string } }).MomoBridge = { isNativeApp: () => 'momo-apk' } }
beforeEach(() => { markNativeRuntime() })
afterEach(async () => { delete (globalThis as unknown as { MomoBridge?: unknown }).MomoBridge; setSqliteTransport(null); await persistContentWriteSource('idb') })

type Row = { key: string; kind: string; json: string; updated_at: number; revision: number; deleted: number }
type NativeStoreOptions = { failWriteAt?: number }

/** 贴近 native 契约的 content_kv mock（contentList 只返回 live 行、fromRevision>=、limit/hasMore） */
function installNativeStore(initial: Row[] = [], opts: NativeStoreOptions = {}) {
  const rows = new Map<string, Row>(initial.map((row) => [row.key, { ...row }]))
  let revision = initial.reduce((max, row) => Math.max(max, row.revision), 0)
  let seq = 0
  let writes = 0
  const calls: Array<{ method: string; payload: Record<string, unknown> }> = []
  setSqliteTransport({
    sqliteCall(requestJson: string) {
      const request = JSON.parse(requestJson) as { id: string; method: string; payload?: Record<string, unknown> }
      calls.push({ method: request.method, payload: request.payload ?? {} })
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
          writes += 1
          if (opts.failWriteAt != null && writes === opts.failWriteAt) {
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
          respond({ ok: true, revision })
          return
        }
        respond({ ok: true })
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return { rows, calls }
}

const rowUpdatedAt = (row: unknown): number => {
  const value = Number((row as { updatedAt?: unknown }).updatedAt ?? 0)
  return Number.isFinite(value) ? value : 0
}

const COMPACT = (entries: Array<{ type: string; key: string; hash: string }>) => entries
  .map(({ type, key, hash }) => ({ type, key, hash }))
  .sort((a, b) => a.type.localeCompare(b.type) || a.key.localeCompare(b.key))

/** 把当前 IDB 内容转成 content_kv 行（用于“同一内容在两种源下 hash 一致”） */
async function kvRowsFromIdb(): Promise<Row[]> {
  const db = getDb()
  const rows: Row[] = []
  let revision = 0
  const push = (key: string, kind: string, json: string, updatedAt: number) => { revision += 1; rows.push({ key, kind, json, updated_at: updatedAt, revision, deleted: 0 }) }
  const builtinDeckIds = new Set((await db.decks.toArray()).filter((deck) => Boolean(deck.builtinKey) || deck.source === 'builtin').map((deck) => deck.id))
  for (const deck of await db.decks.toArray()) push(`deck:${deck.id}`, 'deck', JSON.stringify(deck), deck.updatedAt)
  for (const word of await db.words.toArray()) {
    if (builtinDeckIds.has(word.deckId)) {
      const overlay = wordOverlayOf(word as unknown as Record<string, unknown>)
      if (Object.keys(overlay).length > 0) push(`word-overlay:${word.id}`, 'word-overlay', JSON.stringify(overlay), rowUpdatedAt(word))
    } else {
      push(`word:${word.id}`, 'word', JSON.stringify(word), rowUpdatedAt(word))
    }
  }
  for (const pack of await db.packs.toArray()) push(`pack:${pack.id}`, 'pack', JSON.stringify(pack), pack.updatedAt)
  for (const item of await db.packItems.toArray()) push(`pack-item:${item.id}`, 'pack-item', JSON.stringify(item), rowUpdatedAt(item))
  for (const reject of await db.contentRejects.toArray()) push(`content-reject:${reject.id}`, 'content-reject', JSON.stringify(reject), rowUpdatedAt(reject))
  for (const meta of await db.meta.toArray()) {
    if (CONTENT_META_PREFIXES.some((prefix) => meta.key.startsWith(prefix))) push(`meta:${meta.key}`, 'meta', JSON.stringify(meta.value), meta.updatedAt)
  }
  return rows
}

async function markMigrationReady(): Promise<void> {
  await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'ready', writeCoverageComplete: false }, updatedAt: Date.now() })
}

async function entitiesOf(snapshot: Awaited<ReturnType<typeof buildContentSnapshot>>) {
  return (await exportContentEntities(snapshot.entries)).map(({ type, key, data }) => ({ type, key, data }))
}

describe('0.14 backup source = content_kv revision', () => {
  it('IDB cache 与 kv 不一致时以 kv 为准，且只取 live 内容行', async () => {
    await resetDatabase()
    // IDB cache 里是旧内容（stale）
    await createDeck({ name: 'idb-deck', words: [{ headword: 'idbword', meanings: [{ cn: '义' }] }] })
    await persistContentWriteSource('sqlite')
    await markMigrationReady()
    const deck = { id: 'kv-deck', name: '来自 KV', source: 'custom', wordCount: 1, version: 1, isDefault: false, createdAt: 1, updatedAt: 9 }
    const word = { id: 'kv-word', deckId: 'kv-deck', headword: 'kvword', headwordLower: 'kvword', meanings: [], examples: [], mnemonics: [], phrases: [], tags: [], order: 1, createdAt: 1, updatedAt: 9 }
    const rows: Row[] = [
      { key: 'deck:kv-deck', kind: 'deck', json: JSON.stringify(deck), updated_at: 9, revision: 1, deleted: 0 },
      { key: 'word:kv-word', kind: 'word', json: JSON.stringify(word), updated_at: 9, revision: 2, deleted: 0 },
      { key: 'word-overlay:kv-word', kind: 'word-overlay', json: JSON.stringify({ rootEtymology: { v: 1 }, updatedAt: 9 }), updated_at: 9, revision: 3, deleted: 0 },
      { key: 'pack:p1', kind: 'pack', json: JSON.stringify({ id: 'p1', name: 'P', kind: 'custom', status: 'applied', itemCount: 0, appliedCount: 0, createdAt: 1, updatedAt: 4 }), updated_at: 4, revision: 4, deleted: 0 },
      { key: 'pack-item:i1', kind: 'pack-item', json: JSON.stringify({ id: 'i1', packId: 'p1', status: 'pending', headwordLower: 'x', createdAt: 1, updatedAt: 4 }), updated_at: 4, revision: 5, deleted: 0 },
      { key: 'content-reject:r1', kind: 'content-reject', json: JSON.stringify({ id: 'r1', kind: 'word', headwordLower: 'x', rejectedAt: 4 }), updated_at: 4, revision: 6, deleted: 0 },
      { key: 'meta:userNote:n1', kind: 'meta', json: '"note"', updated_at: 7, revision: 7, deleted: 0 },
      // 以下都不应进入 live snapshot
      { key: 'meta:learningFact.x', kind: 'meta', json: '"foreign"', updated_at: 1, revision: 8, deleted: 0 },
      { key: 'future:z', kind: 'future-kind', json: '"x"', updated_at: 1, revision: 9, deleted: 0 },
      { key: 'deck:deleted-deck', kind: 'deck', json: JSON.stringify({ id: 'deleted-deck', updatedAt: 1 }), updated_at: 1, revision: 10, deleted: 1 },
    ]
    installNativeStore(rows)
    const snapshot = await buildContentSnapshot({ revision: 5 })
    expect(snapshot.counts).toMatchObject({ decks: 1, words: 1, wordOverlay: 1, packs: 1, packItems: 1, contentRejects: 1, meta: 1 })
    const keys = snapshot.entries.map((entry) => `${entry.type}:${entry.key}`).sort()
    expect(keys).toEqual(['decks:kv-deck', 'meta:userNote:n1', 'packItems:i1', 'packs:p1', 'wordOverlay:kv-word', 'words:kv-word', 'contentRejects:r1'].sort())
    // 不是 IDB 里的 idb-deck/idbword
    expect(snapshot.entries.some((entry) => entry.key === 'idb-deck' || entry.key === 'idbword')).toBe(false)
    // hash/updatedAt 用 kv 行值
    const wordEntry = snapshot.entries.find((entry) => entry.type === 'words')!
    expect(wordEntry.hash).toBe(hashContentValue(JSON.parse(JSON.stringify(word))))
    expect(wordEntry.updatedAt).toBe(9)
    const metaEntry = snapshot.entries.find((entry) => entry.type === 'meta')!
    expect(metaEntry.key).toBe('userNote:n1')
    expect(metaEntry.hash).toBe(hashContentValue('note'))
    expect(metaEntry.updatedAt).toBe(7)
    expect(snapshot.revision).toBe(5)
  })

  it('同一内容：IDB 模式与 kv 模式产生相同 hash / snapshotId', async () => {
    await resetDatabase()
    await createDeck({ name: 'same', words: [{ headword: 'sameword', meanings: [{ cn: '义' }] }] })
    await getDb().meta.put({ key: 'userNote:same', value: 'v', updatedAt: 5 })
    const idbSnapshot = await buildContentSnapshot({ revision: 1 })
    const kvRows = await kvRowsFromIdb()
    installNativeStore(kvRows)
    await persistContentWriteSource('sqlite')
    await markMigrationReady()
    const kvSnapshot = await buildContentSnapshot({ revision: 1 })
    expect(COMPACT(kvSnapshot.entries)).toEqual(COMPACT(idbSnapshot.entries))
    expect(kvSnapshot.snapshotId).toBe(idbSnapshot.snapshotId)
  })

  it('revision 新增/删除 + baseline→increment→restore 后 hash 与最新 kv 一致', async () => {
    await resetDatabase()
    await createDeck({ name: 'rev', words: [{ headword: 'revword', meanings: [{ cn: '义' }] }] })
    await getDb().meta.put({ key: 'userNote:a', value: 'A', updatedAt: 1 })
    // kv 行与 IDB cache 初始一致
    const initialRows = await kvRowsFromIdb()
    const { rows } = installNativeStore(initialRows)
    await persistContentWriteSource('sqlite')
    await markMigrationReady()
    const snapshot1 = await buildContentSnapshot({ revision: 1 })
    const baselineFile = await buildContentBaselineFile(snapshot1)
    // 变更 kv：新增 note b、删除 note a、改 word 正文（IDB cache 同步变化，仅用于导出增量的正文）
    const word = (await getDb().words.toArray())[0]!
    const wordJson = JSON.stringify({ ...word, headword: 'revword2', updatedAt: 20 })
    await getDb().meta.put({ key: 'userNote:b', value: 'B', updatedAt: 2 })
    await getDb().meta.delete('userNote:a')
    await getDb().words.put({ ...word, headword: 'revword2', updatedAt: 20 } as never)
    rows.get('meta:userNote:a')!.deleted = 1
    rows.set('meta:userNote:b', { key: 'meta:userNote:b', kind: 'meta', json: '"B"', updated_at: 2, revision: 100, deleted: 0 })
    rows.set(`word:${word.id}`, { key: `word:${word.id}`, kind: 'word', json: wordJson, updated_at: 20, revision: 101, deleted: 0 })
    const snapshot2 = await buildContentSnapshot({ revision: 2 })
    // live 行不含删除的 note a；新增/修改可见
    expect(snapshot2.entries.some((entry) => entry.type === 'meta' && entry.key === 'userNote:a')).toBe(false)
    expect(snapshot2.entries.some((entry) => entry.type === 'meta' && entry.key === 'userNote:b')).toBe(true)
    expect(snapshot2.entries.find((entry) => entry.type === 'words')?.hash).toBe(hashContentValue(JSON.parse(wordJson)))
    const delta = diffContentEntries(snapshot1.entries, snapshot2.entries)
    expect(delta.tombstones).toEqual([{ type: 'meta', key: 'userNote:a' }])
    expect(delta.entities.map((entry) => `${entry.type}:${entry.key}`).sort()).toEqual([`meta:userNote:b`, `words:${word.id}`].sort())
    const pkg = buildContentIncrement(snapshot1, snapshot2, { entities: await entitiesOf(snapshot2) })
    if (!('format' in pkg)) throw new Error('expected increment')
    // 链应用后的集合 == 最新 kv 快照（baseline/increment/diff 对同一内容 hash 一致）
    const applied = new Map(snapshot1.entries.map((entry) => [`${entry.type}\u0000${entry.key}`, entry]))
    for (const tombstone of pkg.tombstones) applied.delete(`${tombstone.type}\u0000${tombstone.key}`)
    for (const entity of pkg.entities) applied.set(`${entity.type}\u0000${entity.key}`, { type: entity.type, key: entity.key, hash: entity.hash, updatedAt: entity.updatedAt })
    expect(COMPACT([...applied.values()])).toEqual(COMPACT(snapshot2.entries))
    // 恢复链：content_kv + IDB 都回到最新内容
    const restored = await restoreContentIncrementChain(baselineFile, [pkg])
    expect(restored.ok).toBe(true)
    const snapshotAfter = await buildContentSnapshot({ revision: 3 })
    expect(snapshotAfter.snapshotId).toBe(snapshot2.snapshotId)
    expect(COMPACT(snapshotAfter.entries)).toEqual(COMPACT(snapshot2.entries))
    // IDB cache 同步后从 IDB 构建也是同一 hash
    await persistContentWriteSource('idb')
    const idbAfter = await buildContentSnapshot({ revision: 3 })
    expect(idbAfter.snapshotId).toBe(snapshot2.snapshotId)
    expect((await getDb().meta.get('userNote:a'))).toBeUndefined()
    expect((await getDb().meta.get('userNote:b'))?.value).toBe('B')
    expect((await getDb().words.get(word.id))?.headword).toBe('revword2')
  })
  it('v15 迁移未完成（pending）走 IDB；done 后不再依赖旧 migration ready', async () => {
    await resetDatabase()
    await createDeck({ name: 'not-ready', words: [{ headword: 'idbword2', meanings: [{ cn: '义' }] }] })
    await persistContentWriteSource('sqlite')
    await getDb().meta.put({ key: 'contentMigrationV15', value: { status: 'running' }, updatedAt: Date.now() })
    installNativeStore([{ key: 'deck:kv-only', kind: 'deck', json: JSON.stringify({ id: 'kv-only', name: 'KV', updatedAt: 1 }), updated_at: 1, revision: 1, deleted: 0 }])
    const snapshot = await buildContentSnapshot({ revision: 1 })
    expect(snapshot.entries.some((entry) => entry.key === 'kv-only')).toBe(false)
    expect(snapshot.entries.some((entry) => entry.type === 'decks')).toBe(true)
    // 0.15：v15 done 后 content_kv 即事实源，旧的 contentMigrationState 不再是门禁
    await getDb().meta.put({ key: 'contentMigrationV15', value: 'done', updatedAt: Date.now() })
    await getDb().meta.put({ key: 'contentMigrationState', value: { status: 'failed' }, updatedAt: Date.now() })
    const doneState = await buildContentSnapshot({ revision: 2 })
    expect(doneState.entries.some((entry) => entry.key === 'kv-only')).toBe(true)
  })

  it('IDB cache 落后时增量快照仍以 kv 为准（stale cache 不误判）', async () => {
    await resetDatabase()
    await createDeck({ name: 'stale', words: [{ headword: 'stale-original', meanings: [{ cn: '义' }] }] })
    const { rows: store } = installNativeStore(await kvRowsFromIdb())
    await persistContentWriteSource('sqlite')
    await markMigrationReady()
    const before = await buildContentSnapshot({ revision: 1 })
    // 只改 content_kv，IDB cache 保持 stale
    const wordRow = [...store.values()].find((row) => row.kind === 'word')!
    const changed = { ...JSON.parse(wordRow.json), headword: 'kv-only-change', updatedAt: 50 }
    wordRow.json = JSON.stringify(changed)
    wordRow.updated_at = 50
    const after = await buildContentSnapshot({ revision: 2 })
    const wordEntry = after.entries.find((entry) => entry.type === 'words')!
    expect(wordEntry.hash).toBe(hashContentValue(changed))
    expect(diffContentEntries(before.entries, after.entries).entities.some((entry) => entry.type === 'words')).toBe(true)
    // snapshot 没有反向读 IDB cache
    expect((await getDb().words.toArray())[0]!.headword).toBe('stale-original')
  })

  it('sqlite+ready：正文从 content_kv 取，IDB cache stale 不回退（含 contentGet ≤500/批）', async () => {
    await resetDatabase()
    await createDeck({ name: 'bodies', words: [{ headword: 'idb-old', meanings: [{ cn: '旧' }] }] })
    await getDb().meta.put({ key: 'userNote:body', value: 'idb-body', updatedAt: 3 })
    const { rows: store, calls } = installNativeStore(await kvRowsFromIdb())
    await persistContentWriteSource('sqlite')
    await markMigrationReady()
    // 只改 content_kv 正文，IDB cache 保持 stale
    const wordRow = [...store.values()].find((row) => row.kind === 'word')!
    wordRow.json = JSON.stringify({ ...JSON.parse(wordRow.json), headword: 'kv-new', updatedAt: 50 })
    wordRow.updated_at = 50
    const metaRow = [...store.values()].find((row) => row.key === 'meta:userNote:body')!
    metaRow.json = '"kv-body"'
    const snapshot = await buildContentSnapshot({ revision: 1 })
    const entities = await exportContentEntities(snapshot.entries)
    const wordEntity = entities.find((entity) => entity.type === 'words')!
    expect((wordEntity.data as { headword: string }).headword).toBe('kv-new')
    expect((entities.find((entity) => entity.type === 'meta')!.data)).toBe('kv-body')
    // IDB cache 没被读取/写回
    expect((await getDb().words.toArray())[0]!.headword).toBe('idb-old')
    expect((await getDb().meta.get('userNote:body'))?.value).toBe('idb-body')
    const getCalls = calls.filter((call) => call.method === 'contentGet')
    expect(getCalls.length).toBeGreaterThan(0)
    for (const call of getCalls) expect((call.payload.keys as string[]).length).toBeLessThanOrEqual(500)
  })

  it('正文批量 >500 分批；缺行 data:null 不回退 IDB；坏 JSON fail-closed', async () => {
    await resetDatabase()
    const rows: Row[] = Array.from({ length: 600 }, (_, index) => ({
      key: `meta:userNote:n-${index}`,
      kind: 'meta',
      json: JSON.stringify(`body-${index}`),
      updated_at: 100 + index,
      revision: index + 1,
      deleted: 0,
    }))
    const { rows: store, calls } = installNativeStore(rows)
    await persistContentWriteSource('sqlite')
    await markMigrationReady()
    const entries = rows.map((row) => ({ type: 'meta', key: row.key.slice('meta:'.length), hash: 'h', updatedAt: row.updated_at }))
    const entities = await exportContentEntities(entries)
    expect(entities).toHaveLength(600)
    expect(entities[599]!.data).toBe('body-599')
    const getCalls = calls.filter((call) => call.method === 'contentGet')
    expect(getCalls).toHaveLength(2)
    for (const call of getCalls) expect((call.payload.keys as string[]).length).toBeLessThanOrEqual(500)
    // 缺行：kv 中被并发删掉 → data null，不回落 IDB
    store.get('meta:userNote:n-7')!.deleted = 1
    const missing = await exportContentEntities(entries.slice(0, 10))
    expect(missing.find((entity) => entity.key === 'userNote:n-7')!.data).toBeNull()
    // 坏 JSON：fail-closed
    store.get('meta:userNote:n-8')!.json = '{bad-json'
    await expect(exportContentEntities(entries.slice(0, 10))).rejects.toThrow(/JSON 损坏/)
  })

  it('IDB stale 下 baseline→increment→restore 正文/hash 一致', async () => {
    await resetDatabase()
    await createDeck({ name: 'chain-bodies', words: [{ headword: 'idb-old', meanings: [{ cn: '旧' }] }] })
    const { rows: store } = installNativeStore(await kvRowsFromIdb())
    await persistContentWriteSource('sqlite')
    await markMigrationReady()
    // kv 正文改掉，IDB 保持 stale
    const wordRow = [...store.values()].find((row) => row.kind === 'word')!
    wordRow.json = JSON.stringify({ ...JSON.parse(wordRow.json), headword: 'kv-first', updatedAt: 60 })
    wordRow.updated_at = 60
    const snapshot1 = await buildContentSnapshot({ revision: 1 })
    const baselineFile = await buildContentBaselineFile(snapshot1)
    const baseWord = baselineFile.entities.find((entity) => entity.type === 'words')!
    expect((baseWord.data as { headword: string }).headword).toBe('kv-first')
    // baseline 恢复：正文来自 kv → IDB 被修正为 kv 内容
    expect((await restoreContentBaseline(baselineFile)).ok).toBe(true)
    const snapshotAfterBaseline = await buildContentSnapshot({ revision: 1 })
    expect(snapshotAfterBaseline.snapshotId).toBe(snapshot1.snapshotId)
    await persistContentWriteSource('idb')
    expect((await getDb().words.toArray())[0]!.headword).toBe('kv-first')
    await persistContentWriteSource('sqlite')
    await markMigrationReady()
    // 增量：只改 kv 新增 note，IDB 不同步；正文仍必须来自 kv
    store.set('meta:userNote:inc', { key: 'meta:userNote:inc', kind: 'meta', json: '"inc-body"', updated_at: 70, revision: 999, deleted: 0 })
    const snapshot2 = await buildContentSnapshot({ revision: 2 })
    const pkg = buildContentIncrement(snapshot1, snapshot2, { entities: await entitiesOf(snapshot2) })
    if (!('format' in pkg)) throw new Error('expected increment')
    const incMeta = pkg.entities.find((entity) => entity.type === 'meta' && entity.key === 'userNote:inc')!
    expect(incMeta.data).toBe('inc-body')
    expect((await restoreContentIncrementChain(baselineFile, [pkg])).ok).toBe(true)
    const snapshotAfterChain = await buildContentSnapshot({ revision: 3 })
    expect(snapshotAfterChain.snapshotId).toBe(snapshot2.snapshotId)
    await persistContentWriteSource('idb')
    expect((await getDb().meta.get('userNote:inc'))?.value).toBe('inc-body')
  })

})
