/** 0.3.69：不常考本义标记（rareCoreSenses）repo/迁移 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, getWord, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  buildMigrationFile,
  clearRareCoreSenses,
  getEffectiveContent,
  getRareCoreSenseIndexes,
  importMigration,
  importPack,
  listPackItems,
  listRareCoreSenseViews,
  listRareCoreSenses,
  setRareCoreSenseIndexes,
  setRareCoreSenses,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'rare-core',
    words: [{ headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }, { pos: 'n.', cn: '阿尔法' }] }],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'semantics' as const,
    createdAt: Date.UTC(2026, 11, 17),
    generator: 'test@rare-core',
    items: [
      {
        headword: 'alpha',
        headwordLower: 'alpha',
        coreSenses: [
          { index: 1, label: '本义一', note: '说明一' },
          { index: 2, label: '本义二' },
        ],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1 },
          { meaningIndex: 2, coreSenseIndex: 2 },
        ],
      },
    ] as PackItemV1[],
    meta: { source: 'import' as const, deckId: deck.id },
  }
  const file: PackFileV1 = { ...base, checksum: (await computeChecksum(packChecksumPayload(base))).hex }
  const imported = await importPack(JSON.stringify(file))
  const items = await listPackItems(imported.packId!)
  await approveItems(imported.packId!, items.map((item) => item.id))
  await applyApproved(imported.packId!)
  const word = (await getWord(`${deck.id}:alpha`))!
  const senses = (await getEffectiveContent(word.id))!.coreSenses
  return { deck, word, senses }
}

describe('0.3.69 · rareCoreSenses', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('set indexes→label 快照；views label 优先/index 兜底；clear；迁移往返', async () => {
    const { word, senses } = await setup()
    expect(await listRareCoreSenses(word.id)).toEqual([])
    const saved = await setRareCoreSenseIndexes(word.id, [senses[1]!.index, 99, senses[1]!.index])
    expect(saved.map((entry) => entry.label)).toEqual(['本义二'])
    expect(saved[0]!.coreSenseIndex).toBe(senses[1]!.index)
    expect(await getRareCoreSenseIndexes(word.id)).toEqual([senses[1]!.index])
    const views = await listRareCoreSenseViews(word.id)
    expect(views.current.map((view) => [view.label, view.marked])).toEqual([
      ['本义一', false],
      ['本义二', true],
    ])
    expect(views.current[1]!.match).toBe('label')
    expect(views.stale).toEqual([])

    // 本义重排/替换：只改 index 不改 label → 仍按 label 匹配；对不上 label/index 的进 stale
    await setRareCoreSenses(word.id, [
      { coreSenseIndex: 1, label: '本义二' },
      { coreSenseIndex: 99, label: '旧本义' },
    ])
    const rematched = await listRareCoreSenseViews(word.id)
    expect(rematched.current[1]!.marked).toBe(true)
    expect(rematched.current[1]!.match).toBe('label')
    expect(rematched.stale.map((entry) => entry.label)).toEqual(['旧本义'])

    const file = await buildMigrationFile({ includeReviewLogs: false })
    const text = JSON.stringify(file)
    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    const restored = (await getWord(word.id))!
    expect(restored.rareCoreSenses?.map((entry) => entry.label)).toEqual(['本义二', '旧本义'])

    await clearRareCoreSenses(word.id)
    expect(await listRareCoreSenses(word.id)).toEqual([])
  })

  it('空 indexes 清空；无 coreSenses 时 set indexes 不报错并清空', async () => {
    const { word } = await setup()
    await setRareCoreSenseIndexes(word.id, [1])
    await setRareCoreSenseIndexes(word.id, [])
    expect(await listRareCoreSenses(word.id)).toEqual([])
    // 无 coreSenses 词
    const deck = await createDeck({ name: 'plain', words: [{ headword: 'plain', meanings: [{ cn: '平原' }] }] })
    const plain = (await getWord(`${deck.id}:plain`))!
    expect(await setRareCoreSenseIndexes(plain.id, [1])).toEqual([])
    expect((await listRareCoreSenseViews(plain.id)).current).toEqual([])
    // db 引用避免未使用
    expect(await getDb().words.get(word.id)).toBeTruthy()
  })
})
