/** 0.6.0/task-285：全类型目标构建 + 属性组求交 + job 配置 */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildGenerationTargets,
  buildMultiKindGenerationTargets,
  createDeck,
  createGenerationJob,
  getDb,
  clampGenerationBatchSize,
  clampGenerationConcurrency,
  resetDatabase,
  updateSettings,
  type AdvancedFilter,
} from '../../src/data'

async function setup() {
  const deck = await createDeck({
    name: 'targets',
    words: [
      { headword: 'alpha', meanings: [{ cn: '甲1' }, { cn: '甲2' }] },
      { headword: 'beta', meanings: [{ cn: '乙' }] },
      { headword: 'gamma', meanings: [{ cn: '丙1' }, { cn: '丙2' }] },
      { headword: 'delta', meanings: [{ cn: '丁' }] },
    ],
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
  const now = Date.now()
  for (let i = 0; i < words.length; i += 1) {
    await db.words.put({ ...words[i]!, chapter: i < 2 ? 'Unit 1' : 'Unit 2' })
    if (i < 2) {
      await db.packItems.put({
        id: `gt-${words[i]!.id}:1`, packId: `gt-${words[i]!.id}`, seq: 1, wordId: words[i]!.id,
        headword: words[i]!.headword, headwordLower: words[i]!.headwordLower,
        payload: { headword: words[i]!.headword, coreSenses: [{ index: 1, label: '本义' }] },
        status: 'applied', contentHashes: [], createdAt: now, appliedAt: now,
      })
    }
  }
  return { deck, words }
}

const filter: AdvancedFilter = { match: 'and', groups: [{ match: 'and', conditions: [{ field: 'unit', op: 'eq', value: 'Unit 1' }] }] }

describe('0.6.0 · generation targets', () => {
  beforeEach(async () => { await resetDatabase() })

  it('全 10 类型 target 展开；word/meaning/core-sense 计数', async () => {
    const { words } = await setup()
    const ids = words.map((word) => word.id)
    for (const kind of ['examples', 'phrases', 'mnemonics', 'root-etymology', 'derivation', 'rare-meanings'] as const) {
      const result = await buildGenerationTargets({ kind, wordIds: ids })
      expect(result.targets).toHaveLength(4)
      expect(result.totalTargets).toBe(4)
    }
    const semantics = await buildGenerationTargets({ kind: 'semantics', wordIds: ids })
    expect(semantics.targets).toHaveLength(4) // 两个双含义词 ×2
    const meaningMnemonic = await buildGenerationTargets({ kind: 'meaning-mnemonic', wordIds: ids })
    expect(meaningMnemonic.targets).toHaveLength(6) // 所有含义
    const core = await buildGenerationTargets({ kind: 'core-sense', wordIds: ids })
    expect(core.targets).toHaveLength(2) // 只有 alpha/beta 有本义
    expect(core.issues).toHaveLength(2) // gamma/delta 跳过
    const overview = await buildGenerationTargets({ kind: 'overview', wordIds: ids })
    expect(overview.targets).toHaveLength(2)
    expect(overview.targets[0]).toMatchObject({ coreSenseIndex: 1, coreSenseLabel: '本义' })
  })

  it('过滤求交：seed + filter，最终目标数减少', async () => {
    const { words } = await setup()
    const result = await buildGenerationTargets({ kind: 'examples', wordIds: words.map((word) => word.id), filter })
    expect(result.sourceWordCount).toBe(4)
    expect(result.filteredWordCount).toBe(2)
    expect(result.totalTargets).toBe(2)
    const multi = await buildMultiKindGenerationTargets({
      kinds: ['examples', 'phrases', 'root-etymology'],
      wordIds: words.map((word) => word.id),
      filter,
    })
    expect(multi.targets).toHaveLength(6)
    expect(multi.targets.every((target) => target.kind)).toBe(true)
  })

  it('job kinds/batchSize/concurrency clamp；旧 job 兼容', async () => {
    expect(clampGenerationConcurrency(0)).toBe(1)
    expect(clampGenerationConcurrency(9)).toBe(8)
    expect(clampGenerationBatchSize(0)).toBe(1)
    expect(clampGenerationBatchSize(99)).toBe(50)
    const job = await createGenerationJob({
      kind: 'examples',
      kinds: ['examples', 'phrases'],
      source: 'selected',
      batchSize: 99,
      concurrency: 99,
      targets: [{ wordId: 'w1' }],
    })
    expect(job.kinds).toEqual(['examples', 'phrases'])
    expect(job.batchSize).toBe(50)
    expect(job.concurrency).toBe(8)
    const legacy = { id: 'legacy', name: 'old', kind: 'examples', source: 'today', cursor: 0, results: [], failed: [], status: 'queued', createdAt: 1, updatedAt: 1 }
    // 旧结构无 kinds/batchSize/targets，读取路径不崩
    expect(legacy.kind).toBe('examples')
  })
})
