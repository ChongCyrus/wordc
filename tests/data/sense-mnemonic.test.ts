/** 0.3.65：本义助记数据层（CRUD/label匹配/stale/manual 不覆盖/迁移/候选） */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, getWord, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  applySenseMnemonicSuggestions,
  approveItems,
  buildMigrationFile,
  clearAllSenseMnemonics,
  clearSenseMnemonic,
  collectSenseMnemonicSources,
  getEffectiveContent,
  importMigration,
  importPack,
  listPackItems,
  listSenseMnemonicViews,
  listSenseMnemonics,
  saveSenseMnemonic,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function setupWithSenses() {
  const deck = await createDeck({
    name: 'sense-mnemonic',
    words: [{ headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }, { pos: 'n.', cn: '阿尔法' }] }],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const file = await makePack(
    [
      {
        headword: 'alpha',
        headwordLower: 'alpha',
        coreSenses: [
          { index: 1, label: '本义一', note: '第一本义说明', origin: '拉丁 alpha', confidence: 'high' },
          { index: 2, label: '本义二', note: '第二本义说明', confidence: 'high' },
        ],
        meaningMap: [
          { meaningIndex: 1, coreSenseIndex: 1 },
          { meaningIndex: 2, coreSenseIndex: 2 },
        ],
      },
    ],
    deck.id,
  )
  const imported = await importPack(JSON.stringify(file))
  const items = await listPackItems(imported.packId!)
  await approveItems(imported.packId!, items.map((item) => item.id))
  await applyApproved(imported.packId!)
  const word = (await getWord(`${deck.id}:alpha`))!
  const effective = await getEffectiveContent(word.id)
  return { deck, word, senses: effective!.coreSenses }
}

async function makePack(items: PackItemV1[], deckId: string): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'semantics' as const,
    createdAt: Date.UTC(2026, 11, 16),
    generator: 'test@sense-mnemonic',
    items,
    meta: { source: 'import' as const, deckId },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

describe('0.3.65 · senseMnemonic repo', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('保存/读取/manual+ai；label 优先匹配；stale 旧条目不隐藏；clear', async () => {
    const { word, senses } = await setupWithSenses()
    expect((await listSenseMnemonics(word.id))).toEqual([])
    const manual = await saveSenseMnemonic(word.id, {
      coreSenseIndex: senses[0]!.index,
      label: senses[0]!.label,
      text: '拆分：al + pha → 甲',
    })
    const ai = await saveSenseMnemonic(word.id, {
      coreSenseIndex: senses[1]!.index,
      label: senses[1]!.label,
      text: '谐音记忆乙',
      source: 'ai',
    })
    expect(manual.source).toBe('manual')
    expect(ai.source).toBe('ai')

    // 错误 index 但 label 正确 → 按 label 匹配
    await saveSenseMnemonic(word.id, { coreSenseIndex: 9, label: senses[1]!.label, text: '改AI助记', source: 'ai' })
    const views = await listSenseMnemonicViews(word.id)
    expect(views.current.map((view) => view.label)).toEqual(senses.map((sense) => sense.label))
    expect(views.current[0]!.mnemonic?.text).toBe('拆分：al + pha → 甲')
    expect(views.current[0]!.match).toBe('label')
    expect(views.current[1]!.mnemonic?.text).toBe('改AI助记')

    // 旧本义 label → stale
    await saveSenseMnemonic(word.id, { coreSenseIndex: 99, label: '旧本义', text: '旧助记' })
    const withStale = await listSenseMnemonicViews(word.id)
    expect(withStale.stale.map((entry) => entry.label)).toEqual(['旧本义'])

    expect(await clearSenseMnemonic(word.id, { label: '旧本义' })).toBe(true)
    expect(await clearSenseMnemonic(word.id, { label: '旧本义' })).toBe(false)
    await clearAllSenseMnemonics(word.id)
    expect(await listSenseMnemonics(word.id)).toEqual([])
  })

  it('apply suggestions：manual 不覆盖、AI 默认 skip、overwriteAi 可覆盖；stale 计数', async () => {
    const { word, senses } = await setupWithSenses()
    await saveSenseMnemonic(word.id, { coreSenseIndex: senses[0]!.index, label: senses[0]!.label, text: 'manual 助记' })
    await saveSenseMnemonic(word.id, { coreSenseIndex: senses[1]!.index, label: senses[1]!.label, text: '旧 ai', source: 'ai' })
    const suggestions = [
      { coreSenseIndex: senses[0]!.index, label: senses[0]!.label, text: 'AI 新 1' },
      { coreSenseIndex: senses[1]!.index, label: senses[1]!.label, text: 'AI 新 2' },
      { coreSenseIndex: 9, label: '已删除本义', text: 'AI 新 3' },
    ]
    const skipped = await applySenseMnemonicSuggestions(word.id, suggestions)
    expect(skipped).toEqual({ applied: 0, skippedManual: 1, skippedExisting: 1, stale: 1 })
    expect((await listSenseMnemonics(word.id)).find((entry) => entry.label === '本义一')!.text).toBe('manual 助记')

    const applied = await applySenseMnemonicSuggestions(word.id, suggestions, { overwriteAi: true })
    expect(applied).toEqual({ applied: 1, skippedManual: 1, skippedExisting: 0, stale: 1 })
    const list = await listSenseMnemonics(word.id)
    expect(list.find((entry) => entry.label === '本义一')!.text).toBe('manual 助记')
    expect(list.find((entry) => entry.label === '本义二')!.text).toBe('AI 新 2')
    expect(list.find((entry) => entry.label === '本义二')!.source).toBe('ai')
  })

  it('迁移导出→清库→导入恢复 senseMnemonics', async () => {
    const { word, senses } = await setupWithSenses()
    await saveSenseMnemonic(word.id, { coreSenseIndex: senses[0]!.index, label: senses[0]!.label, text: '迁移助记' })
    const file = await buildMigrationFile({ includeReviewLogs: false })
    const text = JSON.stringify(file)
    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    const restored = (await getWord(word.id))!
    expect(restored.senseMnemonics?.[0]?.text).toBe('迁移助记')
  })

  it('QA fixture 形状：applied 旧 semantics pack 下 views/sources 不挂起；无 coreSenses 快速返回空', async () => {
    const deck = await createDeck({
      name: 'qa-fixture',
      words: [
        { headword: 'denounce', meanings: [{ pos: 'v.', cn: '谴责' }] },
        { headword: 'plain', meanings: [{ pos: 'n.', cn: '平原' }] },
      ],
    })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const db = getDb()
    const word = (await db.words.get(`${deck.id}:denounce`))!
    const plain = (await db.words.get(`${deck.id}:plain`))!
    const now = Date.now()
    await db.packs.put({
      id: 'fixture-old-v3-semantics',
      name: '旧本义链样本',
      kind: 'semantics',
      formatVersion: 1,
      checksum: '137004c4fixture',
      source: 'import',
      status: 'applied',
      deckId: deck.id,
      promptVersion: 'v3.0',
      counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 },
      createdAt: now - 2000,
      updatedAt: now - 2000,
    })
    await db.packItems.put({
      id: 'fixture-old-v3-semantics:1',
      packId: 'fixture-old-v3-semantics',
      seq: 1,
      wordId: word.id,
      headword: word.headword,
      headwordLower: word.headwordLower,
      payload: {
        headword: word.headword,
        coreSenses: [{ index: 1, label: 'fixture旧本义' }],
        meaningMap: [{ meaningIndex: 1, coreSenseIndex: 1, steps: ['fixture旧步骤'] }],
      },
      status: 'applied',
      contentHashes: [],
      createdAt: now - 2000,
      appliedAt: now - 2000,
    })
    const timeout = <T>(promise: Promise<T>, ms = 2_000) =>
      Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('TIMEOUT')), ms))])
    const t0 = Date.now()
    const views = await timeout(listSenseMnemonicViews(word.id))
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(views.current.map((view) => view.label)).toEqual(['fixture旧本义'])
    const sources = await timeout(collectSenseMnemonicSources({ scope: 'word', wordId: word.id }, { includeExisting: true }))
    expect(sources.map((source) => source.label)).toEqual(['fixture旧本义'])
    // 无 coreSenses 的词：快速返回空，不抛/不挂
    expect(await timeout(listSenseMnemonicViews(plain.id))).toEqual({ current: [], stale: [] })
    expect(await timeout(collectSenseMnemonicSources({ scope: 'word', wordId: plain.id }))).toEqual([])
    // 不存在 wordId：快速 reject（UI 显示错误+重试）
    await expect(timeout(listSenseMnemonicViews('missing-word'))).rejects.toThrow(/不存在/)
  })

  it('批量候选：deck/word 范围、只取有 coreSenses、默认排除已有、includeExisting 可含', async () => {
    const { deck, word, senses } = await setupWithSenses()
    const all = await collectSenseMnemonicSources({ scope: 'deck', deckId: deck.id })
    expect(all.map((source) => source.label)).toEqual(senses.map((sense) => sense.label))
    expect(all.every((source) => source.wordId === word.id)).toBe(true)
    expect(all[0]!.meanings).toHaveLength(2)

    await saveSenseMnemonic(word.id, { coreSenseIndex: senses[0]!.index, label: senses[0]!.label, text: '已有' })
    const excluded = await collectSenseMnemonicSources({ scope: 'word', wordId: word.id })
    expect(excluded.map((source) => source.label)).toEqual([senses[1]!.label])
    const included = await collectSenseMnemonicSources({ scope: 'word', wordId: word.id }, { includeExisting: true })
    expect(included).toHaveLength(2)
    expect(included[0]!.existing?.text).toBe('已有')
    expect(await collectSenseMnemonicSources({ scope: 'word', wordId: 'no-such-id' })).toEqual([])
  })
})
