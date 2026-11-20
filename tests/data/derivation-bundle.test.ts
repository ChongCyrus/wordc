/** task-169：整库引申图 bundle v1 导出/导入 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import { createDeck, getDb, getWord, resetDatabase, updateSettings } from '../../src/data'
import {
  DERIVATION_BUNDLE_MAX_BYTES,
  deleteDerivationMap,
  exportAllDerivationMaps,
  getDerivationMap,
  getNcMeaningIds,
  importDerivationBundle,
  parseDerivationBundle,
  saveDerivationMap,
  setNcMeaningIds,
} from '../../src/data'

async function setupDeck() {
  const deck = await createDeck({
    name: 'bundle',
    words: [
      { headword: 'alpha', meanings: [{ pos: 'n.', cn: '甲' }, { pos: 'n.', cn: '阿尔法' }] },
      { headword: 'beta', meanings: [{ pos: 'n.', cn: '乙' }] },
      { headword: 'gamma', meanings: [{ pos: 'n.', cn: '丙' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  return deck
}

describe('task-169 · derivation bundle', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('导出→清空 map→导入恢复；nc/user 内容不被覆盖；不删未包含词', async () => {
    const deck = await setupDeck()
    const db = getDb()
    const alpha = (await getWord(`${deck.id}:alpha`))!
    const beta = (await getWord(`${deck.id}:beta`))!
    const gamma = (await getWord(`${deck.id}:gamma`))!

    const alphaMap = await saveDerivationMap(alpha.id, {
      rootLabel: '甲',
      text: '- 甲 → 第一',
      lines: [{ text: '甲 → 第一', meaningIndexes: [1] }],
      source: 'ai',
    })
    const betaMap = await saveDerivationMap(beta.id, { rootLabel: '乙', mermaid: 'mindmap\n  root((乙))' })
    await setNcMeaningIds(alpha.id, [alpha.meanings[1]!.id])
    await db.words.update(gamma.id, { derivationMap: { rootLabel: '未导出?', source: 'manual', updatedAt: 1 } })
    await deleteDerivationMap(gamma.id) // gamma 不导出

    const bundle = await exportAllDerivationMaps()
    expect(bundle.format).toBe('wordc-derivation-bundle')
    expect(bundle.formatVersion).toBe(1)
    expect(bundle.items).toHaveLength(2)
    expect(bundle.items.find((item) => item.headword === 'alpha')?.lines).toEqual([
      { text: '甲 → 第一', meaningIndexes: [1] },
    ])

    await deleteDerivationMap(alpha.id)
    await deleteDerivationMap(beta.id)
    expect(await getDerivationMap(alpha.id)).toBeNull()

    const result = await importDerivationBundle(JSON.stringify(bundle))
    expect(result).toMatchObject({ imported: 2, skipped: 0, failed: 0 })
    expect((await getDerivationMap(alpha.id))?.rootLabel).toBe('甲')
    expect((await getDerivationMap(alpha.id))?.lines).toEqual(alphaMap.lines)
    expect((await getDerivationMap(alpha.id))?.source).toBe('ai')
    expect((await getDerivationMap(beta.id))?.rootLabel).toBe('乙')
    expect(await getNcMeaningIds(alpha.id)).toEqual([alpha.meanings[1]!.id]) // nc 未被覆盖
    expect(await db.words.get(gamma.id)).toBeTruthy() // 未包含词不删
    expect((await getDerivationMap(gamma.id))).toBeNull()
    // beta source 默认 manual（bundle 缺省）
    expect((await getDerivationMap(beta.id))?.source).toBe('manual')
    expect(betaMap.rootLabel).toBe('乙')
  })

  it('匹配优先 wordId，其次 headword（同 deck 优先）；缺失词 skip 报告', async () => {
    const deck = await setupDeck()
    const alpha = (await getWord(`${deck.id}:alpha`))!
    const saved = await saveDerivationMap(alpha.id, { rootLabel: '甲' })
    const bundle = await exportAllDerivationMaps()
    const item = bundle.items[0]!
    // wordId 失效 → 用 headword 匹配到同 deck 词
    const weird = { ...bundle, items: [{ ...item, wordId: 'no-such-word', deckId: 'other-deck' }] }
    await deleteDerivationMap(alpha.id)
    const byHeadword = await importDerivationBundle(weird)
    expect(byHeadword.imported).toBe(1)
    expect((await getDerivationMap(alpha.id))?.rootLabel).toBe(saved.rootLabel)

    const withMissing = {
      ...bundle,
      items: [
        ...bundle.items,
        { headword: 'ghost', deckId: deck.id, rootLabel: '幽灵' },
      ],
    }
    const result = await importDerivationBundle(withMissing)
    expect(result.imported).toBe(1)
    expect(result.skipped).toBe(1)
    expect(result.skippedItems[0]).toMatchObject({ headword: 'ghost', reason: 'unknown-word' })
  })

  it('replace 模式同样不删词、只替换匹配项', async () => {
    const deck = await setupDeck()
    const gamma = (await getWord(`${deck.id}:gamma`))!
    const alpha = (await getWord(`${deck.id}:alpha`))!
    await saveDerivationMap(gamma.id, { rootLabel: '丙' })
    await saveDerivationMap(alpha.id, { rootLabel: '旧甲' })
    const bundle = await exportAllDerivationMaps()
    const result = await importDerivationBundle(
      JSON.stringify({ ...bundle, items: bundle.items.filter((item) => item.headword === 'gamma') }),
      { mode: 'replace' },
    )
    expect(result.imported).toBe(1)
    expect((await getDb().words.get(alpha.id))).toBeTruthy()
    expect((await getDerivationMap(alpha.id))?.rootLabel).toBe('旧甲') // 未包含不删/不改
  })

  it('非法格式/版本/空 bundle/超大文件', async () => {
    expect(parseDerivationBundle('{bad').ok).toBe(false)
    expect(parseDerivationBundle({ format: 'x', formatVersion: 1, items: [] }).ok).toBe(false)
    const wrongVersion = parseDerivationBundle({ format: 'wordc-derivation-bundle', formatVersion: 2, items: [] })
    expect(wrongVersion.ok).toBe(false)
    const empty = await importDerivationBundle({ format: 'wordc-derivation-bundle', formatVersion: 1, exportedAt: 1, items: [] })
    expect(empty).toMatchObject({ imported: 0, skipped: 0, failed: 0 })
    const tooBig = 'x'.repeat(DERIVATION_BUNDLE_MAX_BYTES + 1)
    const parsedBig = parseDerivationBundle(tooBig)
    expect(parsedBig.ok).toBe(false)
    if (!parsedBig.ok) expect(parsedBig.errors.join()).toContain('过大')
  })
})
