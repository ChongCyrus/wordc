import { primeLegacySqliteContentSource } from './test-utils'
import './test-utils'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CONTENT_MIGRATION_STATE_KEY,
  createDeck,
  ensureContentSourceAfterImport,
  ensureContentSourceV15,
  getContentMigrationState,
  getContentMigrationV15State,
  getContentWriteSource,
  getDb,
  getSettings,
  invalidateContentMigrationV15Cache,
  isContentMigrationV15Done,
  putContentRow,
  readContentCounts,
  resetDatabase,
  rollbackContentWriteSource,
  switchContentWriteSource,
  clearContentWriteSourceEmergency,
  setSqliteTransport,
} from '../../src/data'
import { persistContentWriteSource, writeContentMigrationV15State } from '../../src/data/content-write-source'

/**
 * 0.15 task-293：原生 SQLite 单一事实源 + v15 一次性迁移。
 *
 * 约定（Lead 0.15 约束）：
 * - native APK（MomoBridge momo-apk + 原生 SQLite）= SQLite 唯一事实源；Web = IDB；
 * - fresh 只当「没有任何可变内容」（含无 states/plans）；绝不先清 content_kv 再标 done；
 * - 迁移成功必须 IDB 快照（集合/kind/hash）与 content_kv live 一致（含差集删除）；
 * - v15 running 时写源仍 idb（旧 0.14 sqlite+ready 基线除外）；marker 双写 SQLite + IDB，读 SQLite 优先。
 *
 * 原生 mock：content_* 协议 + health(userVersion) + migration_state query/tx（durable marker）。
 */
interface NativeKvRow {
  key: string
  kind: string
  json: string
  updated_at: number
  revision: number
  deleted: 0 | 1
}

interface NativeV15Mock {
  rows: Map<string, NativeKvRow>
  durable: Map<string, string>
  writes: number
  setUserVersion: (version: number) => void
  failContentWriteAt: (n: number | null) => void
  seedKv: (key: string, kind: string, value: unknown) => void
  liveKeys: () => string[]
  tombstonedKeys: () => string[]
}

function installNativeMock(opts: { userVersion?: number } = {}): NativeV15Mock {
  const state = {
    rows: new Map<string, NativeKvRow>(),
    durable: new Map<string, string>(),
    writes: 0,
    userVersion: opts.userVersion ?? 3,
    failAt: null as number | null,
    revision: 0,
    seq: 0,
  }
  const mock: NativeV15Mock = {
    rows: state.rows,
    durable: state.durable,
    get writes() {
      return state.writes
    },
    setUserVersion: (version) => {
      state.userVersion = version
    },
    failContentWriteAt: (n) => {
      state.failAt = n
      state.writes = 0
    },
    seedKv: (key, kind, value) => {
      state.revision += 1
      state.rows.set(key, { key, kind, json: JSON.stringify(value), updated_at: Date.now(), revision: state.revision, deleted: 0 })
    },
    liveKeys: () => [...state.rows.values()].filter((row) => row.deleted === 0).map((row) => row.key),
    tombstonedKeys: () => [...state.rows.values()].filter((row) => row.deleted === 1).map((row) => row.key),
  } as NativeV15Mock
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${req.id}-r${++state.seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (requestId: string, payload: string) => void }).__momoSqliteResult
        const payload = req.payload ?? {}
        if (req.method === 'health') {
          cb?.(id, JSON.stringify({ ok: true, userVersion: state.userVersion, wal: false, integrityOk: true, synchronous: 'FULL', readOnly: false, sizeBytes: 0, dataEpoch: 0 }))
          return
        }
        if (req.method === 'query') {
          const table = String(payload.table ?? '')
          if (table === 'migration_state') {
            const where = (payload.where ?? {}) as { step?: string }
            const rows = [...state.durable.entries()]
              .filter(([step]) => (where.step ? step === where.step : true))
              .map(([step, status]) => ({ step, status }))
            cb?.(id, JSON.stringify({ ok: true, rows, revision: state.revision }))
            return
          }
          cb?.(id, JSON.stringify({ ok: true, rows: [] }))
          return
        }
        if (req.method === 'tx') {
          const ops = (payload.ops as Array<{ op: string; table?: string; row?: Record<string, unknown> }> | undefined) ?? (req as unknown as { ops?: Array<{ op: string; table?: string; row?: Record<string, unknown> }> }).ops ?? []
          for (const op of ops) {
            if (op.op === 'upsert' && op.table === 'migration_state' && op.row) {
              const step = String(op.row.step ?? '')
              if (step) state.durable.set(step, String(op.row.status ?? ''))
            }
          }
          cb?.(id, JSON.stringify({ ok: true, changes: ops.length }))
          return
        }
        if (req.method === 'contentCounts') {
          const all = [...state.rows.values()]
          const byKind: Record<string, number> = {}
          for (const row of all) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
          cb?.(id, JSON.stringify({ ok: true, total: all.length, deleted: all.filter((row) => row.deleted === 1).length, byKind, revision: state.revision }))
          return
        }
        if (req.method === 'contentWrite') {
          state.writes += 1
          if (state.failAt !== null && state.writes === state.failAt) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock content write fail' }))
            return
          }
          const expectedRevision = Number(payload.expectedRevision ?? -1)
          if (expectedRevision >= 0 && expectedRevision !== state.revision) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_CONFLICT', message: `content revision ${state.revision} != ${expectedRevision}` }))
            return
          }
          state.revision += 1
          const entries = (payload.entries ?? []) as Array<{ key: string; kind: string; json: string; updated_at?: number }>
          const deletes = (payload.deletes ?? []) as string[]
          for (const entry of entries) state.rows.set(entry.key, { key: entry.key, kind: entry.kind, json: entry.json, updated_at: Number(entry.updated_at ?? Date.now()), revision: state.revision, deleted: 0 })
          for (const key of deletes) {
            const previous = state.rows.get(key)
            if (previous) state.rows.set(key, { ...previous, revision: state.revision, deleted: 1, updated_at: Date.now() })
          }
          cb?.(id, JSON.stringify({ ok: true, revision: state.revision, upserts: entries.length, deletes: deletes.length }))
          return
        }
        if (req.method === 'contentGet') {
          const keys = (payload.keys ?? []) as string[]
          cb?.(id, JSON.stringify({ ok: true, rows: keys.map((key) => state.rows.get(key)).filter(Boolean), revision: state.revision }))
          return
        }
        if (req.method === 'contentList') {
          const limit = Number(payload.limit ?? 200)
          const offset = Number(payload.offset ?? 0)
          const includeDeleted = payload.includeDeleted === true
          const orderBy = String(payload.orderBy ?? 'key')
          const listed = [...state.rows.values()].filter((row) => includeDeleted || row.deleted === 0)
          listed.sort((a, b) => (orderBy === 'revision' ? a.revision - b.revision || a.key.localeCompare(b.key) : a.key.localeCompare(b.key)))
          const page = listed.slice(offset, offset + limit)
          cb?.(id, JSON.stringify({ ok: true, rows: page, revision: state.revision, hasMore: offset + limit < listed.length }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  } as never)
  return mock
}

const globals = globalThis as unknown as { MomoBridge?: { isNativeApp?: () => string }; window?: unknown }

function stubNative(): void {
  globals.MomoBridge = { isNativeApp: () => 'momo-apk' }
}

function stubWebWindow(): () => void {
  const had = 'window' in globals
  const previous = globals.window
  globals.window = {}
  return () => {
    if (had) globals.window = previous
    else delete globals.window
  }
}

async function seedCustomDeck(name = 'v15-deck'): Promise<string> {
  const deck = await createDeck({ name, words: [{ headword: `${name}-a`, meanings: [{ cn: '义' }] }] })
  return deck.id
}

beforeEach(async () => {
  await resetDatabase()
  invalidateContentMigrationV15Cache()
})

afterEach(async () => {
  setSqliteTransport(null)
  delete globals.MomoBridge
  delete globals.window
  invalidateContentMigrationV15Cache()
  await persistContentWriteSource('idb').catch(() => undefined)
})

describe('0.15 A：原生 SQLite 单一事实源 + v15 迁移', () => {
  it('web：无原生桥时写源恒 idb（settings 残留 sqlite 也不认），v15 跳过', async () => {
    const restoreWindow = stubWebWindow()
    try {
      await primeLegacySqliteContentSource()
      expect(await getContentWriteSource()).toBe('idb')
      const result = await ensureContentSourceV15()
      expect(result).toMatchObject({ ok: true, source: 'idb', skipped: 'non-native' })
      expect(await isContentMigrationV15Done()).toBe(false)
      expect(await getContentMigrationV15State()).toBeNull()
    } finally {
      restoreWindow()
    }
  })

  it('fresh 空库：直接 done + sqlite（content_kv 可为空），幂等；旧 settings 被忽略', async () => {
    stubNative()
    const mock = installNativeMock()
    const result = await ensureContentSourceV15()
    expect(result).toMatchObject({ ok: true, source: 'sqlite', from: 'fresh' })
    expect(mock.durable.get('content-v15')).toBe('done')
    expect((await getContentMigrationV15State())?.status).toBe('done')
    expect(await isContentMigrationV15Done()).toBe(true)
    expect(await getContentWriteSource()).toBe('sqlite')
    expect((await readContentCounts()).total).toBe(0)
    // already-done 幂等
    expect(await ensureContentSourceV15()).toMatchObject({ ok: true, source: 'sqlite', skipped: 'already-done' })
    // 0.15：旧 settings 不再决定写源
    await persistContentWriteSource('idb')
    expect(await getContentWriteSource()).toBe('sqlite')
    // 完成后 emergency override 仍可强制 idb（内部/调试）
    expect((await rollbackContentWriteSource()).ok).toBe(true)
    expect(await getContentWriteSource()).toBe('idb')
    expect((await clearContentWriteSourceEmergency()).ok).toBe(true)
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('fresh 判据严格：仅内置 deck（可再生）+ 有 states/plans → 走迁移而非 done 清库', async () => {
    stubNative()
    const mock = installNativeMock()
    // 构造「仅内置 deck」+ 一条学习状态（states 非空 → 不是 fresh）
    const deck = await createDeck({ name: 'builtin-like', words: [{ headword: 'b1', meanings: [{ cn: '义' }] }] })
    await getDb().decks.update(deck.id, { source: 'builtin', builtinKey: 'builtin-like' } as never)
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().states.put({ wordId: word.id, deckId: deck.id, phase: 'learning', dueAt: 0, memoryStrength: 1, reviewCount: 1 } as never)
    const result = await ensureContentSourceV15()
    expect(result.ok).toBe(true)
    expect(result.from).toBe('legacy-idb')
    expect(await isContentMigrationV15Done()).toBe(true)
    // 迁移路径：只把内置 deck 行同步进 kv（可再生产物），不因「无可变内容」清库
    expect(mock.liveKeys().some((key) => key.startsWith('deck:'))).toBe(true)
    expect(await getDb().states.count()).toBe(1)
  })

  it('旧 0.14 已是 sqlite+ready：直接 done（不重扫 IDB、不写 content_kv）', async () => {
    stubNative()
    const mock = installNativeMock()
    await seedCustomDeck('legacy-sqlite')
    await primeLegacySqliteContentSource()
    await putContentRow({ key: 'deck:legacy-deck', kind: 'deck', json: JSON.stringify({ id: 'legacy-deck', name: 'kv事实' }) })
    await getDb().meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    const writesBefore = mock.writes
    const result = await ensureContentSourceV15()
    expect(result).toMatchObject({ ok: true, source: 'sqlite', from: 'legacy-sqlite-ready' })
    expect(mock.durable.get('content-v15')).toBe('done')
    expect(mock.writes).toBe(writesBefore)
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('P1-1 旧 0.14 sqlite+ready 但 kv 被清空且 IDB 仍有可变内容：拒绝 done，保持可诊断', async () => {
    stubNative()
    installNativeMock()
    await seedCustomDeck('legacy-empty-kv')
    await primeLegacySqliteContentSource()
    await getDb().meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    const result = await ensureContentSourceV15()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('E_V15_LEGACY_KV_EMPTY')
    expect(await isContentMigrationV15Done()).toBe(false)
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('P1-2 导入遗留 stale 后 v15 迁移成功：清除 stale，后续备份不再被 stale 拒绝', async () => {
    stubNative()
    installNativeMock()
    await seedCustomDeck('stale-retry')
    await getDb().meta.put({ key: 'contentKvStale', value: { at: Date.now() }, updatedAt: Date.now() })
    const result = await ensureContentSourceV15()
    expect(result).toMatchObject({ ok: true, from: 'legacy-idb' })
    expect(await getDb().meta.get('contentKvStale')).toBeUndefined()
    expect(await isContentMigrationV15Done()).toBe(true)
  })

  it('旧 0.14 idb（未迁移）：preBackup→迁移→parity→done；kv 与 IDB 内容集合一致', async () => {
    stubNative()
    const mock = installNativeMock()
    const deckId = await seedCustomDeck('from-idb')
    let backups = 0
    const result = await ensureContentSourceV15({
      preBackup: async () => {
        backups += 1
        return { ok: true }
      },
    })
    expect(result).toMatchObject({ ok: true, source: 'sqlite', from: 'legacy-idb', migrated: true })
    expect(backups).toBe(1)
    expect(mock.durable.get('content-v15')).toBe('done')
    expect(await getContentWriteSource()).toBe('sqlite')
    // content_kv 含自定义 deck + word
    expect(mock.liveKeys()).toContain(`deck:${deckId}`)
    const words = await getDb().words.toArray()
    expect(mock.liveKeys()).toContain(`word:${words[0]!.id}`)
    // 迁移 state ready + coverage 已 finalize（v15 数据层置位，不暴露切换）
    const state14 = await getContentMigrationState()
    expect(state14?.status).toBe('ready')
    expect(state14?.writeCoverageComplete).toBe(true)
  })

  it('旧 0.14 ready 但 IDB 指纹已变化：重跑 shadow（B-D4），最终 kv 含新内容', async () => {
    stubNative()
    const mock = installNativeMock()
    const deckId = await seedCustomDeck('stale-ready')
    // 伪造「0.14 ready + 旧指纹」：IDB 已变化但仍 ready
    await getDb().meta.put({
      key: CONTENT_MIGRATION_STATE_KEY,
      value: { status: 'ready', writeCoverageComplete: false, idbFingerprint: { version: 1, counts: {}, hash: 'stale-hash', at: 0 } },
      updatedAt: Date.now(),
    })
    await persistContentWriteSource('idb')
    const result = await ensureContentSourceV15()
    expect(result.ok).toBe(true)
    expect(await isContentMigrationV15Done()).toBe(true)
    expect(mock.liveKeys()).toContain(`deck:${deckId}`)
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('迁移成功判据：content_kv 旧 live 差集被 tombstone（含删除），parity 后 done', async () => {
    stubNative()
    const mock = installNativeMock()
    await seedCustomDeck('prune')
    mock.seedKv('deck:ghost', 'deck', { id: 'ghost', name: 'ghost' })
    mock.seedKv('meta:userNote:old', 'meta', 'stale')
    const result = await ensureContentSourceV15()
    expect(result.ok).toBe(true)
    expect(result.tombstoned).toBeGreaterThanOrEqual(1)
    expect(mock.tombstonedKeys()).toEqual(expect.arrayContaining(['deck:ghost']))
    expect(mock.liveKeys()).not.toContain('deck:ghost')
  })

  it('中断恢复：v15 running + 0.14 running → 重跑并 done（attempt 递增）', async () => {
    stubNative()
    const mock = installNativeMock()
    await seedCustomDeck('resume')
    await writeContentMigrationV15State({ status: 'running', at: Date.now(), attempt: 1 })
    await getDb().meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status: 'running', token: 't' }, updatedAt: Date.now() })
    expect(await getContentWriteSource()).toBe('idb')
    const result = await ensureContentSourceV15()
    expect(result.ok).toBe(true)
    expect(await isContentMigrationV15Done()).toBe(true)
    expect((await getContentMigrationV15State())?.attempt).toBe(2)
    expect((await getContentMigrationState())?.status).toBe('ready')
    expect(mock.durable.get('content-v15')).toBe('done')
  })

  it('失败保持 idb：schema v3 门禁不满足 → failed + 明确 code，不写 content_kv', async () => {
    stubNative()
    const mock = installNativeMock({ userVersion: 2 })
    await seedCustomDeck('schema')
    const result = await ensureContentSourceV15()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('E_CONTENT_SCHEMA')
    expect(result.source).toBe('idb')
    expect(await getContentWriteSource()).toBe('idb')
    const v15 = await getContentMigrationV15State()
    expect(v15?.status).toBe('failed')
    expect(v15?.code).toBe('E_CONTENT_SCHEMA')
    expect(mock.writes).toBe(0)
  })

  it('preBackup 失败：不迁移、保持 idb、v15 failed', async () => {
    stubNative()
    installNativeMock()
    await seedCustomDeck('prebackup')
    const result = await ensureContentSourceV15({ preBackup: async () => ({ ok: false, error: 'disk full' }) })
    expect(result.ok).toBe(false)
    expect(result.source).toBe('idb')
    expect(await getContentWriteSource()).toBe('idb')
    expect((await getContentMigrationV15State())?.status).toBe('failed')
    expect((await readContentCounts()).total).toBe(0)
  })

  it('数据保护：IDB 无可变内容但 content_kv 有 live 行 → 拒绝清库标 done（E_V15_KV_NOT_EMPTY）', async () => {
    stubNative()
    const mock = installNativeMock()
    mock.seedKv('deck:only-copy', 'deck', { id: 'only-copy', name: '仅剩内容库一份' })
    mock.seedKv('meta:userNote:keep', 'meta', 'keep')
    const result = await ensureContentSourceV15()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('E_V15_KV_NOT_EMPTY')
    expect(result.source).toBe('idb')
    // 绝不先清 content_kv：两行原样保留
    expect(mock.liveKeys()).toEqual(expect.arrayContaining(['deck:only-copy', 'meta:userNote:keep']))
    expect(mock.tombstonedKeys()).toHaveLength(0)
    expect(await getContentWriteSource()).toBe('idb')
    expect((await getContentMigrationV15State())?.status).toBe('failed')
  })

  it('marker 读取以 SQLite 为准：durable failed 不被 IDB mirror done 覆盖', async () => {
    stubNative()
    const mock = installNativeMock()
    mock.durable.set('content-v15', 'failed')
    await getDb().meta.put({ key: 'contentMigrationV15', value: { status: 'done', at: Date.now() }, updatedAt: Date.now() })
    invalidateContentMigrationV15Cache()
    expect(await isContentMigrationV15Done()).toBe(false)
    expect(await getContentWriteSource()).toBe('idb')
    mock.durable.set('content-v15', 'done')
    invalidateContentMigrationV15Cache()
    expect(await isContentMigrationV15Done()).toBe(true)
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('v15 done 后 switchContentWriteSource 被拒绝（固定 sqlite），emergency 仍可回退', async () => {
    stubNative()
    installNativeMock()
    expect((await ensureContentSourceV15()).ok).toBe(true)
    const switched = await switchContentWriteSource()
    expect(switched.ok).toBe(false)
    expect(switched.error).toContain('固定为 SQLite')
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('v15 running 期间写源仍 idb；旧 0.14 sqlite+ready 基线例外仍 sqlite', async () => {
    stubNative()
    installNativeMock()
    await writeContentMigrationV15State({ status: 'running', at: Date.now(), attempt: 1 })
    await persistContentWriteSource('idb')
    expect(await getContentWriteSource()).toBe('idb')
    // 旧基线：settings sqlite + contentMigrationState ready
    await primeLegacySqliteContentSource()
    await getDb().meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('0.15 B：ensureContentSourceAfterImport native v15 保持 sqlite + 差集 tombstone', async () => {
    stubNative()
    const mock = installNativeMock()
    await seedCustomDeck('import')
    expect((await ensureContentSourceV15()).ok).toBe(true)
    // 导入留下旧 live 实体行（IDB 里已没有）
    mock.seedKv('deck:ghost', 'deck', { id: 'ghost' })
    mock.seedKv('word:ghost-word', 'word', { id: 'ghost-word' })
    const result = await ensureContentSourceAfterImport()
    expect(result).toMatchObject({ ok: true, source: 'sqlite', tombstoned: 2 })
    expect(mock.tombstonedKeys()).toEqual(expect.arrayContaining(['deck:ghost', 'word:ghost-word']))
    expect((await getSettings())['data.contentWriteSource']).toBe('sqlite')
    expect(await getContentWriteSource()).toBe('sqlite')
  })

  it('0.15 B：ensureContentSourceAfterImport 迁移未完成 → 仍 idb + stale 标记 + 不动 v15 marker', async () => {
    stubNative()
    const mock = installNativeMock()
    await seedCustomDeck('pending-import')
    await persistContentWriteSource('idb')
    await putContentRow({ key: 'deck:old-live', kind: 'deck', json: '{}' })
    await getDb().meta.put({ key: CONTENT_MIGRATION_STATE_KEY, value: { status: 'ready', writeCoverageComplete: true }, updatedAt: Date.now() })
    const result = await ensureContentSourceAfterImport()
    expect(result).toMatchObject({ ok: true, source: 'idb', tombstoned: 0 })
    expect(await getContentWriteSource()).toBe('idb')
    expect((await getDb().meta.get('contentMigrationState'))).toBeUndefined()
    expect((await getDb().meta.get('contentKvStale'))?.value).toMatchObject({ reason: 'ensureContentSourceAfterImport' })
    expect(await getContentMigrationV15State()).toBeNull()
    expect(mock.durable.get('content-v15')).toBeUndefined()
  })
})
