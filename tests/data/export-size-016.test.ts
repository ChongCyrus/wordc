import './test-utils'
import { afterEach, describe, expect, it } from 'vitest'
import { createDeck, exportMigration, FULL_BACKUP_MAX_BYTES, getDb, resetDatabase } from '../../src/data'

afterEach(async () => { await resetDatabase() })

describe('0.16 完整备份 >20MB', () => {
  it('21MB 级完整备份不再被 20MB 上限拒绝，导出成功', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'big-backup', words: [{ headword: 'big', meanings: [{ cn: '大' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    await getDb().words.put({ ...word, userNotes: 'x'.repeat(21 * 1024 * 1024) } as never)
    expect(FULL_BACKUP_MAX_BYTES).toBeGreaterThan(21 * 1024 * 1024)
    const blob = await exportMigration({ maxBytes: FULL_BACKUP_MAX_BYTES, includeDerivationMaps: true })
    expect(blob.size).toBeGreaterThan(20 * 1024 * 1024)
  }, 60_000)
})
