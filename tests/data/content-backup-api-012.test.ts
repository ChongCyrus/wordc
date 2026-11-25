import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createContentBaseline, createContentIncrement, createDeck, getDb, getContentBackupStatus, listContentBackups, resetDatabase, restoreContentBackup, runContentAutoBackup, setContentBackupStorage, updateSettings } from '../../src/data'
import { createContentBackupStorage } from '../../src/app/utils/content-backup-storage'
class FakeBridge {
  files = new Map<string, { text: string; mtime: number }>(); seq = 0; flags = new Map<string, string>(); diag: string[] = []
  isAvailable() { return true }
  save(text: string, name: string) { const actual = name.endsWith('.gz') ? name : `${name}.gz`; this.files.set(actual, { text, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name: actual } }
  list() { return [...this.files.entries()].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime, path: `/auto/${name}` })) }
  read(name: string) { return this.files.get(name)?.text ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag(key: string) { return this.flags.get(key) ?? '' }
  setFlag(key: string, value: string) { this.flags.set(key, value); return true }
  appendDiagLog(text: string) { this.diag.push(text) }
}
afterEach(() => setContentBackupStorage(null))
describe('0.12 content backup API', () => {
  it('baseline→increment→list→restore', async () => {
    await resetDatabase()
    await createDeck({ name: 'api', words: [{ headword: 'apiword', meanings: [{ cn: '义' }] }] })
    const bridge = new FakeBridge()
    setContentBackupStorage(createContentBackupStorage(bridge as never))
    const base = await createContentBaseline()
    expect(base.ok).toBe(true)
    await getDb().meta.put({ key: 'userNote:api', value: 'v', updatedAt: 9 })
    const inc = await createContentIncrement()
    expect(inc.ok).toBe(true)
    expect(inc.mode).toBe('increment')
    const list = await listContentBackups()
    expect(list.some((item) => item.kind === 'baseline' && item.valid)).toBe(true)
    expect(list.some((item) => item.kind === 'increment' && item.valid)).toBe(true)
    const item = list.find((entry) => entry.kind === 'baseline')!
    await getDb().words.clear()
    const restored = await restoreContentBackup(item.id)
    expect(restored.ok).toBe(true)
    expect(await getDb().words.count()).toBe(1)
    await updateSettings({ 'backup.autoContentEnabled': true })
    const status = await getContentBackupStatus()
    expect(status.enabled).toBe(true)
    expect((await runContentAutoBackup({ force: true })).ok).toBe(true)
  })
})

import { getContentBackupStatus as getStatus } from '../../src/data'
describe('content-backup-updated detail', () => {
  it('事件 detail.status 与随后 getStatus 都是新 revision', async () => {
    await resetDatabase()
    await createDeck({ name: 'evt-status', words: [{ headword: 'e', meanings: [{ cn: '义' }] }] })
    const bridge = new FakeBridge(); setContentBackupStorage(createContentBackupStorage(bridge as never))
    const events: Array<{ type: string; detail?: { revision?: number; status?: { lastBaseline?: number | null } } }> = []
    const prev = (globalThis as { window?: unknown }).window
    ;(globalThis as { window?: unknown }).window = { dispatchEvent: (event: { type: string; detail?: never }) => { events.push(event as never); return true } }
    try {
      const base = await createContentBaseline()
      expect(base.ok).toBe(true)
      const event = events.find((item) => item.type === 'momo:content-backup-updated')!
      expect(event.detail?.revision).toBe(base.revision)
      expect(event.detail?.status?.lastBaseline).toBeTruthy()
      expect((await getStatus()).lastBaseline).toBe(event.detail?.status?.lastBaseline)
    } finally {
      (globalThis as { window?: unknown }).window = prev
    }
  })
})
