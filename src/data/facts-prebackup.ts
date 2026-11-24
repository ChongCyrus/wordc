/** 0.11.0 M3/upgrade：轻量 facts 预备份（只 states/plans/settings/reviewLogs，不含 words/decks） */
import { getDb } from './db'
import type { AutoBackupBridge } from './auto-backup'

export interface FactsPreBackupResult {
  ok: boolean
  name?: string
  bytes?: number
  counts?: { states: number; plans: number; settings: number; reviewLogs: number }
  timedOut?: boolean
  error?: string
}

export async function createFactsPreBackup(
  bridge: AutoBackupBridge,
  opts: { timeoutMs?: number; now?: number; onProgress?: (phase: string, done?: number) => void } = {},
): Promise<FactsPreBackupResult> {
  const timeoutMs = Math.max(5_000, opts.timeoutMs ?? 30_000)
  const now = opts.now ?? Date.now()
  let timedOut = false
  const task = (async (): Promise<FactsPreBackupResult> => {
    const db = getDb()
    opts.onProgress?.('read-states')
    const [states, plans, settings, reviewLogs] = await Promise.all([
      db.states.toArray(),
      db.plans.toArray(),
      db.settings.toArray(),
      db.reviewLogs.toArray(),
    ])
    if (timedOut) return { ok: false, timedOut: true, error: '预备份超时' }
    const payload = {
      format: 'momo-facts-prebackup',
      formatVersion: 1,
      createdAt: now,
      counts: { states: states.length, plans: plans.length, settings: settings.length, reviewLogs: reviewLogs.length },
      states,
      plans,
      settings,
      reviewLogs,
    }
    const text = JSON.stringify(payload)
    if (!bridge.isAvailable()) return { ok: false, error: '自动备份目录不可用' }
    const name = `facts-prebackup-${new Date(now).toISOString().replace(/[:.]/g, '-')}.json`
    opts.onProgress?.('write')
    const saved = await bridge.save(text, name)
    if (!saved.ok) return { ok: false, error: saved.error ?? 'facts 预备份写入失败' }
    const readBack = bridge.read(name)
    if (!readBack || readBack.length !== text.length) return { ok: false, error: 'facts 预备份回读校验失败' }
    opts.onProgress?.('done')
    return { ok: true, name, bytes: text.length, counts: payload.counts }
  })().catch((error) => ({ ok: false, error: error instanceof Error ? error.message : String(error) }))
  const result = await Promise.race([
    task,
    new Promise<FactsPreBackupResult>((resolve) => setTimeout(() => { timedOut = true; resolve({ ok: false, timedOut: true, error: `facts 预备份超时（>${Math.round(timeoutMs / 1000)}s）` }) }, timeoutMs)),
  ])
  return result
}
