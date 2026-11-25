import './test-utils'
import { describe, expect, it } from 'vitest'
import { buildContentIncrement, buildContentSnapshot, diffContentEntries, resetDatabase, createDeck, getDb, validateContentIncrement, SETTINGS_DEFAULTS } from '../../src/data'
describe('0.12 content snapshot', () => {
  it('diff 新增/修改/删除 tombstone', () => {
    const base = [
      { type: 'words', key: 'a', hash: 'h1', updatedAt: 1 },
      { type: 'words', key: 'b', hash: 'h2', updatedAt: 1 },
      { type: 'decks', key: 'd', hash: 'h3', updatedAt: 1 },
    ]
    const current = [
      { type: 'words', key: 'a', hash: 'h1', updatedAt: 1 },
      { type: 'words', key: 'b', hash: 'h2-new', updatedAt: 2 },
      { type: 'words', key: 'c', hash: 'h4', updatedAt: 1 },
    ]
    const delta = diffContentEntries(base, current)
    expect(delta.entities.map((entry) => entry.key).sort()).toEqual(['b', 'c'])
    expect(delta.tombstones).toEqual([{ type: 'decks', key: 'd' }])
  })
  it('扫描生成快照；增量可校准；链断建议完整快照', async () => {
    await resetDatabase()
    await createDeck({ name: 'snap', words: [{ headword: 'a', meanings: [{ cn: '甲' }] }] })
    const base = await buildContentSnapshot({ now: 1, revision: 1 })
    expect(base.entries.length).toBeGreaterThanOrEqual(2)
    expect(base.snapshotId).toHaveLength(16)
    const changed = await buildContentSnapshot({ now: 2, revision: 2 })
    // 无变化 → 建议完整快照（snapshotId 相同）
    const same = buildContentIncrement(base, changed, { now: 2 })
    expect('needsFullSnapshot' in same).toBe(true)
    // 变更一个 meta 内容产生当前快照
    await getDb().meta.put({ key: 'userNote:w', value: 'x', updatedAt: 3 })
    const next = await buildContentSnapshot({ now: 3, revision: 2 })
    const pkg = buildContentIncrement(base, next, { now: 3, entities: [{ type: 'meta', key: 'userNote:w', data: 'x' }] })
    expect('format' in pkg).toBe(true)
    if ('format' in pkg) {
      expect(validateContentIncrement(pkg, base).ok).toBe(true)
      expect(validateContentIncrement({ ...pkg, baseRevision: 99 }, base)).toMatchObject({ ok: false, needsFullSnapshot: true })
    }
  })
  it('可取消', async () => {
    await resetDatabase()
    await expect(buildContentSnapshot({ shouldAbort: () => true })).rejects.toThrow(/E_ABORTED/)
  })
  it('默认设置 backup.autoContentEnabled=false', () => {
    expect(SETTINGS_DEFAULTS['backup.autoContentEnabled']).toBe(false)
  })
})

import { buildContentBaselineFile, exportContentEntities, getContentChainState, markContentChainFailure, markContentChainSuccess, saveContentBaselineFile } from '../../src/data'
describe('0.12 entity export/chain', () => {
  it('导出实体正文 + baseline 文件 + 连续失败3次 needsFull', async () => {
    await resetDatabase()
    await createDeck({ name: 'body', words: [{ headword: 'bodyword', meanings: [{ cn: '义' }] }] })
    const snap = await buildContentSnapshot({ revision: 1 })
    const entities = await exportContentEntities(snap.entries)
    const word = entities.find((entity) => entity.type === 'words')
    expect(word?.data).toMatchObject({ headword: 'bodyword' })
    const file = await buildContentBaselineFile(snap)
    expect(file.entities.length).toBeGreaterThan(0)
    const files = new Map<string, string>()
    const storage = { save: async (text: string, name: string) => { files.set(name, text); return { ok: true, name } }, read: (n: string) => files.get(n) ?? null, list: () => [...files.entries()].map(([name, text]) => ({ name, size: text.length, mtime: 1 })), delete: (n: string) => files.delete(n) }
    const saved = await saveContentBaselineFile(storage, file)
    expect(saved.ok).toBe(true)
    expect(files.size).toBe(1)
    await markContentChainFailure('x'); await markContentChainFailure('x')
    expect((await getContentChainState())?.needsFullSnapshot).toBe(false)
    await markContentChainFailure('x')
    expect((await getContentChainState())?.needsFullSnapshot).toBe(true)
    await markContentChainSuccess({ baseSnapshotId: snap.snapshotId, revision: 1, sequence: 0 })
    expect(await getContentChainState()).toMatchObject({ needsFullSnapshot: false, consecutiveFailures: 0 })
  })
})

import { restoreContentBaseline, restoreContentIncrementChain } from '../../src/data'
describe('0.12 restore baseline/chain', () => {
  it('基线恢复：旧内容替换；增量链恢复出新内容；失败回滚旧库不变', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'base-deck', words: [{ headword: 'baseword', meanings: [{ cn: '旧' }] }] })
    const baseSnap = await buildContentSnapshot({ revision: 1 })
    const baseFile = await buildContentBaselineFile(baseSnap)
    // 改内容（新增 note）
    await getDb().meta.put({ key: 'userNote:x', value: 'new-note', updatedAt: 10 })
    const current = await buildContentSnapshot({ revision: 2 })
    const pkg = buildContentIncrement(baseFile.manifest, current, { entities: (await exportContentEntities(current.entries)).map(({ type, key, data }) => ({ type, key, data })) })
    expect('format' in pkg).toBe(true)
    if (!('format' in pkg)) return
    // 先恢复基线
    expect(await restoreContentBaseline(baseFile)).toMatchObject({ ok: true })
    expect(await getDb().meta.get('userNote:x')).toBeUndefined()
    expect((await getDb().words.where('deckId').equals(deck.id).toArray()).length).toBe(1)
    // 链恢复
    const restored = await restoreContentIncrementChain(baseFile, [pkg])
    expect(restored.ok).toBe(true)
    expect((await getDb().meta.get('userNote:x'))?.value).toBe('new-note')
    // 失败（baseRevision 不匹配）→ ok false，旧内容仍在
    const bad = { ...pkg, baseRevision: 99 }
    const fail = await restoreContentIncrementChain(baseFile, [bad])
    expect(fail.ok).toBe(false)
    expect((await getDb().meta.get('userNote:x'))?.value).toBe('new-note')
  })
})
