import './test-utils'
import { describe, expect, it } from 'vitest'
import { buildContentSnapshot, createContentBaseline, createContentIncrement, getContentBackupStatus, getDb, listContentBackups, resetDatabase, restoreContentBackup, setContentBackupStorage } from '../../src/data'
import { createContentBackupStorage } from '../../src/app/utils/content-backup-storage'
class FakeBridge {
  files = new Map<string, { text: string; mtime: number }>(); seq = 0
  save(text: string, name: string) { const actual = name.endsWith('.gz') ? name : `${name}.gz`; this.files.set(actual, { text, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name: actual } }
  list() { return [...this.files.entries()].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime, path: name })) }
  read(name: string) { return this.files.get(name)?.text ?? null }
  delete(name: string) { return this.files.delete(name) }
  isAvailable() { return true } prune() { return 0 } getFlag() { return '' } setFlag() { return true } appendDiagLog() {}
}
describe('0.12 chain regression', () => {
  it('baseline→inc1→restore baseline→delete→inc2→restore inc2；checksum 非空', async () => {
    await resetDatabase()
    const bridge = new FakeBridge(); setContentBackupStorage(createContentBackupStorage(bridge as never))
    await getDb().packs.put({ id: 'p1', name: 'P', kind: 'custom', status: 'applied', itemCount: 1, appliedCount: 0, createdAt: 1, updatedAt: 1 } as never)
    await getDb().packItems.put({ id: 'i1', packId: 'p1', status: 'pending', headwordLower: 'x', createdAt: 1, updatedAt: 1 } as never)
    const b = await createContentBaseline(); expect(b.ok).toBe(true)
    const list1 = await listContentBackups()
    expect(list1.every((item) => /^[0-9a-f]{16}$/.test(item.checksum))).toBe(true)
    await getDb().meta.put({ key: 'userNote:z', value: 'one', updatedAt: 2 })
    const inc1 = await createContentIncrement(); expect(inc1.ok).toBe(true)
    const baseItem = (await listContentBackups()).find((item) => item.kind === 'baseline')!
    expect((await restoreContentBackup(baseItem.id)).ok).toBe(true)
    await getDb().packItems.delete('i1')
    const inc2 = await createContentIncrement(); expect(inc2.ok).toBe(true)
    const list2 = await listContentBackups()
    const incItems = list2.filter((item) => item.kind === 'increment').sort((a, b) => a.mtime - b.mtime)
    expect(incItems.every((item) => Boolean(item.parentChecksum))).toBe(true)
    const target = incItems[incItems.length - 1]!
    expect(target.size).toBeLessThan(10_000)
    const bfile = [...bridge.files.keys()].map((name) => ({ name })).find((f) => f.name.includes('-index'))!
    console.log('BIDX', JSON.stringify(JSON.parse(String(bridge.read(bfile.name))).manifest))
    const deleteHash = (await buildContentSnapshot({ revision: 0 })).snapshotId
    const statusAfterInc2 = await getContentBackupStatus()
    const restored = await restoreContentBackup(target.id)
    expect(restored.ok).toBe(true)
    expect(await getDb().packItems.get('i1')).toBeUndefined()
    expect((await buildContentSnapshot({ revision: 0 })).snapshotId).toBe(deleteHash)
    expect((await getContentBackupStatus()).lastSuccess).toBeTruthy()
    expect(statusAfterInc2.lastIncrement).toBeTruthy()
  })
})
