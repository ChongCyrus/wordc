import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { buildContentBaselineFile, buildContentIncrement, buildContentSnapshot, exportContentEntities, getDb, resetDatabase, restoreContentBackup, saveContentBaselineFile, saveContentIncrementFile, setContentBackupStorage } from '../../src/data'
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
async function entitiesOf(snapshot: Awaited<ReturnType<typeof buildContentSnapshot>>) {
  return (await exportContentEntities(snapshot.entries)).map(({ type, key, data }) => ({ type, key, data }))
}
afterEach(() => setContentBackupStorage(null))
describe('0.12 restore increment chain', () => {
  it('baseline+inc1+inc2 恢复；缺中间层/坏 checksum 失败旧库不变', async () => {
    await resetDatabase()
    await getDb().meta.put({ key: 'userNote:n', value: 'base', updatedAt: 1 })
    const bridge = new FakeBridge(); const storage = createContentBackupStorage(bridge as never); setContentBackupStorage(storage)
    const snap1 = await buildContentSnapshot({ revision: 1 })
    const base = await buildContentBaselineFile(snap1)
    await saveContentBaselineFile(storage, base)
    await getDb().meta.put({ key: 'userNote:a', value: 'A', updatedAt: 2 })
    const snap2 = await buildContentSnapshot({ revision: 2 })
    const inc1 = buildContentIncrement(base.manifest, snap2, { entities: await entitiesOf(snap2) })
    if (!('format' in inc1)) throw new Error('expected inc1'); await saveContentIncrementFile(storage, inc1)
    await getDb().meta.put({ key: 'userNote:b', value: 'B', updatedAt: 3 })
    const snap3 = await buildContentSnapshot({ revision: 3 })
    const pseudoBase = { ...base.manifest, snapshotId: inc1.snapshotId, revision: inc1.newRevision }
    const inc2 = buildContentIncrement(pseudoBase, snap3, { entities: await entitiesOf(snap3) })
    if (!('format' in inc2)) throw new Error('expected inc2'); await saveContentIncrementFile(storage, inc2)
    // 缺中间层
    const inc1File = storage.list().find((f) => f.name.includes('content-increment-2'))!
    const inc2File = storage.list().find((f) => f.name.includes('content-increment-3'))!
    storage.delete(inc1File.name)
    const missing = await restoreContentBackup(inc2File.name)
    expect(missing.ok).toBe(false)
    // 恢复 inc1 文件后成功
    await saveContentIncrementFile(storage, inc1)
    await getDb().meta.delete('userNote:a'); await getDb().meta.delete('userNote:b')
    const restored = await restoreContentBackup(storage.list().find((f) => f.name.includes('content-increment-3'))!.name)
    expect(restored.ok).toBe(true)
    expect((await getDb().meta.get('userNote:a'))?.value).toBe('A')
    expect((await getDb().meta.get('userNote:b'))?.value).toBe('B')
    // 坏 checksum 新文件 → 失败旧库不变
    const bad = { ...inc2, checksum: 'fnv1a64:bad' }
    await saveContentIncrementFile(storage, bad)
    const badFile = storage.list().find((f) => f.name.includes('content-increment-3'))!
    const failed = await restoreContentBackup(badFile.name)
    expect(failed.ok).toBe(false)
    expect((await getDb().meta.get('userNote:a'))?.value).toBe('A')
  })
  it('tombstone 删除内容', async () => {
    await resetDatabase()
    await getDb().meta.put({ key: 'userNote:gone', value: 'x', updatedAt: 1 })
    const bridge = new FakeBridge(); const storage = createContentBackupStorage(bridge as never); setContentBackupStorage(storage)
    const snap1 = await buildContentSnapshot({ revision: 1 })
    const base = await buildContentBaselineFile(snap1); await saveContentBaselineFile(storage, base)
    await getDb().meta.delete('userNote:gone')
    const snap2 = await buildContentSnapshot({ revision: 2 })
    const inc = buildContentIncrement(base.manifest, snap2, { entities: await entitiesOf(snap2) })
    if (!('format' in inc)) throw new Error('expected inc'); await saveContentIncrementFile(storage, inc)
    const restored = await restoreContentBackup(storage.list().find((f) => f.name.includes('content-increment'))!.name)
    expect(restored.ok).toBe(true)
    expect(await getDb().meta.get('userNote:gone')).toBeUndefined()
  })
})
