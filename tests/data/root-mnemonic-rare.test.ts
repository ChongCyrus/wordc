/** 0.3.61：rootMnemonic / rareMeaningIds / 学习过滤 / 迁移 / AI apply 不覆盖 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, getWord, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  buildMigrationFile,
  clearRareMeaningIds,
  clearRootMnemonic,
  filterStudyMeanings,
  getRareMeaningIds,
  getRootMnemonic,
  getStudyMeanings,
  importMigration,
  importPack,
  listPackItems,
  saveRootMnemonic,
  setRareMeaningIds,
  setRareMeaningIndexes,
  toggleRareMeaningId,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: '0.3.61',
    words: [{ headword: 'marginal', meanings: [{ pos: 'adj.', cn: '边缘的' }, { pos: 'n.', cn: '边际' }, { pos: 'n.', cn: '边际席位' }] }],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const word = (await getWord(`${deck.id}:marginal`))!
  return { deck, word }
}

async function makePack(items: PackItemV1[], deckId: string): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'mixed' as const,
    createdAt: Date.UTC(2026, 11, 16),
    generator: 'test@root-rare',
    items,
    meta: { source: 'import' as const, deckId },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

describe('0.3.61 · rootMnemonic', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('get/save(manual/ai)/clear；空内容拒绝；AI apply 不覆盖', async () => {
    const { deck, word } = await setup()
    expect(await getRootMnemonic(word.id)).toBeNull()
    const manual = await saveRootMnemonic(word.id, '  margin+al → 在边缘的  ')
    expect(manual.text).toBe('margin+al → 在边缘的')
    expect(manual.source).toBe('manual')
    const ai = await saveRootMnemonic(word.id, '词根 margin 边缘', 'ai')
    expect(ai.source).toBe('ai')
    await expect(saveRootMnemonic(word.id, '   ')).rejects.toThrow(/不能为空/)

    const file = await makePack(
      [{ headword: 'marginal', headwordLower: 'marginal', meaningIndex: 1, mnemonics: [{ type: '联想', text: 'AI mnemonic' }] }],
      deck.id,
    )
    const imported = await importPack(JSON.stringify(file))
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    await applyApproved(imported.packId!)
    expect(await getRootMnemonic(word.id)).toEqual(ai) // AI apply 不覆盖

    expect(await clearRootMnemonic(word.id)).toBe(true)
    expect(await clearRootMnemonic(word.id)).toBe(false)
    expect(await getRootMnemonic(word.id)).toBeNull()
  })
})

describe('0.3.61 · rareMeaningIds + 学习过滤', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('set 去重/过滤非法；toggle；filterStudyMeanings 隐藏/全量；nc 不受影响', async () => {
    const { word } = await setup()
    const [m1, m2, m3] = word.meanings.map((meaning) => meaning.id)
    expect(await getRareMeaningIds(word.id)).toEqual([])
    expect(await setRareMeaningIds(word.id, [m3!, 'bad-id', m3!])).toEqual([m3])
    expect(await getRareMeaningIds(word.id)).toEqual([m3])
    expect(await setRareMeaningIndexes(word.id, [2, 99])).toEqual([m2])
    expect(await toggleRareMeaningId(word.id, m1!)).toEqual([m2, m1])
    expect(await toggleRareMeaningId(word.id, m2!, false)).toEqual([m1])
    await expect(toggleRareMeaningId(word.id, 'bad-id')).rejects.toThrow(/含义不存在/)

    const current = (await getDb().words.get(word.id))!
    expect(filterStudyMeanings(current, true).map((meaning) => meaning.id)).toEqual([m2, m3])
    expect(filterStudyMeanings(current, false).map((meaning) => meaning.id)).toEqual([m1, m2, m3])
    expect(await getStudyMeanings(word.id, true)).toHaveLength(2)
    expect(await getStudyMeanings(word.id, false)).toHaveLength(3)
    // 空 meanings / rare 缺失不报错
    expect(filterStudyMeanings({ ...current, meanings: [] }, true)).toEqual([])
    expect(filterStudyMeanings({ ...current, rareMeaningIds: undefined }, true)).toHaveLength(3)

    // nc 独立字段，不受 rare 设置影响
    await getDb().words.update(word.id, { ncMeaningIds: [m3!] })
    expect((await getDb().words.get(word.id))!.ncMeaningIds).toEqual([m3])

    await clearRareMeaningIds(word.id)
    expect(await getRareMeaningIds(word.id)).toEqual([])
  })

  it('迁移导出→清库→导入恢复 rootMnemonic/rareMeaningIds', async () => {
    const { word } = await setup()
    const m2 = word.meanings[1]!.id
    const root = await saveRootMnemonic(word.id, '映射助记', 'ai')
    await setRareMeaningIds(word.id, [m2])
    const file = await buildMigrationFile({ includeReviewLogs: false })
    const text = JSON.stringify(file)
    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    const restored = (await getWord(word.id))!
    expect(restored.rootMnemonic).toEqual(root)
    expect(restored.rareMeaningIds).toEqual([m2])
  })
})
