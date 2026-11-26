import './test-utils'
import { describe, expect, it } from 'vitest'
import { resetDatabase, restoreAutoBackup, saveStateCheckpoint, type AutoBackupBridge, type AutoBackupEntry } from '../../src/data'
import { cleanupAutoBackups } from '../../src/data/auto-backup'
class PrefixBridge implements AutoBackupBridge {
  files = new Map<string, { text: string; mtime: number }>(); seq = 0
  isAvailable() { return true }
  save(text: string, name: string) { const safe = (name.startsWith('auto-backup-') ? name : `auto-backup-${name}`) + (name.endsWith('.gz') ? '' : '.gz'); this.files.set(safe, { text, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name: safe, path: safe } }
  list(): AutoBackupEntry[] { return [...this.files.entries()].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime, path: name })) }
  read(name: string) { return this.files.get(name)?.text ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag() { return '' }
  setFlag() { return true }
  appendDiagLog() {}
}
describe('task-310 A-04 pre-restore', () => {
  it('pre-restore 是完整包；自动备份恢复与回滚都用 replace（D-P0-1：回到备份点）', async () => {
    await resetDatabase()
    const bridge = new PrefixBridge()
    await bridge.save(JSON.stringify({ format: 'momo-migration', formatVersion: 1, dataVersion: 1, data: {} }), 'auto-backup-x.migration.json')
    let captured: string | undefined
    const failed = await restoreAutoBackup(bridge, 'auto-backup-x.migration.json.gz', {
      importImpl: (async (_text: string, options: { strategy?: string }) => { captured = options.strategy; return { ok: false, kind: 'migration', counts: { decks: 0, words: 0, states: 0, reviewLogs: 0, skipped: 0 }, issues: [{ level: 'error', code: 'E_TEST', message: 'fail' }], durationMs: 1 } }) as never,
    })
    expect(failed.ok).toBe(false)
    // D-P0-1：从自动备份恢复的语义是“回到备份点”，必须 replace 才能恢复 reviewLogs/settings
    expect(captured).toBe('replace')
    const pre = [...bridge.files.entries()].find(([name]) => name.includes('pre-restore'))
    expect(pre).toBeTruthy()
    const parsed = JSON.parse(pre![1].text) as { data: { reviewLogs?: unknown[]; packs?: unknown[] } }
    expect(Array.isArray(parsed.data.reviewLogs)).toBe(true)
    let rollbackStrategy: string | undefined
    const rollback = await restoreAutoBackup(bridge, pre![0], {
      skipPreBackup: true,
      importImpl: (async (_text: string, options: { strategy?: string }) => { rollbackStrategy = options.strategy; return { ok: true, kind: 'migration', counts: { decks: 0, words: 0, states: 0, reviewLogs: 1, skipped: 0 }, issues: [], durationMs: 1 } }) as never,
    })
    expect(rollback.ok).toBe(true)
    expect(rollbackStrategy).toBe('replace')
  })
})
describe('task-310 A-05 checkpoint naming', () => {
  it('原生 auto-backup- 前缀/.gz 下轮换与清理生效', async () => {
    await resetDatabase()
    const bridge = new PrefixBridge()
    for (let i = 0; i < 5; i += 1) await saveStateCheckpoint(bridge, 1000 + i)
    const checkpoints = [...bridge.files.keys()].filter((name) => name.includes('checkpoint-'))
    const latest = checkpoints.filter((name) => name.includes('checkpoint-latest'))
    expect(latest).toHaveLength(1)
    expect(checkpoints.length).toBeLessThanOrEqual(4)
    // pre-restore 不占普通配额：3 份 pre-restore + 1 份普通备份，keep=1
    bridge.files.clear()
    for (let i = 0; i < 3; i += 1) bridge.save('{"format":"momo-migration","data":{}}', `pre-restore-${i}.migration.json`)
    bridge.save('{"format":"momo-migration","data":{}}', 'auto-backup-1.migration.json')
    expect(cleanupAutoBackups(bridge, 1)).toBe(0)
    expect([...bridge.files.keys()].filter((name) => name.includes('pre-restore'))).toHaveLength(3)
  })
})
