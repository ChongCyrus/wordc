import './test-utils'
import { describe, expect, it } from 'vitest'
import { buildContentSnapshot, createDeck, getDb, resetDatabase, restoreContentBaselineIndexed, saveContentBaselineChunked } from '../../src/data'
class FakeBridge {
  files = new Map<string, { text: string; mtime: number }>(); seq = 0
  save(text: string, name: string) { const actual = name.endsWith('.gz') ? name : `${name}.gz`; this.files.set(actual, { text, mtime: ++this.seq }); return { ok: true, mode: 'native' as const, name: actual } }
  read(name: string) { return this.files.get(name)?.text ?? null }
  list() { return [...this.files.entries()].map(([name, f]) => ({ name, size: f.text.length, mtime: f.mtime, path: name })) }
  delete(name: string) { return this.files.delete(name) }
  isAvailable() { return true } prune() { return 0 }
  getFlag() { return '' } setFlag() { return true } appendDiagLog() {}
}
describe('0.12 chunk baseline memory', () => {
  it('大量自定义词分 part 保存并合并恢复', async () => {
    await resetDatabase()
    await createDeck({ name: 'chunk', words: Array.from({ length: 700 }, (_, i) => ({ headword: `cw${i}`, meanings: [{ cn: `义${i}` }] })) })
    const snapshot = await buildContentSnapshot({ revision: 1 })
    const bridge = new FakeBridge(); const storage = bridge as never
    const saved = await saveContentBaselineChunked(storage, snapshot, { chunkSize: 100 })
    expect(saved.ok).toBe(true)
    expect(saved.chunks).toBeGreaterThanOrEqual(7)
    const maxPart = Math.max(...[...bridge.files.values()].filter((f) => f.text.includes('momo-content-baseline-chunk')).map((f) => f.text.length))
    expect(maxPart).toBeLessThan(saved.bytes)
    await getDb().words.clear()
    const index = [...bridge.files.keys()].find((name) => name.includes('-index'))!
    const restored = await restoreContentBaselineIndexed(storage, index)
    expect(restored.ok).toBe(true)
    expect(await getDb().words.count()).toBe(700)
  })
})
