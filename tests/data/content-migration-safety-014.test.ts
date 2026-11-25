import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildContentMigrationPlan,
  createDeck,
  getDb,
  getContentMigrationState,
  getContentRow,
  putContentRow,
  readContentCounts,
  resetDatabase,
  runContentMigrationFormal,
  runContentMigrationShadow,
  saveWordOverlay,
  setSqliteTransport,
  withDataWriteLock,
  writeContentRows,
} from '../../src/data'
import { persistContentWriteSource } from '../../src/data/content-write-source'
import { listContentRowsPage } from '../../src/data/content-store'

/**
 * 0.14 迁移安全闭环回归（qa-0.14-closure-checklist）：
 * - B-D2：迁移失败/中断按写前快照 undo 所有已写批；失败不碰 IDB、不切写源
 * - B-D3：counts 按 kind + deleted，且对 ≥20 条（小库全量）抽样校验内容 hash
 * - B-D4：ready 后 IDB 内容变化 → formal 重跑 shadow（非幂等）
 * - S4/S7：shadow/formal 全程 withDataWriteLock，与其它数据写互斥
 *
 * 原生 mock 与 SqliteDao 对齐：
 * - contentCounts.total/byKind 含 tombstone 行，deleted 单列 tombstone 数；
 * - contentList 默认排除 deleted，includeDeleted=true 才含；
 * - contentGet 按 key 返回全字段（含 deleted）；
 * - contentWrite 校验 expectedRevision，delete 只 update 已存在行。
 */
interface NativeKvRow {
  key: string
  kind: string
  json: string
  updated_at: number
  revision: number
  deleted: 0 | 1
}

interface NativeMock {
  rows: Map<string, NativeKvRow>
  writes: Array<{ entries: Array<{ key: string; kind: string; json: string }>; deletes: string[] }>
  /** 第 N 次 contentWrite 直接失败（1 基，全局累计） */
  failAtWrite: { value: number | null }
  /** 全局 contentWrite 调用计数（含测试预置写入） */
  writeCalls: { value: number }
  /** 迁移写成功后的 counts 被篡改（模拟旧行凑数/kind 不一致） */
  poisonCountsAfterWrite: { value: ((actual: { total: number; deleted: number; byKind: Record<string, number> }) => { total: number; deleted: number; byKind: Record<string, number> }) | null }
  /** 写入时篡改某行 json（模拟内容损坏，测抽样 hash） */
  corruptJson: { value: ((entry: { key: string; kind: string; json: string }) => string) | null }
}

function installNativeMock(): NativeMock {
  const mock: NativeMock = {
    rows: new Map<string, NativeKvRow>(),
    writes: [],
    failAtWrite: { value: null },
    writeCalls: { value: 0 },
    poisonCountsAfterWrite: { value: null },
    corruptJson: { value: null },
  }
  let revision = 0
  let seq = 0
  let contentWriteCount = 0
  setSqliteTransport({
    sqliteCall(json: string) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown> }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (requestId: string, payload: string) => void }).__momoSqliteResult
        const payload = req.payload ?? {}
        if (req.method === 'contentCounts') {
          const all = [...mock.rows.values()]
          const byKind: Record<string, number> = {}
          for (const row of all) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
          let counts = { total: all.length, deleted: all.filter((row) => row.deleted === 1).length, byKind }
          if (mock.poisonCountsAfterWrite.value && mock.writes.length > 0) counts = mock.poisonCountsAfterWrite.value(counts)
          cb?.(id, JSON.stringify({ ok: true, ...counts, revision }))
          return
        }
        if (req.method === 'contentWrite') {
          contentWriteCount += 1
          mock.writeCalls.value = contentWriteCount
          if (mock.failAtWrite.value !== null && contentWriteCount === mock.failAtWrite.value) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock content write fail' }))
            return
          }
          const expectedRevision = Number(payload.expectedRevision ?? -1)
          if (expectedRevision >= 0 && expectedRevision !== revision) {
            cb?.(id, JSON.stringify({ ok: false, code: 'E_CONFLICT', message: `content revision ${revision} != ${expectedRevision}` }))
            return
          }
          revision += 1
          const entries = (payload.entries ?? []) as Array<{ key: string; kind: string; json: string; updated_at?: number }>
          const deletes = (payload.deletes ?? []) as string[]
          for (const entry of entries) {
            const stored = { key: entry.key, kind: entry.kind, json: entry.json, updated_at: Number(entry.updated_at ?? Date.now()), revision, deleted: 0 as const }
            if (mock.corruptJson.value) stored.json = mock.corruptJson.value(entry)
            mock.rows.set(entry.key, stored)
          }
          for (const key of deletes) {
            const previous = mock.rows.get(key)
            if (previous) mock.rows.set(key, { ...previous, revision, deleted: 1, updated_at: Date.now() })
          }
          mock.writes.push({ entries, deletes })
          cb?.(id, JSON.stringify({ ok: true, revision, upserts: entries.length, deletes: deletes.length }))
          return
        }
        if (req.method === 'contentGet') {
          const keys = (payload.keys ?? []) as string[]
          cb?.(id, JSON.stringify({ ok: true, rows: keys.map((key) => mock.rows.get(key)).filter(Boolean), revision }))
          return
        }
        if (req.method === 'contentList') {
          const includeDeleted = payload.includeDeleted === true
          const limit = Number(payload.limit ?? 200)
          const offset = Number(payload.offset ?? 0)
          const orderBy = String(payload.orderBy ?? 'key')
          const rows = [...mock.rows.values()].filter((row) => includeDeleted || row.deleted === 0)
          rows.sort((a, b) => (orderBy === 'key' ? a.key.localeCompare(b.key) : a.revision - b.revision))
          const page = rows.slice(offset, offset + limit)
          cb?.(id, JSON.stringify({ ok: true, rows: page, revision, hasMore: page.length === limit }))
          return
        }
        cb?.(id, JSON.stringify({ ok: true }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  })
  return mock
}

afterEach(async () => {
  setSqliteTransport(null)
  await persistContentWriteSource('idb')
})

describe('0.14 migration safety（B-D2/B-D3/B-D4/S4）', () => {
  it('B-D2：第 2 批失败 → 快照 undo 第 1 批，旧行恢复、新建 key 删除、IDB/写源不变', async () => {
    await resetDatabase()
    const mock = installNativeMock()
    await createDeck({ name: 'big', words: Array.from({ length: 60 }, (_, index) => ({ headword: `w${index}`, meanings: [{ cn: `义${index}` }] })) })
    const plan = await buildContentMigrationPlan({ batchSize: 50 })
    expect(plan.length).toBeGreaterThan(1)
    // 预置 content_kv：一个将被覆盖的旧行 + 一个无关 tombstone（deleted 基线）
    const overwritten = plan[0]!.rows[0]!
    await putContentRow({ key: overwritten.key, kind: overwritten.kind, json: '{"old":true}' })
    await writeContentRows([{ key: 'meta:userNote:stale', kind: 'meta', json: 'null', deleted: true }])
    const beforeCounts = await readContentCounts()
    mock.failAtWrite.value = mock.writeCalls.value + 2
    const result = await runContentMigrationShadow({ batchSize: 50 })
    expect(result.ok).toBe(false)
    expect(result.written).toBe(50)
    expect(result.error).toContain('mock content write fail')
    expect((await getContentMigrationState())?.status).toBe('failed')
    // undo：旧行原样恢复；第 1 批新建行被回滚；计数回到写前基线
    expect((await getContentRow(overwritten.key))?.json).toBe('{"old":true}')
    // content_kv 无硬删除：已写 50 行回滚为 tombstone，live 内容回到写前（仅旧行）
    const liveRows = [...mock.rows.values()].filter((row) => row.deleted === 0)
    expect(liveRows).toHaveLength(1)
    expect(liveRows[0]!.key).toBe(overwritten.key)
    const afterCounts = await readContentCounts()
    expect(afterCounts.deleted).toBe(beforeCounts.deleted + 49)
    expect(afterCounts.total).toBe(beforeCounts.total + 49)
    // 未写到的第 2 批 key 不产生新行/新 tombstone
    const secondBatchKeys = plan[1]!.rows.map((row) => row.key)
    for (const key of secondBatchKeys) expect(mock.rows.has(key)).toBe(false)
    expect(await getDb().words.count()).toBe(60)
    expect(await getDb().decks.count()).toBe(1)
  })

  it('B-D2：写成功但 counts 校验失败 → undo 全部已写行（不残留半迁移）', async () => {
    await resetDatabase()
    const mock = installNativeMock()
    await createDeck({ name: 'd', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    mock.poisonCountsAfterWrite.value = (actual) => ({ ...actual, byKind: { ...actual.byKind, word: (actual.byKind.word ?? 0) + 1 } })
    const result = await runContentMigrationShadow()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('kind=word')
    expect((await getContentMigrationState())?.status).toBe('failed')
    // undo 后 content_kv 无 live 行、无写前不存在的残留行
    expect([...mock.rows.values()].filter((row) => row.deleted === 0)).toHaveLength(0)
    expect(await getDb().words.count()).toBe(1)
  })

  it('B-D3：抽样内容 hash 不一致 → 失败并 undo', async () => {
    await resetDatabase()
    const mock = installNativeMock()
    await createDeck({ name: 'hash', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    mock.corruptJson.value = (entry) => (entry.kind === 'word' ? entry.json.replace(/}$/, ',"__corrupt":true}') : entry.json)
    const result = await runContentMigrationShadow()
    expect(result.ok).toBe(false)
    expect(result.error).toContain('hash 不一致')
    expect((await getContentMigrationState())?.status).toBe('failed')
    expect([...mock.rows.values()].filter((row) => row.deleted === 0)).toHaveLength(0)
  })

  it('S4：迁移期间 IDB 内容变化（preBackup 写入）→ E_CONTENT_CHANGED 需重跑，不写 content_kv', async () => {
    await resetDatabase()
    const mock = installNativeMock()
    await createDeck({ name: 'base', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    const result = await runContentMigrationShadow({
      preBackup: async () => {
        // 模拟迁移期间的内容写入口（idb 模式写 IDB cache，不走 withDataWriteLock）
        const word = (await getDb().words.toArray())[0]!
        await saveWordOverlay({ ...word, rootEtymology: { parts: [], source: 'manual', updatedAt: Date.now() } })
        return { ok: true }
      },
    })
    expect(result.ok).toBe(false)
    expect(result.needsRerun).toBe(true)
    expect(result.error).toContain('E_CONTENT_CHANGED')
    expect(mock.writes).toHaveLength(0)
    const state = await getContentMigrationState()
    expect(state?.status).toBe('failed')
    expect(state?.needsRerun).toBe(true)
    expect((await readContentCounts()).total).toBe(0)
    expect((await getDb().words.toArray())[0]?.rootEtymology).toMatchObject({ parts: [], source: 'manual' })
  })

  it('B-D4：ready 后 IDB 内容变化 → formal 重跑 shadow（不幂等）；未变化 → 幂等', async () => {
    await resetDatabase()
    const mock = installNativeMock()
    await createDeck({ name: 'first', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    const first = await runContentMigrationFormal()
    expect(first.ok).toBe(true)
    expect(first.idempotent).toBeUndefined()
    const state1 = await getContentMigrationState()
    expect(state1?.status).toBe('ready')
    expect(state1?.idbFingerprint?.version).toBe(1)
    const writesAfterFirst = mock.writes.length
    const second = await runContentMigrationFormal()
    expect(second.ok).toBe(true)
    expect(second.idempotent).toBe(true)
    expect(mock.writes.length).toBe(writesAfterFirst)
    // IDB 内容变化 → rootEtymology meta 影响指纹，触发重跑
    await getDb().meta.put({ key: 'rootEtymology:late', value: { parts: [] }, updatedAt: Date.now() })
    const third = await runContentMigrationFormal()
    expect(third.ok).toBe(true)
    expect(third.idempotent).toBeUndefined()
    expect(mock.writes.length).toBeGreaterThan(writesAfterFirst)
    const state2 = await getContentMigrationState()
    expect(state2?.status).toBe('ready')
    expect(state2?.idbFingerprint?.hash).not.toBe(state1?.idbFingerprint?.hash)
    // 重跑后 content_kv 含新内容
    expect((await readContentCounts()).total).toBeGreaterThan(0)
  })

  it('B-D2：>500 受影响 key 走 contentList 全量分页快照，旧行覆盖/无关 tombstone 保留', async () => {
    await resetDatabase()
    const mock = installNativeMock()
    await createDeck({ name: 'large', words: Array.from({ length: 520 }, (_, index) => ({ headword: `big${index}`, meanings: [{ cn: `义${index}` }] })) })
    const plan = await buildContentMigrationPlan()
    const rows = plan.flatMap((batch) => batch.rows)
    expect(rows.length).toBeGreaterThan(500)
    // 预置 content_kv：一个将被覆盖的旧行 + 一个无关 tombstone（全量分页快照需能读到）
    const target = rows[0]!
    await putContentRow({ key: target.key, kind: target.kind, json: '{"stale":true}' })
    await writeContentRows([{ key: 'meta:userNote:old', kind: 'meta', json: '{"keep":true}' }])
    await writeContentRows([{ key: 'meta:userNote:old', kind: 'meta', json: 'null', deleted: true }])
    const result = await runContentMigrationShadow()
    expect(result.ok).toBe(true)
    expect(result.written).toBe(rows.length)
    // 旧行被迁移内容覆盖；无关 tombstone 保持 tombstone（不复活）
    expect((await getContentRow(target.key))?.json).not.toBe('{"stale":true}')
    expect((await getContentRow('meta:userNote:old'))?.deleted).toBe(1)
    expect(mock.writes.length).toBeGreaterThanOrEqual(3)
  })

  it('content-store 只读分页 helper：按 key 排序 + offset + 可选含 tombstone', async () => {
    await resetDatabase()
    installNativeMock()
    await writeContentRows([
      { key: 'deck:b', kind: 'deck', json: '{"b":1}' },
      { key: 'deck:a', kind: 'deck', json: '{"a":1}' },
      { key: 'word:z', kind: 'word', json: '{"z":1}' },
    ])
    await writeContentRows([{ key: 'deck:a', kind: 'deck', json: 'null', deleted: true }])
    const first = await listContentRowsPage({ limit: 2 })
    expect(first.ok).toBe(true)
    expect(first.rows.map((row) => row.key)).toEqual(['deck:a', 'deck:b'])
    expect(first.hasMore).toBe(true)
    const second = await listContentRowsPage({ offset: 2, limit: 2 })
    expect(second.rows.map((row) => row.key)).toEqual(['word:z'])
    expect(second.hasMore).toBe(false)
    const liveOnly = await listContentRowsPage({ includeDeleted: false })
    expect(liveOnly.rows.some((row) => row.key === 'deck:a')).toBe(false)
  })

  it('S4：shadow 全程 withDataWriteLock，与其它数据写互斥（迁移排队在后）', async () => {
    await resetDatabase()
    installNativeMock()
    await createDeck({ name: 'lock', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let lockedStarted = false
    let preBackupCalled = false
    const locked = withDataWriteLock(async () => {
      lockedStarted = true
      await gate
    })
    const migration = runContentMigrationShadow({
      preBackup: async () => {
        preBackupCalled = true
        return { ok: true }
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(lockedStarted).toBe(true)
    expect(preBackupCalled).toBe(false)
    release()
    await locked
    const result = await migration
    expect(preBackupCalled).toBe(true)
    expect(result.ok).toBe(true)
  })
})
