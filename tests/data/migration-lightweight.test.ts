/** 0.3.61：迁移包默认轻量（不含 derivationMap/内容包），避免 WebView base64 OOM；导入兼容 + 保留本机用户内容 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, getWord, resetDatabase, updateSettings } from '../../src/data'
import {
  MigrationTooLargeError,
  buildMigrationFile,
  estimateMigrationBytes,
  exportMigration,
  getDerivationMap,
  importMigration,
  saveDerivationMap,
} from '../../src/data'

async function setupLargeFixture() {
  const wordCount = 400
  const deck = await createDeck({
    name: 'lightweight-fixture',
    words: Array.from({ length: wordCount }, (_, index) => ({
      headword: `w${index}`,
      meanings: [{ pos: 'n.', cn: `含义${index}` }],
    })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  for (let index = 0; index < wordCount; index += 1) {
    await saveDerivationMap(`${deck.id}:w${index}`, {
      rootLabel: `生成元${index}`,
      text: `- 生成元${index} → 含义${index}\n${'- 说明'.repeat(80)}`,
      mermaid: `mindmap\n  root((生成元${index}))\n    含义${index}`,
      lines: [{ text: `生成元${index} → 含义${index}`, meaningIndexes: [1] }],
      source: 'ai',
    })
  }
  const db = getDb()
  const packId = 'pk_light_fixture'
  const now = Date.now()
  await db.packs.put({
    id: packId,
    name: '话题内容包',
    kind: 'mixed',
    formatVersion: 1,
    checksum: 'light-fixture',
    source: 'ai',
    status: 'applied',
    counts: { items: 2000, pending: 0, approved: 0, applied: 2000, rejected: 0, skipped: 0 },
    createdAt: now,
    updatedAt: now,
  })
  await db.packItems.bulkPut(
    Array.from({ length: 2000 }, (_, index) => ({
      id: `${packId}:${index + 1}`,
      packId,
      seq: index + 1,
      headword: `w${index % wordCount}`,
      headwordLower: `w${index % wordCount}`,
      payload: {
        headword: `w${index % wordCount}`,
        examples: [{ en: `pack example ${index} ${'x'.repeat(120)}`, cn: '内容包例句' }],
        phrases: [{ en: `pack phrase ${index}`, cn: '内容包词组' }],
      },
      status: 'applied' as const,
      contentHashes: [`hash-${index}`],
      createdAt: now,
    })),
  )
  return { deck, wordCount }
}

describe('0.3.61 · 轻量 migration 导出/导入', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('默认导出不含 derivationMap/contentPacks，体积显著小于完整包；含 meta.excluded', async () => {
    const { deck } = await setupLargeFixture()
    const light = await buildMigrationFile({ includeReviewLogs: false })
    const full = await buildMigrationFile({
      includeReviewLogs: false,
      includeDerivationMaps: true,
      includeContentPacks: true,
    })
    const lightText = JSON.stringify(light)
    const fullText = JSON.stringify(full)
    expect(fullText.length).toBeGreaterThan(lightText.length * 1.5)
    expect(light.meta?.excluded).toEqual(expect.arrayContaining(['derivationMap', 'contentPacks']))
    expect(light.meta?.excluded).toHaveLength(2)
    const lightData = light.data as typeof light.data & { contentPacks?: unknown[]; packItems?: unknown[] }
    expect(light.data.words.some((word) => 'derivationMap' in word)).toBe(false)
    expect(lightData.contentPacks).toBeUndefined()
    expect(lightData.packItems).toBeUndefined()
    const fullData = full.data as typeof full.data & { contentPacks?: unknown[]; packItems?: unknown[] }
    expect(full.data.words.some((word) => Boolean(word.derivationMap))).toBe(true)
    expect(fullData.contentPacks?.length).toBe(1)
    expect(fullData.packItems?.length).toBe(2000)
    expect(light.data.words).toHaveLength(400)
    expect(deck.id).toBeTruthy()
  }, 120_000)

  it('replace 导入轻量包：保留本机 derivationMap 与内容包（不清空）', async () => {
    const { deck, wordCount } = await setupLargeFixture()
    const db = getDb()
    const light = await buildMigrationFile({ includeReviewLogs: false })
    const lightText = JSON.stringify(light)
    const beforeMap = await getDerivationMap(`${deck.id}:w0`)
    expect(beforeMap).toBeTruthy()
    const report = await importMigration(lightText, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect(await getDerivationMap(`${deck.id}:w0`)).toEqual(beforeMap)
    expect(await db.packs.count()).toBe(1)
    expect(await db.packItems.count()).toBe(2000)
    expect(await db.words.where('deckId').equals(deck.id).count()).toBe(wordCount)
  }, 120_000)

  it('完整备份体积预检：超上限直接拒绝（不构建 Blob），未超可正常导出', async () => {
    await setupLargeFixture()
    const opts = { includeReviewLogs: false, includeDerivationMaps: true, includeContentPacks: true }
    const estimate = await estimateMigrationBytes(opts)
    expect(estimate.bytes).toBeGreaterThan(0)
    expect(estimate.breakdown.derivationMaps).toBeGreaterThan(0)
    expect(estimate.breakdown.packItems).toBeGreaterThan(0)
    await expect(exportMigration({ ...opts, maxBytes: 1000 })).rejects.toBeInstanceOf(MigrationTooLargeError)
    await expect(exportMigration({ ...opts, maxBytes: 1000 })).rejects.toThrow(/已取消|分项/)
    const blob = await exportMigration({ ...opts, maxBytes: 100 * 1024 * 1024 })
    expect(blob.size).toBeGreaterThan(estimate.bytes * 0.5)
    // 轻量备份不受影响（不传 maxBytes 也可导出）
    const lightBlob = await exportMigration({ includeReviewLogs: false })
    expect(lightBlob.size).toBeGreaterThan(0)
    expect(lightBlob.size).toBeLessThan(blob.size)
  }, 120_000)

  it('merge 导入旧包（缺新字段）保留本机 derivationMap/nc；完整包可恢复内容包', async () => {
    const { deck } = await setupLargeFixture()
    const db = getDb()
    const full = await buildMigrationFile({
      includeReviewLogs: false,
      includeDerivationMaps: true,
      includeContentPacks: true,
    })
    const legacy = JSON.parse(JSON.stringify(full)) as typeof full
    for (const word of legacy.data.words) {
      delete (word as { derivationMap?: unknown }).derivationMap
      delete (word as { ncMeaningIds?: unknown }).ncMeaningIds
      delete (word as { rootMnemonic?: unknown }).rootMnemonic
      delete (word as { rareMeaningIds?: unknown }).rareMeaningIds
    }
    const legacyData = legacy.data as typeof legacy.data & {
      contentPacks?: unknown
      packItems?: unknown
      contentRejects?: unknown
    }
    delete legacyData.contentPacks
    delete legacyData.packItems
    delete legacyData.contentRejects
    delete legacy.meta?.excluded
    const mapBefore = await getDerivationMap(`${deck.id}:w1`)
    await db.words.update(`${deck.id}:w1`, { ncMeaningIds: [`${deck.id}:w1#M1`] })
    const report = await importMigration(JSON.stringify(legacy), { strategy: 'merge', force: true })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect(await getDerivationMap(`${deck.id}:w1`)).toEqual(mapBefore)
    expect((await getWord(`${deck.id}:w1`))!.ncMeaningIds).toEqual([`${deck.id}:w1#M1`])
    expect(await db.packs.count()).toBe(1)
  }, 120_000)
})
