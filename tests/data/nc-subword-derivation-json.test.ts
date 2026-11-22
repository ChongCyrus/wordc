/** task-164：nc 标记 / 引申 lines / 局部词 / 右页 JSON 导入导出 / 迁移 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getWord, resetDatabase, updateSettings } from '../../src/data'
import {
  applyApproved,
  approveItems,
  buildDerivationJson,
  buildMigrationFile,
  clearNc,
  findSubwordMeanings,
  getDerivationMap,
  getNcMeaningIds,
  importMigration,
  importPack,
  listPackItems,
  parseDerivationJson,
  saveDerivationMap,
  setNcMeaningIds,
} from '../../src/data'
import { computeChecksum } from '../../src/data/checksum'
import { packChecksumPayload } from '../../src/data/packs/schema'
import type { PackFileV1, PackItemV1 } from '../../src/data'

async function setupDeck() {
  const deck = await createDeck({
    name: 'task164',
    words: [
      { headword: 'marginal', meanings: [{ pos: 'adj.', cn: '边缘的' }, { pos: 'n.', cn: '边际' }] },
      { headword: 'margin', meanings: [{ pos: 'n.', cn: '边缘' }] },
      { headword: 'discourse', meanings: [{ pos: 'n.', cn: '话语' }] },
      { headword: 'course', meanings: [{ pos: 'n.', cn: '课程' }] },
      { headword: 'gin', meanings: [{ pos: 'n.', cn: '杜松子酒' }] },
      { headword: 'ar', meanings: [{ pos: 'n.', cn: '增强现实' }] },
      { headword: 'x', meanings: [{ pos: 'n.', cn: 'x' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

async function makePack(items: PackItemV1[], deckId: string): Promise<PackFileV1> {
  const base = {
    format: 'momo-pack' as const,
    formatVersion: 1 as const,
    kind: 'mixed' as const,
    createdAt: Date.UTC(2026, 11, 15),
    generator: 'test@task164',
    items,
    meta: { source: 'import' as const, deckId },
  }
  const checksum = (await computeChecksum(packChecksumPayload(base))).hex
  return { ...base, checksum }
}

describe('task-164 · nc 标记', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('get/set/clear；过滤非法 meaningId；AI apply 不覆盖', async () => {
    const deck = await setupDeck()
    const word = (await getWord(`${deck.id}:marginal`))!
    expect(await getNcMeaningIds(word.id)).toEqual([])
    const saved = await setNcMeaningIds(word.id, [word.meanings[1]!.id, 'bad-id', word.meanings[1]!.id])
    expect(saved).toEqual([word.meanings[1]!.id])
    expect(await getNcMeaningIds(word.id)).toEqual([word.meanings[1]!.id])

    // AI apply 内容包不覆盖 nc
    const file = await makePack(
      [{ headword: 'marginal', headwordLower: 'marginal', meaningIndex: 1, examples: [{ en: 'marginal example', cn: '例句' }] }],
      deck.id,
    )
    const imported = await importPack(JSON.stringify(file))
    const items = await listPackItems(imported.packId!)
    await approveItems(imported.packId!, items.map((item) => item.id))
    await applyApproved(imported.packId!)
    expect(await getNcMeaningIds(word.id)).toEqual([word.meanings[1]!.id])

    await clearNc(word.id)
    expect(await getNcMeaningIds(word.id)).toEqual([])
    await expect(setNcMeaningIds('missing-word', [])).rejects.toThrow(/不存在/)
  })
})

describe('task-164 · derivation lines', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('保存/读取 lines；过滤越界 meaningIndexes；迁移导出导入保留 nc+lines', async () => {
    const deck = await setupDeck()
    const word = (await getWord(`${deck.id}:marginal`))!
    const map = await saveDerivationMap(word.id, {
      rootLabel: '边缘',
      text: '- 边缘 → 边缘的\n- 边缘 → 边际',
      lines: [
        { text: '边缘 → 边缘的', meaningIndexes: [1] },
        { text: '边缘 → 边际', meaningIndexes: [2, 99, 2] },
        { text: '无效行', meaningIndexes: [99] },
      ],
      source: 'ai',
    })
    expect(map.lines).toHaveLength(2)
    expect(map.lines?.[1]?.meaningIndexes).toEqual([2])
    const reread = await getDerivationMap(word.id)
    expect(reread?.lines).toEqual(map.lines)
    expect(reread?.source).toBe('ai')

    await setNcMeaningIds(word.id, [word.meanings[0]!.id])
    const file = await buildMigrationFile({ includeReviewLogs: false, includeDerivationMaps: true })
    const text = JSON.stringify(file)
    await resetDatabase()
    await importMigration(text, { strategy: 'replace' })
    const restored = (await getWord(word.id))!
    expect(restored.derivationMap?.lines).toEqual(map.lines)
    expect(restored.ncMeaningIds).toEqual([word.meanings[0]!.id])
  })

  it('lines 全空且无其它内容 → 拒绝', async () => {
    const deck = await setupDeck()
    const word = (await getWord(`${deck.id}:margin`))!
    await expect(saveDerivationMap(word.id, { lines: [{ text: '  ', meaningIndexes: [1] }] })).rejects.toThrow(/不能为空/)
  })
})

describe('task-164 · findSubwordMeanings', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('marginal→margin/gin、discourse→course；排除自身/长度<2；按长度降序', async () => {
    const deck = await setupDeck()
    const byWordId = await findSubwordMeanings(`${deck.id}:marginal`)
    expect(byWordId.map((item) => item.headword)).toEqual(['margin', 'gin', 'ar'])
    expect(byWordId[0]).toMatchObject({ pos: 'n.', cn: '边缘' })
    expect(byWordId.some((item) => item.headword === 'ar')).toBe(true) // 长度≥2 的合法子串
    expect(byWordId.some((item) => item.headword === 'marginal')).toBe(false)

    const byHeadword = await findSubwordMeanings('discourse', deck.id)
    expect(byHeadword.map((item) => item.headword)).toEqual(['course'])
    const limited = await findSubwordMeanings('marginal', deck.id, 1)
    expect(limited).toHaveLength(1)
    expect(limited[0]!.headword).toBe('margin')
    await expect(findSubwordMeanings('marginal')).rejects.toThrow(/deckId/)
  })
})

describe('task-164 · 右页 JSON schema', () => {
  const valid = {
    format: 'wordc-derivation',
    formatVersion: 1,
    word: 'marginal',
    rootLabel: '边缘',
    text: '- 边缘 → 边缘的',
    mermaid: 'mindmap\n  root((边缘))',
    lines: [{ text: '边缘 → 边缘的', meaningIndexes: [1] }],
  }

  it('合法解析/构建', () => {
    const parsed = parseDerivationJson(JSON.stringify(valid))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.rootLabel).toBe('边缘')
    expect(parsed.value.lines).toEqual([{ text: '边缘 → 边缘的', meaningIndexes: [1] }])
    const built = buildDerivationJson('marginal', {
      rootLabel: '边缘',
      mermaid: 'mindmap',
      lines: [{ text: '边缘', meaningIndexes: [1] }],
      source: 'ai',
      updatedAt: 1,
    })
    expect(built).toMatchObject({ format: 'wordc-derivation', formatVersion: 1, word: 'marginal', rootLabel: '边缘' })
    expect(built.mermaid).toBe('mindmap')
    expect(built.lines).toEqual([{ text: '边缘', meaningIndexes: [1] }])
    expect(built).not.toHaveProperty('source')
  })

  it('非法：坏 JSON / format / 版本 / 缺 rootLabel / lines 非法', () => {
    expect(parseDerivationJson('{bad json').ok).toBe(false)
    expect(parseDerivationJson({ ...valid, format: 'x' }).ok).toBe(false)
    const wrongVersion = parseDerivationJson({ ...valid, formatVersion: 2 })
    expect(wrongVersion.ok).toBe(false)
    if (!wrongVersion.ok) expect(wrongVersion.errors.join()).toContain('formatVersion')
    expect(parseDerivationJson({ ...valid, rootLabel: '' }).ok).toBe(false)
    const badLines = parseDerivationJson({ ...valid, lines: [{ text: '', meaningIndexes: [] }] })
    expect(badLines.ok).toBe(false)
    if (!badLines.ok) expect(badLines.errors.length).toBeGreaterThan(0)
    expect(parseDerivationJson({ ...valid, lines: [{ text: 'x', meaningIndexes: ['1'] }] }).ok).toBe(false)
  })
})
