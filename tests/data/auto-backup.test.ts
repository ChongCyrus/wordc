/** 0.3.86 task-254：每日自动备份/异常标记/恢复 prune（fake bridge，不依赖原生） */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  AUTO_BACKUP_FLAG_ANOMALY,
  AUTO_BACKUP_FLAG_HAD_PROGRESS,
  AUTO_BACKUP_FLAG_LAST_DATE,
  AUTO_BACKUP_KEEP,
  AUTO_BACKUP_MAX_BYTES,
  checkProgressAnomaly,
  createDeck,
  getDb,
  getWord,
  listAutoBackups,
  resetDatabase,
  restoreAutoBackup,
  runAutoBackup,
  type AutoBackupBridge,
  type AutoBackupEntry,
} from '../../src/data'

class FakeBridge implements AutoBackupBridge {
  available = true
  flags = new Map<string, string>()
  files = new Map<string, { text: string; mtime: number }>()
  diag: string[] = []
  pruned = 0
  seq = 0
  isAvailable() { return this.available }
  save(text: string, name: string) {
    this.files.set(name, { text, mtime: ++this.seq })
    return { ok: true, mode: 'native' as const, name, path: `/auto/${name}` }
  }
  list(): AutoBackupEntry[] {
    return [...this.files.entries()].map(([name, file]) => ({ name, size: file.text.length, mtime: file.mtime, path: `/auto/${name}` }))
  }
  read(name: string) { return this.files.get(name)?.text ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune(keep: number) {
    const entries = this.list().sort((a, b) => b.mtime - a.mtime)
    let deleted = 0
    for (const entry of entries.slice(Math.max(0, keep))) {
      if (this.files.delete(entry.name)) deleted += 1
    }
    this.pruned += deleted
    return deleted
  }
  getFlag(key: string) { return this.flags.get(key) ?? '' }
  setFlag(key: string, value: string) { this.flags.set(key, value); return true }
  appendDiagLog(text: string) { this.diag.push(text) }
}

const day = (n: number) => Date.UTC(2026, 10, 1 + n, 12)

async function seedState() {
  const deck = await createDeck({ name: 'auto-backup', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
  const wordId = `${deck.id}:alpha`
  await getDb().states.put({
    wordId,
    deckId: deck.id,
    phase: 'learning',
    stability: 1,
    difficulty: 5,
    reps: 1,
    lapses: 0,
    firstSeenAt: Date.now(),
    lastReviewedAt: Date.now(),
    dueAt: Date.now() + 86_400_000,
    nextIntervalDays: 1,
    retrievability: 1,
    lastRating: 'familiar',
    sameDayCount: 1,
    sameDayDate: '2026-11-18',
    meaningStats: {},
    sameDayRequeued: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  return { deck, wordId }
}

describe('0.3.86 · auto backup', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('无进度不备份；有进度每次启动都备份（同日同名覆盖、跨天新增）；prune 7', async () => {
    const bridge = new FakeBridge()
    expect((await runAutoBackup(bridge, { now: day(0) })).mode).toBe('skipped')
    expect(bridge.files.size).toBe(0)

    await seedState()
    const started = Date.now()
    const first = await runAutoBackup(bridge, { now: day(0) })
    expect(first.mode).toBe('backed-up')
    expect(Date.now() - started).toBeLessThan(5_000) // 20MB 内轻量导出性能
    expect([...bridge.files.values()][0]!.text.length).toBeLessThan(AUTO_BACKUP_MAX_BYTES)
    expect(bridge.getFlag(AUTO_BACKUP_FLAG_HAD_PROGRESS)).toBe('1')
    expect(bridge.getFlag(AUTO_BACKUP_FLAG_LAST_DATE)).toBe('2026-11-01')
    expect(bridge.files.size).toBe(1)
    // 同日再次启动：仍执行备份，但同名覆盖 → 只有 1 份
    expect((await runAutoBackup(bridge, { now: day(0) + 1000 })).mode).toBe('backed-up')
    expect(bridge.files.size).toBe(1)
    // 连续 9 天：跨天文件新增，prune 保留最新 7
    for (let i = 1; i < 9; i += 1) await runAutoBackup(bridge, { now: day(i) })
    expect(bridge.files.size).toBe(AUTO_BACKUP_KEEP)
    expect(bridge.pruned).toBeGreaterThan(0)
    const names = listAutoBackups(bridge).map((entry) => entry.name)
    expect(names.length).toBe(AUTO_BACKUP_KEEP)
    expect(new Set(names).size).toBe(AUTO_BACKUP_KEEP) // 每份日期不同
    expect(bridge.files.has('auto-backup-2026-11-01.migration.json')).toBe(false) // 最旧已 prune
  })

  it('开关关闭（enabled=false）不备份、不写 flag', async () => {
    const bridge = new FakeBridge()
    await seedState()
    const result = await runAutoBackup(bridge, { now: day(0), enabled: false })
    expect(result.mode).toBe('skipped')
    expect(bridge.files.size).toBe(0)
    expect(bridge.getFlag(AUTO_BACKUP_FLAG_HAD_PROGRESS)).toBe('')
  })

  it('异常：DB 为空但 hadProgress flag=true → anomaly，且不写备份', async () => {
    const bridge = new FakeBridge()
    await seedState()
    await runAutoBackup(bridge, { now: day(0) })
    expect(await checkProgressAnomaly(bridge)).toBe(false)
    await resetDatabase() // DB 被清空（模拟丢库）
    const result = await runAutoBackup(bridge, { now: day(1) })
    expect(result.mode).toBe('anomaly')
    expect(result.progressAnomaly).toBe(true)
    expect(bridge.getFlag(AUTO_BACKUP_FLAG_ANOMALY)).toBe('1')
  })

  it('Web/桥不可用：不静默写，返回 unavailable', async () => {
    const bridge = new FakeBridge()
    bridge.available = false
    await seedState()
    const result = await runAutoBackup(bridge, { now: day(0) })
    expect(result.mode).toBe('unavailable')
    expect(bridge.files.size).toBe(0)
  })

  it('恢复：先备份当前→importMigration(merge)→报告；DB 清空后可恢复', async () => {
    const bridge = new FakeBridge()
    const { wordId } = await seedState()
    const backup = await runAutoBackup(bridge, { now: day(0) })
    expect(backup.mode).toBe('backed-up')
    const name = backup.name!
    await resetDatabase()
    const result = await restoreAutoBackup(bridge, name, { now: day(1) })
    expect(result.ok).toBe(true)
    expect(result.report?.counts.words).toBe(1)
    expect(result.preRestoreName).toBeTruthy()
    expect(bridge.files.has(result.preRestoreName!)).toBe(true)
    expect(await getWord(wordId)).toBeTruthy()
    expect((await getDb().states.count())).toBe(1)
  })

  it('非法/损坏备份：解析失败给明确错误，不 import/不写库', async () => {
    const bridge = new FakeBridge()
    await seedState()
    bridge.files.set('bad.json.gz', { text: 'not-json', mtime: 1 })
    const result = await restoreAutoBackup(bridge, 'bad.json.gz')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/解析失败/)
    expect(bridge.diag.some((line) => /\[restore\].*parse failed/.test(line))).toBe(true)
    expect(bridge.files.size).toBe(1) // 未做 pre-backup
  })

  it('20MB guard：超限拒绝并写 diag，不调用 save', async () => {
    const bridge = new FakeBridge()
    await seedState()
    const result = await runAutoBackup(bridge, {
      now: day(0),
      exportText: async () => 'x'.repeat(AUTO_BACKUP_MAX_BYTES + 1),
    })
    expect(result.mode).toBe('error')
    expect(result.error).toMatch(/20MB|上限/)
    expect(bridge.files.size).toBe(0)
    expect(bridge.diag.some((line) => /skipped/.test(line))).toBe(true)
  })
})
