/** 0.3.98/task-283：词根词缀词源分解 schema/手动优先/批量增量/删除 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyRootEtymologyResults,
  buildMigrationFile,
  createDeck,
  deleteRootEtymology,
  getDb,
  getRootEtymology,
  getRootEtymologyCandidates,
  importMigration,
  resetDatabase,
  saveRootEtymology,
  updateSettings,
  validateRootEtymologyDraft,
  ROOT_ETYMOLOGY_VERSION,
} from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'root-etym',
    words: [
      { headword: 'transport', meanings: [{ cn: '运输' }] },
      { headword: 'unbelievable', meanings: [{ cn: '难以置信' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const words = (await getDb().words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
  return { deck, words }
}

describe('0.3.98 · root etymology', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('schema/导出导入保留 rootEtymology/checkedAt/version', async () => {
    const { words } = await setup()
    await saveRootEtymology(
      words[0]!.id,
      {
        parts: [
          { type: 'prefix', text: 'trans-', meaning: '跨越' },
          { type: 'root', text: 'port', meaning: '搬运' },
        ],
        etymology: 'trans + port',
        composition: 'trans-（跨越）+ port（搬运）',
      },
      { source: 'manual', now: 111 },
    )
    const saved = (await getRootEtymology(words[0]!.id))!
    expect(saved.source).toBe('manual')
    expect(saved.parts).toHaveLength(2)
    const file = await buildMigrationFile({ includeReviewLogs: false })
    const exported = file.data.words.find((word) => word.id === words[0]!.id)!
    expect(exported.rootEtymology?.parts).toHaveLength(2)
    expect(exported.rootEtymologyCheckedAt).toBe(111)
    expect(exported.rootEtymologyVersion).toBe(ROOT_ETYMOLOGY_VERSION)
    const report = await importMigration(JSON.stringify(file), { strategy: 'replace', force: true })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    const restored = (await getRootEtymology(words[0]!.id))!
    expect(restored.parts[1]).toMatchObject({ type: 'root', text: 'port', meaning: '搬运' })
    expect(restored.source).toBe('manual')
  })

  it('AI 解析严格校验；无法确认允许空 parts+说明、拒绝编造空', () => {
    expect(
      validateRootEtymologyDraft({
        parts: [{ type: 'prefix', text: 'un-', meaning: '否定' }],
        etymology: 'un + believable',
      }),
    ).toMatchObject({ parts: [{ type: 'prefix', text: 'un-', meaning: '否定' }] })
    expect(() => validateRootEtymologyDraft({ parts: [{ type: 'bad', text: 'x', meaning: 'y' }] })).toThrow()
    expect(validateRootEtymologyDraft({ parts: [], etymology: '无法可靠确认' })).toEqual({
      parts: [],
      etymology: '无法可靠确认',
    })
    expect(() => validateRootEtymologyDraft({ parts: [] })).toThrow()
    expect(() => validateRootEtymologyDraft({})).toThrow()
    // 0.3.98 补充：part.meaning 必填，缺/空都拒绝（不能只存 text）
    expect(() =>
      validateRootEtymologyDraft({ parts: [{ type: 'prefix', text: 'un-' }], etymology: 'un + believable' }),
    ).toThrow(/meaning/)
    expect(() =>
      validateRootEtymologyDraft({
        parts: [
          { type: 'prefix', text: 'un-', meaning: '否定' },
          { type: 'root', text: 'believ', meaning: '  ' },
        ],
      }),
    ).toThrow(/meaning/)
    expect(
      validateRootEtymologyDraft({
        parts: [
          { type: 'prefix', text: 'un-', meaning: '否定' },
          { type: 'root', text: 'believ', meaning: '相信' },
          { type: 'suffix', text: '-able', meaning: '可…的' },
        ],
      }).parts,
    ).toHaveLength(3)
  })

  it('手动优先：AI apply 不覆盖 manual；无标记词写 AI + checkedAt', async () => {
    const { words } = await setup()
    const manual = await saveRootEtymology(
      words[0]!.id,
      { parts: [{ type: 'root', text: 'port', meaning: '搬运' }] },
      { source: 'manual', now: 1 },
    )
    const result = await applyRootEtymologyResults(
      [
        { wordId: words[0]!.id, parts: [{ type: 'root', text: 'fake', meaning: '编造' }] },
        { wordId: words[1]!.id, parts: [{ type: 'root', text: 'believe', meaning: '相信' }], etymology: 'un + believe' },
      ],
      { now: 222 },
    )
    expect(result.saved).toBe(1)
    expect(result.skippedManual).toBe(1)
    expect(await getRootEtymology(words[0]!.id)).toEqual(manual)
    expect(await getRootEtymology(words[1]!.id)).toMatchObject({ source: 'ai' })
    const aiWord = (await getDb().words.get(words[1]!.id))!
    expect(aiWord.rootEtymologyCheckedAt).toBe(222)
    expect(aiWord.rootEtymologyVersion).toBe(ROOT_ETYMOLOGY_VERSION)
  })

  it('批量候选增量：unchecked 过滤、0 条也 stamp、删除', async () => {
    const { deck, words } = await setup()
    const before = await getRootEtymologyCandidates({ source: 'deck', deckId: deck.id })
    expect(before.total).toBe(2)
    expect(before.counts).toEqual({ all: 2, unchecked: 2, checked: 0 })
    // 0 条结果也记 checkedAt
    await applyRootEtymologyResults([{ wordId: words[0]!.id, parts: [], etymology: '无法可靠确认' }], { now: 333 })
    expect((await getDb().words.get(words[0]!.id))!.rootEtymologyCheckedAt).toBe(333)
    expect(await getRootEtymology(words[0]!.id)).toMatchObject({ parts: [], etymology: '无法可靠确认' })
    const after = await getRootEtymologyCandidates({ source: 'deck', deckId: deck.id })
    expect(after.total).toBe(1)
    expect(after.words[0]!.word.id).toBe(words[1]!.id)
    expect(after.counts).toEqual({ all: 2, unchecked: 1, checked: 1 })
    // 分页不截断
    const page = await getRootEtymologyCandidates({ source: 'selected', wordIds: words.map((w) => w.id), status: 'all', limit: 1, offset: 1 })
    expect(page.total).toBe(2)
    expect(page.words).toHaveLength(1)
    // 删除
    await saveRootEtymology(words[1]!.id, { parts: [{ type: 'root', text: 'believe', meaning: '相信' }] }, { source: 'manual' })
    await deleteRootEtymology(words[1]!.id)
    expect(await getRootEtymology(words[1]!.id)).toBeNull()
  })
})
