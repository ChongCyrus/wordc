import './test-utils'
import { describe, expect, it } from 'vitest'
import { buildContentMigrationPlan, createDeck, getDb, resetDatabase, runContentMigrationBatches } from '../../src/data'
describe('0.14 migration plan', () => {
  it('分批200、自定义/内置 overlay 映射 key、失败不继续', async () => {
    await resetDatabase()
    await createDeck({ name: 'custom', words: [{ headword: 'a', meanings: [{ cn: '义' }] }] })
    const builtin = await createDeck({ name: 'builtin', words: [{ headword: 'b', meanings: [{ cn: '义' }] }] })
    await getDb().decks.update(builtin.id, { source: 'builtin', builtinKey: 'x' } as never)
    const word = (await getDb().words.where('deckId').equals(builtin.id).toArray())[0]!
    await getDb().words.put({ ...word, rootEtymology: { parts: [{ type: 'root', text: 'r' }] }, updatedAt: 3 } as never)
    const batches = await buildContentMigrationPlan({ batchSize: 50 })
    const rows = batches.flatMap((batch) => batch.rows)
    expect(rows.some((row) => row.kind === 'word')).toBe(true)
    expect(rows.some((row) => row.kind === 'word-overlay' && row.key.startsWith('word-overlay:'))).toBe(true)
    expect(rows.some((row) => row.kind === 'deck')).toBe(true)
    const fail = await runContentMigrationBatches(batches, async () => ({ ok: false, revision: 0, error: 'mock fail' }))
    expect(fail.ok).toBe(false)
    expect(fail.written).toBe(0)
  })
})
