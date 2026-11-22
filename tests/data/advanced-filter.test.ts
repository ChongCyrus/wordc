/** 0.4.0/task-283 B1：高级筛选组关系/条件/分组/分页 + 保存索引集 */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  applyRareMarkResults,
  buildInitialState,
  createDeck,
  deleteFilterSet,
  getDb,
  listSavedFilterSets,
  queryAdvancedFilter,
  renameFilterSet,
  resetDatabase,
  saveFilterSet,
  saveRootEtymology,
  updateSettings,
  type AdvancedFilter,
} from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'filter',
    words: ['alpha', 'beta', 'gamma', 'delta'].map((headword) => ({ headword, meanings: [{ cn: headword }] })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
  const now = Date.now()
  for (let i = 0; i < words.length; i += 1) {
    await db.words.put({ ...words[i]!, chapter: i < 2 ? 'Unit 1' : 'Unit 2' })
    if (i < 2) {
      await db.states.put({
        ...buildInitialState(words[i]!, now),
        phase: 'review',
        meaningStats: { [words[i]!.meanings[0]!.id]: { clicks: i, encounters: 4 } },
      })
    }
  }
  await applyRareMarkResults([{ wordId: words[0]!.id, rareMeaningIndexes: [1] }], { now })
  await saveRootEtymology(words[1]!.id, { parts: [{ type: 'root', text: 'bet', meaning: '字母' }] }, { source: 'manual', now })
  return { deck, words }
}

const filter = (groups: AdvancedFilter['groups'], match: AdvancedFilter['match'] = 'and'): AdvancedFilter => ({ match, groups })

describe('0.4.0 · advanced filter B1', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('组内 OR / 组间 AND/OR、多组', async () => {
    const { deck } = await setup()
    // 组1 OR：Unit1 或 Unit2 → 全部；组2 Unit2 → 2
    const andResult = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([
        { match: 'or', conditions: [{ field: 'unit', op: 'eq', value: 'Unit 1' }, { field: 'unit', op: 'eq', value: 'Unit 2' }] },
        { match: 'and', conditions: [{ field: 'unit', op: 'eq', value: 'Unit 2' }] },
      ]),
    })
    expect(andResult.total).toBe(2)
    const orResult = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter(
        [
          { match: 'and', conditions: [{ field: 'unit', op: 'eq', value: 'Unit 1' }] },
          { match: 'and', conditions: [{ field: 'learned', op: 'eq', value: false }] },
        ],
        'or',
      ),
    })
    expect(orResult.total).toBe(4) // U1(2) ∪ 未学(2) = 全部
  })

  it('不熟上下界、rare、etymology、排序/分组/分页 total', async () => {
    const { deck, words } = await setup()
    const between = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([
        { match: 'and', conditions: [{ field: 'familiarity', op: 'between', min: 0, max: 0.5 }] },
      ]),
    })
    expect(between.total).toBe(2) // alpha 0, beta .25
    const rare = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([{ match: 'and', conditions: [{ field: 'rare', op: 'eq', value: 'marked' }] }]),
    })
    expect(rare.total).toBe(1)
    const etym = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([{ match: 'and', conditions: [{ field: 'etymology', op: 'eq', value: 'manual' }] }]),
    })
    expect(etym.total).toBe(1)
    expect(etym.words[0]!.word.id).toBe(words[1]!.id)
    const paged = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([]),
      sort: 'alpha',
      groupBy: 'chapter',
      limit: 2,
      offset: 1,
    })
    expect(paged.total).toBe(4)
    expect(paged.words).toHaveLength(2)
    expect(paged.groups.map((group) => group.key).sort()).toEqual(['Unit 1', 'Unit 2'])
    expect(paged.groups.reduce((sum, group) => sum + group.count, 0)).toBe(4)
    const learned = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([{ match: 'and', conditions: [{ field: 'learned', op: 'eq', value: true }] }]),
      sort: 'familiarity',
      direction: 'desc',
    })
    expect(learned.total).toBe(2)
    expect(learned.words[0]!.word.id).toBe(words[1]!.id) // .25 > 0
  })

  it('0.4.4 多值 OR：unit=[A,B] 合并、rare 多值、重复值去重', async () => {
    const { deck } = await setup()
    const unit = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([{ match: 'and', conditions: [{ field: 'unit', op: 'eq', value: ['Unit 1', 'Unit 2', 'Unit 1'] }] }]),
    })
    expect(unit.total).toBe(4)
    const rare = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([{ match: 'and', conditions: [{ field: 'rare', op: 'eq', value: ['unmarked', 'marked', 'unmarked'] }] }]),
    })
    expect(rare.total).toBe(1) // 仅 alpha marked；其余 unchecked
    const allRare = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([{ match: 'and', conditions: [{ field: 'rare', op: 'eq', value: ['unmarked', 'marked', 'unchecked'] }] }]),
    })
    expect(allRare.total).toBe(4)
    const etym = await queryAdvancedFilter({
      deckId: deck.id,
      filter: filter([{ match: 'or', conditions: [
        { field: 'etymology', op: 'eq', value: ['manual', 'ai'] },
        { field: 'etymology', op: 'eq', value: 'none' },
      ] }]),
    })
    expect(etym.total).toBe(4)
    expect(new Set(etym.words.map((item) => item.word.id)).size).toBe(4)
  })

  it('索引集保存/重命名/删除/重名', async () => {
    const { deck } = await setup()
    const f = filter([{ match: 'and', conditions: [{ field: 'unit', op: 'eq', value: 'Unit 1' }] }])
    const saved = await saveFilterSet({
      name: 'Unit1',
      filter: f,
      sort: 'familiarity',
      direction: 'desc',
      groupBy: 'chapter',
      deckId: deck.id,
    })
    expect(saved.id).toBeTruthy()
    expect(saved).toMatchObject({ sort: 'familiarity', direction: 'desc', groupBy: 'chapter' })
    expect((await listSavedFilterSets())[0]).toMatchObject({ sort: 'familiarity', direction: 'desc', groupBy: 'chapter' })
    expect((await listSavedFilterSets())).toHaveLength(1)
    await renameFilterSet(saved.id, 'Unit1-renamed')
    expect((await listSavedFilterSets())[0]!.name).toBe('Unit1-renamed')
    // 同名更新（不新增）
    await saveFilterSet({ id: saved.id, name: 'Unit1-renamed', filter: f, deckId: deck.id })
    expect((await listSavedFilterSets())).toHaveLength(1)
    await expect(saveFilterSet({ name: 'Unit1-renamed', filter: f })).resolves.toBeTruthy() // 同名不同 id 更新已有
    expect((await listSavedFilterSets())).toHaveLength(1)
    expect(await deleteFilterSet(saved.id)).toBe(true)
    expect(await listSavedFilterSets()).toHaveLength(0)
    expect(await deleteFilterSet('nope')).toBe(false)
  })
})
