import './test-utils'
import { describe, expect, it } from 'vitest'
import { buildContentBaselineFile, buildContentIncrement, buildContentSnapshot, createDeck, exportContentEntities, getDb, resetDatabase, restoreContentBaseline, saveContentBaselineFile, saveContentIncrementFile } from '../../src/data'
import { createContentBackupStorage } from '../../src/app/utils/content-backup-storage'
class FakeBridge {
  files = new Map<string, { text: string; mtime: number }>(); seq = 0; flags = new Map<string, string>(); diag: string[] = []
  isAvailable() { return true }
  save(text: string, name: string) { const actual = `${name}.gz`; this.files.set(actual, { text, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name: actual } }
  list() { return [...this.files.entries()].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime, path: `/auto/${name}` })) }
  read(name: string) { return this.files.get(name)?.text ?? null }
  delete(name: string) { return this.files.delete(name) }
  prune() { return 0 }
  getFlag(key: string) { return this.flags.get(key) ?? '' }
  setFlag(key: string, value: string) { this.flags.set(key, value); return true }
  appendDiagLog(text: string) { this.diag.push(text) }
}
describe('0.12 A real storage adapter', () => {
  it('保存→list→read→基线恢复', async () => {
    await resetDatabase()
    await createDeck({ name: 'store', words: [{ headword: 'stored', meanings: [{ cn: '义' }] }] })
    const snap = await buildContentSnapshot({ revision: 1 })
    const file = await buildContentBaselineFile(snap)
    const bridge = new FakeBridge() as never
    const storage = createContentBackupStorage(bridge)
    const saved = await saveContentBaselineFile(storage, file)
    expect(saved.ok).toBe(true)
    const listed = storage.list()
    expect(listed.length).toBe(1)
    expect(listed[0]!.name.startsWith('content-baseline-')).toBe(true)
    const text = storage.read(listed[0]!.name)
    expect(text).toBeTruthy()
    expect(JSON.parse(String(text)).format).toBe('momo-content-baseline')
    await getDb().words.clear()
    const restored = await restoreContentBaseline(JSON.parse(String(text)))
    expect(restored.ok).toBe(true)
    expect(await getDb().words.count()).toBe(1)
    // 增量保存
    await getDb().meta.put({ key: 'userNote:s', value: 'n', updatedAt: 5 })
    const current = await buildContentSnapshot({ revision: 2 })
    const pkg = buildContentIncrement(snap, current, { entities: (await exportContentEntities(current.entries)).map(({ type, key, data }) => ({ type, key, data })) })
    if ('format' in pkg) {
      const inc = await saveContentIncrementFile(storage, pkg)
      expect(inc.ok).toBe(true)
      expect(storage.list().some((entry) => entry.name.startsWith('content-increment-'))).toBe(true)
    }
  })
})

import { restoreContentIncrementChain, getContentChainState, markContentChainFailure } from '../../src/data'
import { pruneContentBackups } from '../../src/app/utils/content-backup-storage'
describe('0.12 A prune/failure', () => {
  it('prune 保留1基线+6增量，不动 migration', async () => {
    const bridge = new FakeBridge()
    for (let i = 1; i <= 3; i += 1) bridge.save('{}', `content-baseline-${i}.json`)
    for (let i = 1; i <= 8; i += 1) bridge.save('{}', `content-increment-${i}.json`)
    bridge.save('{}', 'auto-backup-2026.migration.json')
    const storage = createContentBackupStorage(bridge as never)
    const removed = pruneContentBackups(storage)
    expect(removed).toBe(4)
    const names = storage.list().map((entry) => entry.name)
    expect(names.filter((name) => name.includes('baseline')).length).toBe(1)
    expect(names.filter((name) => name.includes('increment')).length).toBe(6)
    expect(bridge.files.has('auto-backup-2026.migration.json.gz')).toBe(true)
  })
  it('链文件读取后增量恢复；连续失败3次 needsFull', async () => {
    await resetDatabase()
    await createDeck({ name: 'chain', words: [{ headword: 'c1', meanings: [{ cn: '一' }] }] })
    const base = await buildContentSnapshot({ revision: 1 })
    const baseFile = await buildContentBaselineFile(base)
    const bridge = new FakeBridge(); const storage = createContentBackupStorage(bridge as never)
    await saveContentBaselineFile(storage, baseFile)
    await getDb().meta.put({ key: 'userNote:c', value: 'n', updatedAt: 6 })
    const current = await buildContentSnapshot({ revision: 2 })
    const pkg = buildContentIncrement(base, current, { entities: (await exportContentEntities(current.entries)).map(({ type, key, data }) => ({ type, key, data })) })
    expect('format' in pkg).toBe(true); if (!('format' in pkg)) return
    await saveContentIncrementFile(storage, pkg)
    const baseText = storage.read(storage.list().find((entry) => entry.name.includes('baseline'))!.name)
    const incText = storage.read(storage.list().find((entry) => entry.name.includes('increment'))!.name)
    expect(baseText && incText).toBeTruthy()
    const restored = await restoreContentIncrementChain(JSON.parse(String(baseText)), [JSON.parse(String(incText))])
    expect(restored.ok).toBe(true)
    expect((await getDb().meta.get('userNote:c'))?.value).toBe('n')
    await markContentChainFailure('a'); await markContentChainFailure('b'); await markContentChainFailure('c')
    expect((await getContentChainState())?.needsFullSnapshot).toBe(true)
  })
})
