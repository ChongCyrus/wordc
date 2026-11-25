import './test-utils'
import { describe, expect, it } from 'vitest'
import { buildContentBaselineFile, buildContentIncrement, buildContentSnapshot, createDeck, exportContentEntities, getDb, resetDatabase, restoreContentIncrementChain } from '../../src/data'
describe('0.12 builtin word overlay', () => {
  it('内置词 rootEtymology 修改→增量→恢复仍在；不可变正文不重复备份', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'builtin', words: [{ headword: 'rootword', meanings: [{ cn: '义' }] }] })
    const db = getDb()
    await db.decks.update(deck.id, { source: 'builtin', builtinKey: 'kaoyan' } as never)
    const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    const base = await buildContentSnapshot({ revision: 1 })
    expect(base.entries.some((entry) => entry.type === 'words')).toBe(false)
    expect(base.entries.some((entry) => entry.type === 'wordOverlay' && entry.key === word.id)).toBe(false)
    const baseFile = await buildContentBaselineFile(base)
    await db.words.put({ ...word, rootEtymology: { parts: [{ type: 'root', text: 'rt' }] }, updatedAt: 99 } as never)
    const current = await buildContentSnapshot({ revision: 2 })
    expect(current.entries.some((entry) => entry.type === 'wordOverlay' && entry.key === word.id)).toBe(true)
    const entities = (await exportContentEntities(current.entries)).map(({ type, key, data }) => ({ type, key, data }))
    const pkg = buildContentIncrement(baseFile.manifest, current, { entities })
    expect('format' in pkg).toBe(true); if (!('format' in pkg)) return
    await db.words.put({ ...word, rootEtymology: undefined, updatedAt: 100 } as never)
    const restored = await restoreContentIncrementChain(baseFile, [pkg])
    expect(restored.ok).toBe(true)
    expect((await db.words.get(word.id))?.rootEtymology).toBeTruthy()
  })
})

import { DECK_SOURCES } from '../../src/data/builtin/deck-sources'
describe('0.12 builtin id detection', () => {
  it('deck 无 builtinKey/source 但 id 是内置时只存 overlay', async () => {
    await resetDatabase()
    const builtinId = DECK_SOURCES[0]!.deckId
    await getDb().decks.put({ id: builtinId, name: 'legacy-builtin', source: 'custom', wordCount: 1, version: 1, isDefault: true, createdAt: 1, updatedAt: 1 } as never)
    await getDb().words.put({ id: `${builtinId}:w`, deckId: builtinId, headword: 'w', headwordLower: 'w', meanings: [{ id: 'm', cn: '义' }], examples: [], mnemonics: [], phrases: [], tags: [], order: 1, createdAt: 1, updatedAt: 1 } as never)
    const snap = await buildContentSnapshot({ revision: 1 })
    expect(snap.entries.some((entry) => entry.type === 'words')).toBe(false)
  })
})

import { restoreContentBaseline } from '../../src/data'
describe('0.12 builtin overlay baseline restore', () => {
  it('改内置词 root→基线→改坏→恢复后 root 回来', async () => {
    await resetDatabase()
    const deck = await createDeck({ name: 'builtin-base', words: [{ headword: 'br', meanings: [{ cn: '义' }] }] })
    const db = getDb()
    await db.decks.update(deck.id, { source: 'builtin', builtinKey: 'kaoyan-2027-dagang' } as never)
    const word = (await db.words.where('deckId').equals(deck.id).toArray())[0]!
    await db.words.put({ ...word, rootEtymology: { parts: [{ type: 'root', text: 'good' }] }, updatedAt: 50 } as never)
    const snap = await buildContentSnapshot({ revision: 1 })
    expect(snap.entries.some((entry) => entry.type === 'wordOverlay' && entry.key === word.id)).toBe(true)
    const base = await buildContentBaselineFile(snap)
    expect(base.entities.some((entity) => entity.type === 'wordOverlay' && entity.key === word.id)).toBe(true)
    await db.words.put({ ...word, rootEtymology: { parts: [{ type: 'root', text: 'bad' }] }, updatedAt: 60 } as never)
    const restored = await restoreContentBaseline(base)
    expect(restored.ok).toBe(true)
    const after = await db.words.get(word.id)
    expect((after?.rootEtymology as { parts?: Array<{ text?: string }> } | undefined)?.parts?.[0]?.text).toBe('good')
  })
})
