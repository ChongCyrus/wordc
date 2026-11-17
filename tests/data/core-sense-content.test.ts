/** 0.3.72：本义代表 c + 例句/词组存储（stale/迁移） */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  applyApproved,
  approveItems,
  buildMigrationFile,
  clearCoreSenseExamples,
  clearCoreSensePhrases,
  createDeck,
  getCoreSenseRepresentative,
  getDb,
  getEffectiveContent,
  getWord,
  importMigration,
  importPack,
  listCoreSenseExampleViews,
  listCoreSensePhraseViews,
  listPackItems,
  resetDatabase,
  saveCoreSenseExamples,
  saveCoreSensePhrases,
  updateSettings,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'core-content',
    words: [
      {
        headword: 'alpha',
        meanings: [
          { pos: 'n.', cn: '甲' },
          { pos: 'n.', cn: '阿尔法' },
        ],
      },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'semantics' as const,
    createdAt: Date.UTC(2026, 11, 17),
    generator: 'test@core-content',
    items: [
      {
        headword: 'alpha',
        headwordLower: 'alpha',
        coreSenses: [{ index: 1, label: '本义一' }],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1 },
          { meaningIndex: 2, coreSenseIndex: 1 },
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
  const effective = await getEffectiveContent(word.id)
  const sense = effective!.coreSenses[0]!
  // c1 无例句；c2 有例句+词组（代表 c 取 c2）
  await getDb().words.update(word.id, {
    meanings: [
      { ...word.meanings[0]!, examples: [] },
      {
        ...word.meanings[1]!,
        examples: [
          { en: 'alpha example 1', cn: '例句一' },
          { en: 'alpha example 1', cn: '例句一' }, // 去重
          { en: 'alpha example 2', cn: '例句二' },
        ],
      },
    ],
    phrases: [
      { en: 'alpha phrase 1', cn: '词组一', meaningId: word.meanings[1]!.id },
      { en: 'alpha phrase 1', cn: '词组一', meaningId: word.meanings[1]!.id },
      { en: 'alpha phrase 2', cn: '词组二', meaningId: word.meanings[1]!.id },
    ],
  })
  return { word: (await getWord(word.id))!, sense }
}

describe('0.3.72 · coreSenseExamples/Phrases', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('代表 c：按 meaningMap 顺序取第一个有例句的 c；去重、N 限制；同时返回 phrases；N=0 空', async () => {
    const { word, sense } = await setup()
    const rep = (await getCoreSenseRepresentative(word.id, sense.index, 2))!
    expect(rep.label).toBe('本义一')
    expect(rep.representativeMeaningId).toBe(word.meanings[1]!.id)
    expect(rep.representativeCn).toBe('阿尔法')
    expect(rep.examples.map((example) => example.en)).toEqual(['alpha example 1', 'alpha example 2'])
    expect(rep.phrases.map((phrase) => phrase.en)).toEqual(['alpha phrase 1', 'alpha phrase 2'])

    const zero = (await getCoreSenseRepresentative(word.id, sense.index, 0))!
    expect(zero.examples).toEqual([])
    expect(zero.phrases).toEqual([])
    expect(await getCoreSenseRepresentative(word.id, 99)).toBeNull()
  })

  it('保存/视图/stale/清除；迁移往返包含两字段', async () => {
    const { word, sense } = await setup()
    await saveCoreSenseExamples(word.id, {
      coreSenseIndex: sense.index,
      label: sense.label,
      examples: [{ en: 'AI example', cn: 'AI 例句' }],
      source: 'ai',
    })
    await saveCoreSensePhrases(word.id, {
      coreSenseIndex: sense.index,
      label: sense.label,
      phrases: [{ en: 'AI phrase', cn: 'AI 词组' }],
      source: 'ai',
    })
    const views = await listCoreSenseExampleViews(word.id)
    expect(views.current[0]!.entry?.examples).toEqual([{ en: 'AI example', cn: 'AI 例句' }])
    expect(views.current[0]!.match).toBe('label')
    const phraseViews = await listCoreSensePhraseViews(word.id)
    expect(phraseViews.current[0]!.entry?.phrases).toEqual([{ en: 'AI phrase', cn: 'AI 词组' }])

    // 旧 label → stale
    await saveCoreSenseExamples(word.id, {
      coreSenseIndex: 9,
      label: '旧本义',
      examples: [{ en: 'old', cn: '旧' }],
    })
    expect((await listCoreSenseExampleViews(word.id)).stale.map((entry) => entry.label)).toEqual(['旧本义'])

    const file = await buildMigrationFile({ includeReviewLogs: false })
    const text = JSON.stringify(file)
    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    const restored = (await getWord(word.id))!
    expect(restored.coreSenseExamples?.find((entry) => entry.label === sense.label)?.examples[0]?.en).toBe('AI example')
    expect(restored.coreSensePhrases?.find((entry) => entry.label === sense.label)?.phrases[0]?.en).toBe('AI phrase')

    await clearCoreSenseExamples(word.id, { label: sense.label })
    await clearCoreSensePhrases(word.id, { label: sense.label })
    expect(((await getWord(word.id))!.coreSenseExamples ?? []).every((entry) => entry.label !== sense.label)).toBe(true)
    expect(((await getWord(word.id))!.coreSensePhrases ?? []).every((entry) => entry.label !== sense.label)).toBe(true)
  })
})
