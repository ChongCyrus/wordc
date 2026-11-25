/** 0.11.0 M4b-1：settings 写切换门禁/ SQLite tx→cache / 失败回滚 / cache dirty */
import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDeck,
  applyImportedSettings,
  enableSettingsSqliteWrite,
  getSetting,
  getRawSettingDiagnostics,
  updateDailyGoalAndResync,
  persistSettingsWriteMode,
  resetSettings,
  restoreSettingsWriteMode,
  getDb,
  getIdbCacheMeta,
  getSettingsWriteMode,
  resetDatabase,
  setSettingsCheckpointScheduler,
  setSettingsWriteMode,
  setSqliteTransport,
  updateSettings,
  type SqliteTransport,
} from '../../src/data'

type Row = { key: string; value: unknown; updated_at?: number }
function install(opts: { settings?: Row[]; failTx?: boolean; noCounts?: boolean } = {}) {
  const rows: Row[] = opts.settings ? opts.settings.map((row) => ({ ...row })) : []
  const txs: unknown[][] = []
  let seq = 0
  const transport: SqliteTransport = {
    sqliteCall(json) {
      const req = JSON.parse(json) as { id: string; method: string; ops?: unknown[]; payload?: { table?: string } }
      const id = `${req.id}-r${++seq}`
      setTimeout(() => {
        const callback = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
        if (req.method === 'health') {
          callback?.(id, JSON.stringify(opts.noCounts ? { ok: true, userVersion: 3 } : { ok: true, userVersion: 3, counts: { states: 0, plans: 0, settings: rows.length, review_logs: 0 } }))
          return
        }
        if (req.method === 'tx') {
          txs.push(req.ops ?? [])
          if (opts.failTx) { callback?.(id, JSON.stringify({ ok: false, code: 'E_IO', message: 'mock tx fail' })); return }
          for (const op of req.ops ?? []) {
            const item = op as { op: string; table: string; row?: Record<string, unknown> }
            if (item.table === 'settings' && item.row) {
              const key = String(item.row.key)
              const value = JSON.parse(String(item.row.value_json))
              const index = rows.findIndex((row) => row.key === key)
              const next = { key, value, updated_at: Number(item.row.updated_at) }
              if (index >= 0) rows[index] = next
              else rows.push(next)
            }
          }
          callback?.(id, JSON.stringify({ ok: true }))
          return
        }
        if (req.payload?.table === 'settings') {
          callback?.(id, JSON.stringify({ ok: true, rows: rows.map((row) => ({ key: row.key, value_json: JSON.stringify(row.value), updated_at: row.updated_at ?? 1 })) }))
          return
        }
        callback?.(id, JSON.stringify({ ok: true, rows: [] }))
      }, 0)
      return JSON.stringify({ requestId: id })
    },
  }
  setSqliteTransport(transport)
  return { rows, txs }
}

async function seed() {
  await resetDatabase()
  const deck = await createDeck({ name: 'm4b1', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  await setSqliteTransport(null)
  return deck
}

afterEach(() => {
  setSqliteTransport(null)
  setSettingsWriteMode('idb')
  setSettingsCheckpointScheduler(null)
})

describe('0.11.0 · M4b-1 settings write', () => {
  it('门禁通过→SQLite tx→IDB cache→checkpoint；失败回滚', async () => {
    await seed()
    const existing = (await getDb().settings.toArray()).map((row) => ({ key: row.key, value: row.value }))
    const mock = install({ settings: existing })
    // 模拟 cache meta v2 就绪
    const { writeIdbCacheMeta, getDataEpoch } = await import('../../src/data')
    await writeIdbCacheMeta({ generation: await getDataEpoch(), sqliteUserVersion: 3, dirty: false, rebuiltAt: Date.now() })
    let checkpoints = 0
    setSettingsCheckpointScheduler(() => { checkpoints += 1 })
    const enabled = await enableSettingsSqliteWrite({
      preBackup: async () => ({ ok: true }),
      expectedCounts: { states: 0, plans: 0, settings: existing.length, reviewLogs: 0 },
    })
    if (!enabled.ok) console.log('ENABLEFAIL', enabled)
    expect(enabled.ok).toBe(true)
    expect(getSettingsWriteMode()).toBe('sqlite')
    const updated = await updateSettings({ 'study.dailyGoal': 42 })
    expect(updated['study.dailyGoal']).toBe(42)
    expect(mock.txs).toHaveLength(1)
    expect(mock.txs[0]![0]).toMatchObject({ op: 'upsert', table: 'settings' })
    expect(mock.rows.some((row) => row.key === 'study.dailyGoal' && row.value === 42)).toBe(true)
    expect(checkpoints).toBe(1)
    expect((await getDb().settings.get('study.dailyGoal'))?.value).toBe(42)
    // SQLite tx 失败 → 不写 IDB
    setSqliteTransport(null)
    const fail = install({ settings: mock.rows, failTx: true })
    const cacheBefore = await getDb().settings.get('study.dailyGoal')
    await expect(updateSettings({ 'study.dailyGoal': 43 })).rejects.toThrow(/mock tx fail/)
    expect(await getDb().settings.get('study.dailyGoal')).toEqual(cacheBefore)
    expect(fail.txs.length).toBe(1)
  })

  it('备份失败/cache 未就绪拒绝切换；IDB 写模式保持', async () => {
    await seed()
    install({ settings: [] })
    const backupFail = await enableSettingsSqliteWrite({ preBackup: async () => ({ ok: false, error: 'mock' }) })
    expect(backupFail.ok).toBe(false)
    expect(getSettingsWriteMode()).toBe('idb')
    const { markIdbCacheDirty } = await import('../../src/data')
    await markIdbCacheDirty('test')
    const cacheDirty = await enableSettingsSqliteWrite({ preBackup: async () => ({ ok: true }) })
    expect(cacheDirty.ok).toBe(false)
    expect(cacheDirty.error).toMatch(/cache/)
    expect(getSettingsWriteMode()).toBe('idb')
  })

  it('重启恢复 sqlite 模式；门禁失败回 idb + diag', async () => {
    await seed()
    const { writeIdbCacheMeta, getDataEpoch } = await import('../../src/data')
    await writeIdbCacheMeta({ generation: await getDataEpoch(), sqliteUserVersion: 3, dirty: false, rebuiltAt: Date.now() })
    install({ settings: [] })
    await persistSettingsWriteMode('sqlite')
    setSettingsWriteMode('idb')
    install({ settings: [] })
    expect(await restoreSettingsWriteMode()).toBe('sqlite')
    setSettingsWriteMode('idb')
    setSqliteTransport(null)
    expect(await restoreSettingsWriteMode()).toBe('idb')
    const diag = await getDb().meta.get('settingsWrite.diag')
    expect(diag?.value).toBeTruthy()
    expect(getSettingsWriteMode()).toBe('idb')
  })

  it('缺 counts 拒绝切换', async () => {
    await seed()
    const { writeIdbCacheMeta, getDataEpoch } = await import('../../src/data')
    await writeIdbCacheMeta({ generation: await getDataEpoch(), sqliteUserVersion: 3, dirty: false, rebuiltAt: Date.now() })
    install({ settings: [], noCounts: true })
    const result = await enableSettingsSqliteWrite({ preBackup: async () => ({ ok: true }) })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/counts/)
    expect(getSettingsWriteMode()).toBe('idb')
  })

  it('sqlite 模式 reset/import 走 SQLite tx，不只写 IDB', async () => {
    const existingSettings = (await getDb().settings.toArray()).map((row) => ({ key: row.key, value: row.value }))
    const mock = install({ settings: existingSettings })
    const { writeIdbCacheMeta, getDataEpoch } = await import('../../src/data')
    await writeIdbCacheMeta({ generation: await getDataEpoch(), sqliteUserVersion: 3, dirty: false, rebuiltAt: Date.now() })
    const enabled = await enableSettingsSqliteWrite({ preBackup: async () => ({ ok: true }), expectedCounts: { states: 0, plans: 0, settings: existingSettings.length, reviewLogs: 0 } })
    expect(enabled.ok).toBe(true)
    await resetSettings()
    expect(mock.txs.some((ops) => ops.some((op) => (op as { op?: string }).op === 'delete'))).toBe(true)
    expect((await getDb().settings.count())).toBe(0)
    await applyImportedSettings([{ key: 'study.dailyGoal', value: 66, updatedAt: Date.now() }])
    expect(mock.txs.some((ops) => ops.some((op) => (op as { row?: { key?: string } }).row?.key === 'study.dailyGoal'))).toBe(true)
    expect((await getDb().settings.get('study.dailyGoal'))?.value).toBe(66)
  })

  it('每日学习量 updateDailyGoalAndResync 在 sqlite 模式真正写 settings；raw 可见', async () => {
    const existingSettings = (await getDb().settings.toArray()).map((row) => ({ key: row.key, value: row.value }))
    const mock = install({ settings: existingSettings })
    const { writeIdbCacheMeta, getDataEpoch } = await import('../../src/data')
    await writeIdbCacheMeta({ generation: await getDataEpoch(), sqliteUserVersion: 3, dirty: false, rebuiltAt: Date.now() })
    const enabled = await enableSettingsSqliteWrite({ preBackup: async () => ({ ok: true }), expectedCounts: { states: 0, plans: 0, settings: existingSettings.length, reviewLogs: 0 } })
    expect(enabled.ok).toBe(true)
    const result = await updateDailyGoalAndResync(31)
    expect(result.settings['study.dailyGoal']).toBe(31)
    expect(mock.rows.some((row) => row.key === 'study.dailyGoal' && row.value === 31)).toBe(true)
    expect(await getSetting('study.dailyGoal')).toBe(31)
    const diag = await getRawSettingDiagnostics(['study.dailyGoal'])
    expect(diag.writeMode).toBe('sqlite')
    expect(diag.items[0]?.sqlite?.valueRaw).toBe('31')
    expect(diag.items[0]?.idb?.value).toBe(31)
  })

  it('cache 写失败只标 dirty，SQLite 已提交；读回源不丢', async () => {
    await seed()
    const existingSettings = (await getDb().settings.toArray()).map((row) => ({ key: row.key, value: row.value }))
    const mock = install({ settings: existingSettings })
    const { writeIdbCacheMeta, getDataEpoch } = await import('../../src/data')
    await writeIdbCacheMeta({ generation: await getDataEpoch(), sqliteUserVersion: 3, dirty: false, rebuiltAt: Date.now() })
    const enabled = await enableSettingsSqliteWrite({ preBackup: async () => ({ ok: true }), expectedCounts: { states: 0, plans: 0, settings: existingSettings.length, reviewLogs: 0 } })
    expect(enabled.ok).toBe(true)
    const db = getDb()
    const original = db.settings.bulkPut.bind(db.settings)
    db.settings.bulkPut = (async () => { throw new Error('mock cache fail') }) as never
    try {
      const updated = await updateSettings({ 'study.dailyGoal': 55 })
      expect(updated['study.dailyGoal']).toBe(55)
      expect(await getSetting('study.dailyGoal')).toBe(55)
      expect((await getIdbCacheMeta())?.dirty).toBe(true)
      expect(mock.rows.some((row) => row.key === 'study.dailyGoal' && row.value === 55)).toBe(true)
    } finally {
      db.settings.bulkPut = original
    }
  })
})
