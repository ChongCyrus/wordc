import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createDeck, getDb, resetDatabase } from '../../src/data'
import { mergeItemIntoWord } from '../../src/data/packs/merge'
import type { PackItemV1 } from '../../src/data'

beforeEach(async () => { await resetDatabase() })

describe('task-132：append 模式不受每词 CONTENT_LIMITS 限制', () => {
  it('词组已有 8 条：默认 limit skip；allowOverLimit 追加成功', async () => {
    const deck = await createDeck({ name: 'd', words: [{ headword: 'address', meanings: [{ cn: '地址' }] }] })
    const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
    word.phrases = Array.from({ length: 8 }, (_, i) => ({ en: `old phrase ${i}`, cn: `旧${i}` }))
    const item: PackItemV1 = { headword: 'address', phrases: [{ en: 'new extra phrase', cn: '新追加' }] }
    const blocked = mergeItemIntoWord(word, item, new Set())
    expect(blocked.skipped.some((skip) => skip.reason === 'limit')).toBe(true)
    const allowed = mergeItemIntoWord(word, item, new Set(), undefined, { allowOverLimit: true })
    expect(allowed.word.phrases).toHaveLength(9)
    expect(allowed.word.phrases.some((phrase) => phrase.en === 'new extra phrase')).toBe(true)
    expect(allowed.changed).toBe(true)
  })
})
