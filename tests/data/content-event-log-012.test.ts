import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { buildContentSnapshot, createContentBaseline, createContentIncrement, getContentEventLogState, getDb, markContentEventLogDirty, recordContentOp, resetContentEventLog, resetDatabase, setContentBackupStorage, updateSettings } from '../../src/data'
import { createContentBackupStorage } from '../../src/app/utils/content-backup-storage'
class FakeBridge {
  files = new Map<string, { text: string; mtime: number }>(); seq = 0
  save(text: string, name: string) { const actual = name.endsWith('.gz') ? name : `${name}.gz`; this.files.set(actual, { text, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name: actual } }
  list() { return [...this.files.entries()].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime, path: name })) }
  read(name: string) { return this.files.get(name)?.text ?? null }
  delete(name: string) { return this.files.delete(name) }
  isAvailable() { return true } prune() { return 0 } getFlag() { return '' } setFlag() { return false } appendDiagLog() {}
}
afterEach(() => setContentBackupStorage(null))
describe('0.13 content event log', () => {
  it('L1 log source；L2 dirty→diff；L6 disabled→diff 不写 log', async () => {
    await resetDatabase()
    const bridge = new FakeBridge(); setContentBackupStorage(createContentBackupStorage(bridge as never))
    await updateSettings({ 'backup.contentEventLogEnabled': true })
    expect((await createContentBaseline()).ok).toBe(true)
    const before = await buildContentSnapshot({ revision: 1 })
    await getDb().meta.put({ key: 'userNote:l', value: 'x', updatedAt: 5 })
    await recordContentOp({ type: 'meta', key: 'userNote:l', op: 'upsert' })
    const l1 = await createContentIncrement()
    expect(l1.ok).toBe(true)
    const logFile = [...bridge.files.entries()].find(([name]) => name.includes('content-increment'))!
    expect(JSON.parse(logFile[1].text).source).toBe('log')
    await getDb().meta.put({ key: 'userNote:l', value: 'y', updatedAt: 6 })
    await markContentEventLogDirty('gap')
    const l2 = await createContentIncrement()
    expect(l2.ok).toBe(true)
    expect([...bridge.files.values()].some((f) => f.text.includes('"source":"diff"'))).toBe(true)
    await resetContentEventLog()
    await updateSettings({ 'backup.contentEventLogEnabled': false })
    const logBefore = await getContentEventLogState()
    await getDb().meta.put({ key: 'userNote:l', value: 'z', updatedAt: 7 })
    const l6 = await createContentIncrement()
    expect(l6.ok).toBe(true)
    expect((await getContentEventLogState()).lastSeq).toBe(logBefore.lastSeq)
    expect(before.snapshotId).not.toBe((await buildContentSnapshot()).snapshotId)
  })
})

import { buildContentBaselineFile, buildContentIncrement, exportContentEntities, restoreContentIncrementChain } from '../../src/data'
describe('L3 bad checksum/full-required', () => {
  it('坏 checksum 增量恢复失败且旧库不变；无 baseline 时 full-required', async () => {
    await resetDatabase()
    const snap1 = await buildContentSnapshot({ revision: 1 })
    const base = await buildContentBaselineFile(snap1)
    await getDb().meta.put({ key: 'userNote:bad', value: 'v', updatedAt: 2 })
    const snap2 = await buildContentSnapshot({ revision: 2 })
    const pkg = buildContentIncrement(base.manifest, snap2, { entities: (await exportContentEntities(snap2.entries)).map(({ type, key, data }) => ({ type, key, data })) })
    expect('format' in pkg).toBe(true); if (!('format' in pkg)) return
    const bad = { ...pkg, checksum: 'fnv1a64:bad' }
    const before = await getDb().meta.get('userNote:bad')
    const result = await restoreContentIncrementChain(base, [bad])
    expect(result.ok).toBe(false)
    expect((await getDb().meta.get('userNote:bad'))?.value).toBe(before?.value)
    // 无基线时 createContentIncrement 返回 full-required
    const bridge = new FakeBridge(); setContentBackupStorage(createContentBackupStorage(bridge as never))
    const inc = await createContentIncrement()
    expect(inc.mode).toBe('full-required')
  })
})
