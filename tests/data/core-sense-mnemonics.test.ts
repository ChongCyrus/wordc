/** 0.3.76：本义助记单独导出/导入（候选/roundtrip/preview/merge/overwrite/stale/非法） */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyApproved,
  approveItems,
  applyCoreSenseMnemonicImport,
  buildCoreSenseMnemonicExport,
  buildMigrationFile,
  coreSenseMnemonicFileName,
  createDeck,
  getCoreSenseOverview,
  getDb,
  getEffectiveContent,
  getWord,
  importPack,
  listPackItems,
  listSenseMnemonics,
  previewCoreSenseMnemonicImport,
  resetDatabase,
  saveCoreSenseOverview,
  saveSenseMnemonic,
  updateSettings,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'export-mnemonic',
    words: [
      { headword: 'alpha', meanings: [{ cn: '甲' }, { cn: '阿尔法' }] },
      { headword: 'beta', meanings: [{ cn: '乙' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'semantics' as const,
    createdAt: Date.UTC(2026, 11, 17),
    generator: 'test@export-mnemonic',
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

describe('0.3.76 · 本义助记单独导出/导入', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('候选导出：无助记本义也导出；overview 带出；按 deck 过滤；文件名', async () => {
    const { deck, word, senses } = await setup()
    await saveSenseMnemonic(word.id, {
      coreSenseIndex: senses[0]!.index,
      label: senses[0]!.label,
      text: 'manual 助记',
    })
    await saveCoreSenseOverview(word.id, { text: '串联说明', source: 'manual' })
    const file = await buildCoreSenseMnemonicExport({ deckId: deck.id, pageSize: 1 })
    expect(file.format).toBe('wordc-core-sense-mnemonics')
    expect(file.version).toBe(1)
    expect(file.deckId).toBe(deck.id)
    expect(file.senses.map((sense) => sense.label)).toEqual(['本义一', '本义二'])
    expect(file.senses[0]!.mnemonic?.text).toBe('manual 助记')
    expect(file.senses[1]!.mnemonic).toBeUndefined() // 候选完整
    expect(file.senses[0]!.gloss).toBe('说明一')
    expect(file.words.map((row) => row.wordId)).toEqual([word.id])
    expect(file.words[0]!.overview?.text).toBe('串联说明')
    expect(coreSenseMnemonicFileName(Date.UTC(2026, 11, 17))).toBe('背单词-本义助记-2026-12-17.json')
  })

  it('preview 只读不写；apply 写入候选助记和 overview（roundtrip）', async () => {
    const { word, senses } = await setup()
    const file = await buildCoreSenseMnemonicExport()
    // 构造候选：全部带 mnemonic + overview
    const candidate = {
      ...file,
      words: [{ wordId: word.id, deckId: word.deckId, headword: word.headword, overview: { text: 'AI 串联' } }],
      senses: senses.map((sense) => ({
        wordId: word.id,
        headword: word.headword,
        coreSenseIndex: sense.index,
        label: sense.label,
        mnemonic: { text: `助记-${sense.label}` },
      })),
    }
    const text = JSON.stringify(candidate)
    const preview = await previewCoreSenseMnemonicImport(text)
    expect(preview.ok).toBe(true)
    expect(preview.counts.sensesImported).toBe(2)
    expect(preview.counts.overviewsImported).toBe(1)
    expect(await listSenseMnemonics(word.id)).toEqual([]) // 未写
    expect(await getCoreSenseOverview(word.id)).toBeNull()

    const report = await applyCoreSenseMnemonicImport(text)
    expect(report.ok).toBe(true)
    const list = await listSenseMnemonics(word.id)
    expect(list.map((entry) => entry.text).sort()).toEqual(['助记-本义一', '助记-本义二'].sort())
    expect(list.every((entry) => entry.source === 'ai')).toBe(true)
    expect((await getCoreSenseOverview(word.id))?.text).toBe('AI 串联')
  })

  it('merge 默认不覆盖 manual；overwrite 可覆盖；stale/空文本/非法格式', async () => {
    const { word, senses } = await setup()
    await saveSenseMnemonic(word.id, { coreSenseIndex: senses[0]!.index, label: senses[0]!.label, text: '手改' })
    await saveCoreSenseOverview(word.id, { text: '手改串联', source: 'manual' })
    const candidate = {
      format: 'wordc-core-sense-mnemonics',
      version: 1,
      exportedAt: Date.now(),
      words: [{ wordId: word.id, deckId: word.deckId, headword: word.headword, overview: { text: 'AI 串联' } }],
      senses: [
        { wordId: word.id, headword: word.headword, coreSenseIndex: senses[0]!.index, label: senses[0]!.label, mnemonic: { text: 'AI 新' } },
        { wordId: word.id, headword: word.headword, coreSenseIndex: 99, label: '旧本义', mnemonic: { text: '旧' } },
        { wordId: word.id, headword: word.headword, coreSenseIndex: senses[1]!.index, label: senses[1]!.label, mnemonic: { text: '   ' } },
      ],
    }
    const text = JSON.stringify(candidate)
    const merged = await applyCoreSenseMnemonicImport(text)
    expect(merged.counts.skippedManual).toBe(2) // 既有 manual 助记 + manual overview
    expect(merged.counts.stale).toBe(1)
    expect(merged.counts.emptySkipped).toBe(1)
    expect((await listSenseMnemonics(word.id)).find((entry) => entry.label === '本义一')!.text).toBe('手改')
    expect((await getCoreSenseOverview(word.id))?.text).toBe('手改串联')
    expect((await listSenseMnemonics(word.id)).some((entry) => entry.label === '本义二')).toBe(false)

    const overwritten = await applyCoreSenseMnemonicImport(text, { overwrite: true })
    expect(overwritten.counts.sensesImported).toBe(1)
    expect(overwritten.counts.overviewsImported).toBe(1)
    expect((await listSenseMnemonics(word.id)).find((entry) => entry.label === '本义一')!.text).toBe('AI 新')
    expect((await getCoreSenseOverview(word.id))?.text).toBe('AI 串联')

    const bad = await previewCoreSenseMnemonicImport(JSON.stringify({ format: 'x', version: 1 }))
    expect(bad.ok).toBe(false)
    expect(bad.issues[0]!.code).toBe('E_FORMAT')
    expect((await previewCoreSenseMnemonicImport('{bad json')).ok).toBe(false)
    // 迁移包不含该导出字段时不受影响
    expect((await buildMigrationFile({ includeReviewLogs: false })).data.words.length).toBeGreaterThan(0)
    expect(await getDb().words.get(word.id)).toBeTruthy()
  })
})
