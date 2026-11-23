import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const ai = src('ui/ai/AiGeneratePanel.tsx')
const root = src('ui/ai/RootEtymologyBatchPanel.tsx')

describe('task-294 每类型属性筛选', () => {
  it('本义/助记：仅未标记不常考，与 seed 词集求交并更新目标数', () => {
    expect(ai).toContain('onlyUnmarkedRare')
    expect(ai).toContain('仅未标记不常考')
    expect(ai).toContain('queryAdvancedFilter')
    expect(ai).toContain("value: 'unmarked'")
    expect(ai).toContain('applyUnmarkedRareFilter(await buildTargetsByKind(kinds))')
    expect(ai).toContain('onlyUnmarkedRare])')
  })

  it('词根缀源：仅无词根数据 / 仅未标记不常考', () => {
    expect(root).toContain('onlyNoRoot')
    expect(root).toContain('onlyUnmarkedRare')
    expect(root).toContain('仅无词根数据')
    expect(root).toContain('仅未标记不常考')
    expect(root).toContain("rareMarkStatusOf(candidate.word) !== 'unmarked'")
    expect(root).toContain('setTotal(filteredCandidates.length)')
  })
})

import 'fake-indexeddb/auto'
import { beforeEach, describe as describeDb, expect as expectDb, it as itDb } from 'vitest'
import {
  applyRareMarkResults,
  createDeck,
  getDb,
  queryAdvancedFilter,
  resetDatabase,
  updateSettings,
} from '../../src/data'

describeDb('task-294 rare=unmarked 过滤语义', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  itDb('仅未标记不常考只命中 checked 且无 rare 的词', async () => {
    const deck = await createDeck({
      name: 'rare-filter',
      words: ['alpha', 'beta'].map((headword) => ({ headword, meanings: [{ cn: headword }] })),
    })
    await updateSettings({ 'data.selectedDeckId': deck.id })
    const words = await getDb().words.where('deckId').equals(deck.id).toArray()
    const marked = words.find((word) => word.headword === 'alpha')!
    const unmarked = words.find((word) => word.headword === 'beta')!
    await applyRareMarkResults(
      [
        { wordId: marked.id, rareMeaningIndexes: [1] },
        { wordId: unmarked.id, rareMeaningIndexes: [] },
      ],
      { now: Date.now() },
    )
    const result = await queryAdvancedFilter({
      wordIds: [marked.id, unmarked.id],
      filter: {
        match: 'and',
        groups: [{ match: 'or', conditions: [{ field: 'rare', op: 'eq', value: 'unmarked' }] }],
      },
      limit: 1000,
    })
    expectDb(result.words.map((item) => item.word.headword)).toEqual(['beta'])
  })
})
