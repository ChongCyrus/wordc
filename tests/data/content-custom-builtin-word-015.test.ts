import './test-utils'
import { describe, expect, it } from 'vitest'
import { addWord, buildContentSnapshot, ensureBuiltinDecks, getDb, resetDatabase } from '../../src/data'
import { backfillLegacyCustomBuiltinWordsForV15 } from '../../src/data/content-migration-plan'
import { BUILTIN_DECK_IDS } from '../../src/data/builtin'

describe('0.15 内置 deck 中用户新增词按可变内容迁移', () => {
  it('addWord 到内置 deck 后 snapshot 包含 words 行，而不是仅 overlay', async () => {
    await resetDatabase()
    await ensureBuiltinDecks({ force: true })
    const deckId = BUILTIN_DECK_IDS[0]!
    const word = await addWord(deckId, { headword: 'zzcustom015', meaning: '测试自定义词' })
    expect(word.custom).toBe(true)
    const snapshot = await buildContentSnapshot({ revision: 0 })
    expect(snapshot.entries.some((entry) => entry.type === 'words' && entry.key === word.id)).toBe(true)
  }, 30_000)

  it('0.14 遗留未标记的自定义内置词，迁移前自动补 custom 标记', async () => {
    await resetDatabase()
    await ensureBuiltinDecks({ force: true })
    const deckId = BUILTIN_DECK_IDS[0]!
    const legacyId = `${deckId}:zzlegacy015`
    const deck = (await getDb().decks.get(deckId))!
    await getDb().words.put({
      id: legacyId, deckId, headword: 'zzlegacy015', headwordLower: 'zzlegacy015',
      meanings: [{ id: `${legacyId}#M1`, cn: '遗留自定义词' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 99999,
      createdAt: 1, updatedAt: 1,
    } as never)
    expect(await backfillLegacyCustomBuiltinWordsForV15()).toBeGreaterThanOrEqual(1)
    expect((await getDb().words.get(legacyId))?.custom).toBe(true)
    void deck
  }, 30_000)
})
