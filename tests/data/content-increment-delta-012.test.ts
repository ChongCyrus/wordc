import './test-utils'
import { describe, expect, it } from 'vitest'
import { createDeck, createContentBaseline, createContentIncrement, getDb, recordContentOp, resetDatabase, setContentBackupStorage, updateSettings } from '../../src/data'
import { createContentBackupStorage } from '../../src/app/utils/content-backup-storage'
class FakeBridge {
  files = new Map<string, { text: string; mtime: number }>(); seq = 0
  save(text: string, name: string) { const actual = name.endsWith('.gz') ? name : `${name}.gz`; this.files.set(actual, { text, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name: actual } }
  list() { return [...this.files.entries()].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime, path: name })) }
  read(name: string) { return this.files.get(name)?.text ?? null }
  delete(name: string) { return this.files.delete(name) }
  isAvailable() { return true } prune() { return 0 } getFlag() { return '' } setFlag() { return true } appendDiagLog() {}
}
describe('0.12 increment delta only', () => {
  it('5528 builtin overlay 只改 1 个 root：增量 items=1/source=log/<2s', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'big', words: [] })
    const db = getDb()
    await db.decks.update(deck.id, { source: 'builtin', builtinKey: 'kaoyan-2027-dagang' } as never)
    const words = Array.from({ length: 5528 }, (_, i) => ({ id: `${deck.id}:w${i}`, deckId: deck.id, headword: `w${i}`, headwordLower: `w${i}`, meanings: [{ id: 'm', cn: '义' }], examples: [], mnemonics: [], phrases: [], tags: [], order: i + 1, rootEtymology: { parts: [{ type: 'root', text: 'x' }] }, updatedAt: 1, createdAt: 1 }))
    await db.words.bulkPut(words as never)
    const bridge = new FakeBridge(); setContentBackupStorage(createContentBackupStorage(bridge as never))
    await updateSettings({ 'backup.contentEventLogEnabled': true })
    expect((await createContentBaseline()).ok).toBe(true)
    const target = await db.words.get(`${deck.id}:w0`)
    await db.words.put({ ...target!, rootEtymology: { parts: [{ type: 'root', text: 'changed' }] }, updatedAt: 9 } as never)
    await recordContentOp({ type: 'wordOverlay', key: `${deck.id}:w0`, op: 'upsert' })
    const started = Date.now()
    const inc = await createContentIncrement()
    expect(Date.now() - started).toBeLessThan(2000)
    expect(inc.ok).toBe(true)
    expect(inc.items).toBe(1)
    const incFile = [...bridge.files.values()].find((file) => file.text.includes('momo-content-increment'))
    expect(incFile && JSON.parse(incFile.text).source).toBe('log')
  }, 60000)
})

describe('0.12 entitySetVersion/delta guard', () => {
  it('旧基线缺 entitySetVersion → full-required，不导出', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'guard', words: [{ headword: 'g', meanings: [{ cn: '义' }] }] })
    const db = getDb(); await db.decks.update(deck.id, { source: 'builtin', builtinKey: 'x' } as never)
    const bridge = new FakeBridge(); setContentBackupStorage(createContentBackupStorage(bridge as never))
    expect((await createContentBaseline()).ok).toBe(true)
    const index = [...bridge.files.entries()].find(([name]) => name.includes('-index'))!
    const parsed = JSON.parse(index[1].text); delete parsed.manifest.entitySetVersion
    index[1].text = JSON.stringify(parsed)
    const inc = await createContentIncrement()
    expect(inc.ok).toBe(false)
    expect(inc.mode).toBe('full-required')
    expect(inc.error).toMatch(/entitySetVersion|口径|基线/)
  })
})
