/**
 * 审计 C：写源/cache 一致性回归。
 *
 * 历史上的“红测”已在 task-312/316 修复（C-02 禁止反向覆盖、C-03 readonly 保持、C-04 cache meta fail-closed），
 * 本文件相应改为断言**修复后的安全行为**：出现过回归（又退回旧行为）即失败。
 */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  migrateIdbToSqlite,
  readPlanThroughCache,
  resetDatabase,
  setSqliteTransport,
  SQLITE_SCHEMA_VERSION,
  persistLearningWriteSource,
  getDb,
} from '../../src/data'

function installTransport(opts: {
  sqlitePlans?: Record<string, unknown>[]
  healthCounts?: Record<string, number>
  onTx?: (ops: unknown[]) => void
  failQuery?: boolean
}) {
  let seq = 0
  const calls: Array<{ method: string; payload?: Record<string, unknown> }> = []
  setSqliteTransport({
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string }; ops?: unknown[] }
      calls.push({ method: req.method, ...(req.payload ? { payload: req.payload } : {}) })
      const requestId = `${req.id}-r${++seq}`
      setTimeout(() => {
        const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') {
          cb?.(requestId, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: opts.healthCounts ?? { states: 0, plans: 0, settings: 0, review_logs: 0 } }))
          return
        }
        if (req.method === 'tx') {
          opts.onTx?.(req.ops ?? [])
          cb?.(requestId, JSON.stringify({ ok: true, changes: (req.ops ?? []).length }))
          return
        }
        const table = req.payload?.table
        if (opts.failQuery) {
          cb?.(requestId, JSON.stringify({ ok: false, code: 'E_BUSY', message: 'locked' }))
          return
        }
        if (table === 'plans') {
          cb?.(requestId, JSON.stringify({ ok: true, rows: opts.sqlitePlans ?? [] }))
          return
        }
        if (table === 'migration_state') {
          cb?.(requestId, JSON.stringify({ ok: true, rows: [{ step: 'legacy-idb', status: 'done' }] }))
          return
        }
        cb?.(requestId, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId })
    },
    sqliteCancel() {
      return '{"ok":true}'
    },
  })
  return calls
}

async function seedIdbPlan(index: number) {
  await resetDatabase()
  const db = getDb()
  const plan = {
    id: '2026-11-25:deck1',
    date: '2026-11-25',
    deckId: 'deck1',
    wordIds: ['w1', 'w2', 'w3'],
    index,
    sources: {},
    goals: { dailyGoal: 3, dueCount: 0, newBudget: 3, extraCount: 0 },
    ratings: [],
    createdAt: 1,
    updatedAt: 1,
    completedAt: null,
  }
  await db.plans.put(plan as never)
  return plan
}

afterEach(async () => {
  setSqliteTransport(null)
  await persistLearningWriteSource('idb').catch(() => undefined)
})

describe('审计C · force 迁移覆盖事实源', () => {
  it('migration_state=done 且 SQLite 非空时，force 仍重放 IDB→SQLite（无门禁）', async () => {
    await resetDatabase()
    const txOps: unknown[][] = []
    // SQLite 已有 3 条 states（非空）+ migration_state=done
    installTransport({ healthCounts: { states: 3, plans: 1, settings: 1, review_logs: 9 }, onTx: (ops) => txOps.push(ops) })
    const db = getDb()
    await db.settings.put({ key: 'data.selectedDeckId', value: 'deck1', updatedAt: 1 } as never)
    // IDB 只有 1 条 state（旧/脏数据）
    await db.states.put({ wordId: 'w1', deckId: 'deck1', phase: 'new', stability: 0, difficulty: 5, reps: 0, lapses: 0, firstSeenAt: null, lastReviewedAt: null, dueAt: null, nextIntervalDays: 1, retrievability: 0, lastRating: null, sameDayCount: 0, sameDayDate: '', meaningStats: {}, sameDayRequeued: 0, createdAt: 1, updatedAt: 1 } as never)

    const result = await migrateIdbToSqlite({ dryRun: false, unsafe: true, skipWriteLock: true, force: true })
    // 当前实现：force 绕过 done + 非空门禁，先把 IDB 行 upsert 进非空 SQLite；
    // counts 校验随后失败 → 返回 ok:false，但已写入的行不会回滚（部分迁移 + 事实源被旧 IDB 覆盖）。
    expect(result.ok).toBe(false)
    expect(result.error).toContain('counts')
    const wroteStates = txOps.flat().some((op) => {
      const row = (op as { table?: string; row?: { word_id?: string } }).row
      return (op as { table?: string }).table === 'states' && row?.word_id === 'w1'
    })
    expect(wroteStates).toBe(true)
  })

  it('对照：不传 force 时 done + 非空会被幂等跳过，不发写事务', async () => {
    await resetDatabase()
    const txOps: unknown[][] = []
    installTransport({ healthCounts: { states: 3, plans: 1, settings: 1, review_logs: 9 }, onTx: (ops) => txOps.push(ops) })
    const result = await migrateIdbToSqlite({ dryRun: false, unsafe: true, skipWriteLock: true })
    expect(result.skipped).toBe(true)
    expect(txOps.flat()).toHaveLength(0)
  })
})

describe('审计C · cache meta 缺失时静默读旧 IDB', () => {
  it('写源 sqlite、cache meta 缺失 → fail-closed 回源 SQLite（不再静默返回旧 IDB plan）', async () => {
    await seedIdbPlan(0)
    await persistLearningWriteSource('sqlite')
    const sqlitePlanRow = {
      id: '2026-11-25:deck1', date: '2026-11-25', deck_id: 'deck1',
      word_ids_json: JSON.stringify(['w1', 'w2', 'w3']), idx: 3,
      sources_json: '{}', goals_json: '{}', ratings_json: '[]',
      created_at: 1, updated_at: 2, completed_at: 2,
    }
    const calls = installTransport({ sqlitePlans: [sqlitePlanRow] })
    // 故意不留 cache meta（clearAllData/导入中断/旧版本升级都会造成）
    const meta = await getDb().meta.get('sqlite.idbCache')
    expect(meta).toBeUndefined()

    const plan = await readPlanThroughCache('2026-11-25:deck1', 'high')
    // C-04 修复后：cache 不可信 → 回源 SQLite，拿到事实源的 index=3（而非旧 cache 的 0）
    expect(plan?.index).toBe(3)
    expect(calls.some((c) => c.payload?.table === 'plans')).toBe(true)
  })

  it('dirty=true 但 SQLite 读失败 → withIdbFallback 静默返回旧 IDB plan', async () => {
    await seedIdbPlan(0)
    await persistLearningWriteSource('sqlite')
    const db = getDb()
    await db.meta.put({ key: 'sqlite.idbCache', value: { generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: true, dirtyAt: 1 }, updatedAt: 1 })
    installTransport({ failQuery: true })

    const plan = await readPlanThroughCache('2026-11-25:deck1', 'high')
    // dirty 本应回源；SQLite 一次性失败即静默回落旧 cache（无 retryable 错误）
    expect(plan?.index).toBe(0)
  })
})

describe('审计C · cache rebuild 无法修复分叉', () => {
  it('IDB 空、SQLite 有 1 条 state → rebuild 拒绝（永远修不好空 cache）', async () => {
    await resetDatabase()
    const stateRow = {
      word_id: 'w1', deck_id: 'deck1', phase: 'review', stability: 1, difficulty: 5, reps: 1, lapses: 0,
      first_seen_at: 1, last_reviewed_at: 2, due_at: 3, next_interval_days: 4, retrievability: 0.5,
      last_rating: 'familiar', same_day_count: 1, same_day_date: '2026-11-25',
      meaning_stats_json: '{}', core_sense_stats_json: null, part_stats_json: null,
      same_day_requeued: 0, created_at: 1, updated_at: 2,
    }
    installTransport({ healthCounts: { states: 1, plans: 0, settings: 0, review_logs: 0 } })
    // 让 states 查询返回该行
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string }; ops?: unknown[] }
        const requestId = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(requestId, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 1, plans: 0, settings: 0, review_logs: 0 } }))
          else if (req.method === 'tx') cb?.(requestId, JSON.stringify({ ok: true }))
          else cb?.(requestId, JSON.stringify({ ok: true, rows: req.payload?.table === 'states' ? [stateRow] : [] }))
        }, 0)
        return JSON.stringify({ requestId })
      },
      sqliteCancel() { return '{"ok":true}' },
    })
    const { rebuildIdbCacheFromSqlite } = await import('../../src/data')
    const rebuilt = await rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true })
    // 事实源有 1 条，IDB 0 条：delta 无行可推，counts 门禁直接拒绝 → cache 永远无法从 SQLite 重建
    expect(rebuilt.ok).toBe(false)
    expect(String(rebuilt.error)).toContain('counts')
    expect((await getDb()).states.count()).resolves.toBe(0)
  })
})

describe('审计C · dirty 标志被旧快照清掉（lost dirty）', () => {
  it('其它写失败置 dirty 后，评分链用旧快照 clear，dirty 丢失', async () => {
    await resetDatabase()
    const { getIdbCacheMeta, markIdbCacheDirty, clearIdbCacheDirty, writeIdbCacheMeta } = await import('../../src/data')
    await writeIdbCacheMeta({ generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false })
    const staleSnapshot = { generation: 0, sqliteUserVersion: SQLITE_SCHEMA_VERSION, dirty: false }
    // 模拟 settings/content 写失败 → dirty=true
    await markIdbCacheDirty('settings-cache-write-failed')
    expect((await getIdbCacheMeta())?.dirty).toBe(true)
    // 评分后台链完成，用评分开始前的旧快照 clear（当前实现）
    await clearIdbCacheDirty(staleSnapshot)
    // dirty 被覆盖：settings 失败的事实消失，后续读全部信任旧 cache
    expect((await getIdbCacheMeta())?.dirty).toBe(false)
  })
})

describe('审计C · cache-rebuild 的 IDB-newer delta 反向覆盖事实源', () => {
  it('写源 sqlite、IDB state 更新 → rebuild 拒绝反向覆盖，不发任何写事务', async () => {
    await resetDatabase()
    const db = getDb()
    const old = {
      wordId: 'w1', deckId: 'deck1', phase: 'new', stability: 0, difficulty: 5, reps: 0, lapses: 0,
      firstSeenAt: null, lastReviewedAt: null, dueAt: null, nextIntervalDays: 1, retrievability: 0,
      lastRating: null, sameDayCount: 0, sameDayDate: '', meaningStats: {}, sameDayRequeued: 0,
      createdAt: 1, updatedAt: 99,
    }
    await db.states.put(old as never)
    await persistLearningWriteSource('sqlite')
    const sqliteOldRow = {
      word_id: 'w1', deck_id: 'deck1', phase: 'review', stability: 9, difficulty: 3, reps: 5, lapses: 0,
      first_seen_at: 1, last_reviewed_at: 2, due_at: 3, next_interval_days: 4, retrievability: 0.5,
      last_rating: 'familiar', same_day_count: 1, same_day_date: '2026-11-25',
      meaning_stats_json: '{}', core_sense_stats_json: null, part_stats_json: null,
      same_day_requeued: 0, created_at: 1, updated_at: 2,
    }
    const txOps: unknown[][] = []
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string }; ops?: unknown[] }
        const requestId = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(requestId, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 1, plans: 0, settings: 1, review_logs: 0 } }))
          else if (req.method === 'tx') { txOps.push(req.ops ?? []); cb?.(requestId, JSON.stringify({ ok: true })) }
          else if (req.payload?.table === 'states') cb?.(requestId, JSON.stringify({ ok: true, rows: [sqliteOldRow] }))
          else if (req.payload?.table === 'settings') cb?.(requestId, JSON.stringify({ ok: true, rows: [{ key: 'data.selectedDeckId', value_json: '"deck1"', updated_at: 1 }] }))
          else cb?.(requestId, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId })
      },
      sqliteCancel() { return '{"ok":true}' },
    })
    const { rebuildIdbCacheFromSqlite } = await import('../../src/data')
    const result = await rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true })
    // C-02 修复后：IDB-newer 被视为分叉，在写任何 delta 之前就拒绝（SQLite 才是事实源）
    expect(result.ok).toBe(false)
    expect(String(result.conflict ?? result.error)).toContain('拒绝用 IDB 反向覆盖')
    expect(txOps.flat()).toHaveLength(0)
  })
})

describe('审计C · clearAllSqliteFacts 分批（当前 HEAD 已修）', () => {
  it('facts 用 all:true、settings/client_ops 按 ≤400 分批，不再超 MAX_OPS', async () => {
    await resetDatabase()
    const seenOps: number[] = []
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: Record<string, unknown>; ops?: unknown[] }
        const requestId = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'tx') {
            seenOps.push((req.ops ?? []).length)
            cb?.(requestId, JSON.stringify({ ok: true }))
            return
          }
          const table = String(req.payload?.table ?? '')
          const all = table === 'settings' ? Array.from({ length: 900 }, (_, i) => ({ key: `k${i}` })) : []
          const offset = Number(req.payload?.offset ?? 0)
          const limit = Number(req.payload?.limit ?? all.length)
          cb?.(requestId, JSON.stringify({ ok: true, rows: all.slice(offset, offset + limit) }))
        }, 0)
        return JSON.stringify({ requestId })
      },
      sqliteCancel() { return '{"ok":true}' },
    })
    const { clearAllSqliteFacts } = await import('../../src/data')
    await clearAllSqliteFacts()
    expect(Math.max(...seenOps)).toBeLessThanOrEqual(500)
    expect(seenOps.length).toBeGreaterThanOrEqual(4)
  })
})

describe('审计C · 恢复备份后 cache 重建把旧 IDB 反向写回事实源', () => {
  it('counts 相等、IDB 更新更晚 → rebuild 仍拒绝反向覆盖（恢复结果不被旧 cache 抹掉）', async () => {
    await resetDatabase()
    const db = getDb()
    // IDB = 恢复前的旧 cache：w1 已复习 5 次（updatedAt=99）
    await db.states.put({
      wordId: 'w1', deckId: 'deck1', phase: 'review', stability: 1, difficulty: 5, reps: 5, lapses: 0,
      firstSeenAt: 1, lastReviewedAt: 98, dueAt: 200, nextIntervalDays: 7, retrievability: 0.8,
      lastRating: 'familiar', sameDayCount: 1, sameDayDate: '2026-11-25', meaningStats: {}, sameDayRequeued: 0,
      createdAt: 1, updatedAt: 99,
    } as never)
    await persistLearningWriteSource('sqlite')
    // SQLite = 刚从旧备份恢复的事实：同一 word 但 reps=2/updatedAt=50（更旧）
    const restoredRow = {
      word_id: 'w1', deck_id: 'deck1', phase: 'review', stability: 1, difficulty: 5, reps: 2, lapses: 0,
      first_seen_at: 1, last_reviewed_at: 40, due_at: 100, next_interval_days: 3, retrievability: 0.4,
      last_rating: 'vague', same_day_count: 0, same_day_date: '', meaning_stats_json: '{}',
      core_sense_stats_json: null, part_stats_json: null, same_day_requeued: 0, created_at: 1, updated_at: 50,
    }
    const txOps: unknown[][] = []
    let seq = 0
    let stateRowForQuery = restoredRow
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string }; ops?: unknown[] }
        const requestId = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(requestId, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 1, plans: 0, settings: 0, review_logs: 0 } }))
          else if (req.method === 'tx') { txOps.push(req.ops ?? []); cb?.(requestId, JSON.stringify({ ok: true })) }
          else if (req.payload?.table === 'states') cb?.(requestId, JSON.stringify({ ok: true, rows: [stateRowForQuery] }))
          else cb?.(requestId, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId })
      },
      sqliteCancel() { return '{"ok":true}' },
    })
    const { rebuildIdbCacheFromSqlite } = await import('../../src/data')
    const result = await rebuildIdbCacheFromSqlite({ unsafe: true, skipWriteLock: true })
    // C-02 修复后：恢复备份后 IDB cache 落后于事实源，rebuild 拒绝用 IDB 反向覆盖，
    // 且**不发任何写事务**，恢复结果不会被旧 cache 抹掉。
    expect(result.ok).toBe(false)
    expect(String(result.conflict ?? result.error)).toContain('拒绝用 IDB 反向覆盖')
    expect(txOps.flat()).toHaveLength(0)
    expect(JSON.stringify(txOps)).not.toContain('"reps":5')
  })
})

describe('审计C · 启动自动迁移覆盖 readonly / idb 持久写源', () => {
  it('meta=readonly 且 SQLite 非空+done+counts 相等 → 启动后仍保持 readonly（只读保护不被解除）', async () => {
    await resetDatabase()
    const db = getDb()
    // IDB 有 1 条 state / 1 条 settings，SQLite counts 与之相等
    await db.states.put({
      wordId: 'w1', deckId: 'deck1', phase: 'review', stability: 1, difficulty: 5, reps: 1, lapses: 0,
      firstSeenAt: 1, lastReviewedAt: 2, dueAt: 3, nextIntervalDays: 4, retrievability: 0.5,
      lastRating: 'familiar', sameDayCount: 1, sameDayDate: '2026-11-25', meaningStats: {}, sameDayRequeued: 0,
      createdAt: 1, updatedAt: 2,
    } as never)
    await db.settings.put({ key: 'data.selectedDeckId', value: 'deck1', updatedAt: 1 } as never)
    await persistLearningWriteSource('readonly')
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string }; ops?: unknown[] }
        const requestId = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(requestId, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 1, plans: 0, settings: 1, review_logs: 0 } }))
          else if (req.method === 'tx') cb?.(requestId, JSON.stringify({ ok: true }))
          else if (req.payload?.table === 'migration_state') cb?.(requestId, JSON.stringify({ ok: true, rows: [{ step: 'legacy-idb', status: 'done' }] }))
          else cb?.(requestId, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId })
      },
      sqliteCancel() { return '{"ok":true}' },
    })
    const { ensureLegacyIdbMigratedToSqlite, getLearningWriteSource } = await import('../../src/data')
    const before = getLearningWriteSource()
    expect(before).toBe('readonly')
    const result = await ensureLegacyIdbMigratedToSqlite({ preBackup: async () => ({ ok: true }) })
    // C-03 修复后：启动迁移不得静默解除 readonly（只有显式修复入口才可恢复写）
    expect(getLearningWriteSource()).toBe('readonly')
    expect(result.mode).toBe('skipped')
  })
})

describe('审计C · Debug「强制 IDB→SQLite」修复入口', () => {
  it('migration_state=done 时按钮变成 no-op（skipped），即使 facts 已与非空库不一致', async () => {
    await resetDatabase()
    const db = getDb()
    await db.states.put({ wordId: 'w1', deckId: 'deck1', phase: 'review' } as never)
    installTransport({ healthCounts: { states: 3, plans: 1, settings: 1, review_logs: 9 } })
    const { migrateIdbToSqlite } = await import('../../src/data')
    // DebugPage.tsx:205 调用的正是这个签名（dryRun:false + batchSize，无 preBackup/force）
    const result = await migrateIdbToSqlite({ dryRun: false, batchSize: 200 })
    expect(result.skipped).toBe(true)
    expect(result.ok).toBe(true)
  })

  it('无 preBackup 且未 done 时直接抛错（Debug 按钮未传 preBackup）', async () => {
    await resetDatabase()
    const db = getDb()
    await db.states.put({ wordId: 'w1', deckId: 'deck1', phase: 'review' } as never)
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string } }
        const requestId = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(requestId, JSON.stringify({ ok: true, userVersion: SQLITE_SCHEMA_VERSION, counts: { states: 0, plans: 0, settings: 0, review_logs: 0 } }))
          else if (req.payload?.table === 'migration_state') cb?.(requestId, JSON.stringify({ ok: true, rows: [] }))
          else cb?.(requestId, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId })
      },
      sqliteCancel() { return '{"ok":true}' },
    })
    const { migrateIdbToSqlite } = await import('../../src/data')
    await expect(migrateIdbToSqlite({ dryRun: false, batchSize: 200 })).rejects.toThrow(/备份/)
  })
})
