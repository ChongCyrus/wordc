/** 0.4.0/task-284 C1：rootEtymology bundle 导出/导入/checksum/手改保护 */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildRootEtymologyBundle,
  clearAllData,
  createDeck,
  exportRootEtymologyBundleText,
  getRootEtymology,
  importRootEtymologyBundle,
  resetDatabase,
  saveRootEtymology,
  updateSettings,
} from '../../src/data'

async function setup() {
  const deck = await createDeck({ name: 'bundle', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = (await import('../../src/data')).getDb()
  const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
  await saveRootEtymology(words[0]!.id, { parts: [{ type: 'root', text: 'alph', meaning: '首' }] }, { source: 'manual', now: 1 })
  await saveRootEtymology(words[1]!.id, { parts: [{ type: 'root', text: 'bet', meaning: '字母' }] }, { source: 'ai', now: 2 })
  return { deck, words }
}

describe('0.4.0 · root etymology bundle C1', () => {
  beforeEach(async () => { await resetDatabase() })

  it('导出格式/checksum/导入 merge，手改优先，缺词跳过', async () => {
    const { deck } = await setup()
    const bundle = await buildRootEtymologyBundle({ deckId: deck.id, now: 100 })
    expect(bundle.format).toBe('momo-root-etymology-bundle')
    expect(bundle.formatVersion).toBe(1)
    expect(bundle.items).toHaveLength(2)
    expect(bundle.checksum).toBeTruthy()
    const text = await exportRootEtymologyBundleText({ deckId: deck.id })
    // 清空 word 词源后导入
    await clearAllData()
    const deck2 = await createDeck({ name: 'bundle2', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }, { headword: 'beta', meanings: [{ cn: '乙' }] }] })
    const db = (await import('../../src/data')).getDb()
    const words2 = (await db.words.where('deckId').equals(deck2.id).toArray()).sort((a, b) => a.order - b.order)
    // bundle 的 wordId 与 deck2 不同 → 先按 headword 映射（测试：替换 wordId）
    const raw = JSON.parse(text) as { items: Array<{ wordId: string; headword: string }> }
    raw.items[0]!.wordId = words2[0]!.id
    raw.items[1]!.wordId = words2[1]!.id
    // 手改 beta
    await saveRootEtymology(words2[1]!.id, { parts: [{ type: 'root', text: 'manual', meaning: '手改' }] }, { source: 'manual' })
    const report = await importRootEtymologyBundle(JSON.stringify(raw), { force: true })
    expect(report.ok).toBe(true)
    expect(report.updated).toBe(1)
    expect(report.skippedManual).toBe(1)
    expect((await getRootEtymology(words2[0]!.id))?.parts[0]?.text).toBe('alph')
    expect((await getRootEtymology(words2[1]!.id))?.parts[0]?.text).toBe('manual')
    // 缺词
    raw.items.push({ wordId: 'missing', headword: 'missing' })
    const report2 = await importRootEtymologyBundle(JSON.stringify(raw), { force: true })
    expect(report2.skippedMissing).toBe(1)
  })

  it('checksum 错误拒绝导入', async () => {
    const { deck } = await setup()
    const bundle = await buildRootEtymologyBundle({ deckId: deck.id })
    bundle.checksum = 'bad'
    const report = await importRootEtymologyBundle(bundle)
    expect(report.ok).toBe(false)
    expect(report.issues[0]?.message).toMatch(/checksum/)
  })
})
