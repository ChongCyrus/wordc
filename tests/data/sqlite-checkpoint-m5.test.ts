import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { restoreSqliteFactsCheckpointIfEmpty, saveSqliteFactsCheckpoint, setSqliteTransport, type AutoBackupBridge, type AutoBackupEntry } from '../../src/data'

class Bridge implements AutoBackupBridge {
  files = new Map<string, string>()
  isAvailable() { return true }
  save(text: string, name: string) { this.files.set(name, text); return { ok: true, mode: 'native' as const, name, path: `/p/${name}` } }
  list(): AutoBackupEntry[] { return [...this.files.entries()].map(([name, text], i) => ({ name, size: text.length, mtime: i, path: `/p/${name}` })) }
  read(name: string) { return this.files.get(name) ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag() { return '' }
  setFlag() { return true }
  appendDiagLog() {}
}

afterEach(() => setSqliteTransport(null))

describe('M5 sqlite checkpoint', () => {
  it('有 states→保存 latest；清空→restore counts 一致', async () => {
    let states = 1
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string } }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 3, counts: { states, plans: 0, settings: 1 }, integrityOk: true, readOnly: false }))
          else if (req.method === 'tx') { states = 1; cb?.(id, JSON.stringify({ ok: true })) }
          else if (req.payload?.table === 'states') cb?.(id, JSON.stringify({ ok: true, rows: [{ word_id: 'w1', deck_id: 'd', phase: 'review', updated_at: 1 }] }))
          else if (req.payload?.table === 'settings') cb?.(id, JSON.stringify({ ok: true, rows: [{ key: 'study.dailyGoal', value_json: '30', updated_at: 1 }] }))
          else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const bridge = new Bridge()
    expect(await saveSqliteFactsCheckpoint(bridge)).toBe(true)
    expect(bridge.files.has('sqlite-checkpoint-latest.state.json')).toBe(true)
    states = 0
    const restored = await restoreSqliteFactsCheckpointIfEmpty(bridge)
    expect(restored.ok).toBe(true)
    expect(restored.restoredStates).toBe(1)
  })
})

import { scheduleSqliteFactsCheckpoint, flushSqliteFactsCheckpoint } from '../../src/data'
describe('M5 checkpoint timing', () => {
  it('2s 自动保存；flush 立即保存', async () => {
    let seq = 0
    setSqliteTransport({
      sqliteCall(json) {
        const req = JSON.parse(json) as { id: string; method: string; payload?: { table?: string } }
        const id = `${req.id}-r${++seq}`
        setTimeout(() => {
          const cb = (globalThis as unknown as { __momoSqliteResult?: (id: string, j: string) => void }).__momoSqliteResult
          if (req.method === 'health') cb?.(id, JSON.stringify({ ok: true, userVersion: 3, counts: { states: 1, plans: 0, settings: 1 }, integrityOk: true, readOnly: false }))
          else if (req.payload?.table === 'states') cb?.(id, JSON.stringify({ ok: true, rows: [{ word_id: 'w1', deck_id: 'd', phase: 'review', updated_at: 1 }] }))
          else if (req.payload?.table === 'settings') cb?.(id, JSON.stringify({ ok: true, rows: [{ key: 'k', value_json: '1', updated_at: 1 }] }))
          else cb?.(id, JSON.stringify({ ok: true, rows: [] }))
        }, 0)
        return JSON.stringify({ requestId: id })
      },
    })
    const bridge = new Bridge()
    scheduleSqliteFactsCheckpoint(bridge, 2000)
    await new Promise((resolve) => setTimeout(resolve, 2200))
    expect(bridge.files.has('sqlite-checkpoint-latest.state.json')).toBe(true)
    bridge.files.delete('sqlite-checkpoint-latest.state.json')
    scheduleSqliteFactsCheckpoint(bridge, 5000)
    await flushSqliteFactsCheckpoint(bridge)
    expect(bridge.files.has('sqlite-checkpoint-latest.state.json')).toBe(true)
  }, 10000)
})
