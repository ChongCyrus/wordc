/** 0.3.95：恢复旧备份 plan.sources 兼容（legacy auto/review/manual-plan + manual/random/order） */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildMigrationFile,
  createDeck,
  getDb,
  getTodayPlan,
  importMigration,
  resetDatabase,
  updateSettings,
} from '../../src/data'
import { computeChecksum, migrationChecksumPayload } from '../../src/data/checksum'

async function setup() {
  const deck = await createDeck({
    name: 'source-compat',
    words: Array.from({ length: 5 }, (_, i) => ({ headword: `src${i}`, meanings: [{ cn: `义${i}` }] })),
  })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const db = getDb()
  const words = (await db.words.where('deckId').equals(deck.id).toArray()).sort((a, b) => a.order - b.order)
  // 构造今日 plan 含 manual/order/random 来源
  const plan = await getTodayPlan({ deckId: deck.id })
  await db.plans.put({
    ...plan,
    wordIds: words.slice(0, 3).map((word) => word.id),
    index: 0,
    sources: {
      [words[0]!.id]: 'manual',
      [words[1]!.id]: 'order',
      [words[2]!.id]: 'random',
    },
    ratings: [],
    completedAt: null,
  })
  return { deck, words, plan }
}

describe('0.3.95 · migration plan.sources 兼容', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('当前 manual/random/order 通过 import（不再被 schema 拒绝）', async () => {
    const { plan } = await setup()
    const file = await buildMigrationFile({ includeReviewLogs: false })
    const report = await importMigration(JSON.stringify(file), { strategy: 'replace', force: true })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect((await getDb().plans.get(plan.id))?.sources).toMatchObject({
      [(await getDb().plans.get(plan.id))!.wordIds[0]!]: 'manual',
    })
  })

  it('旧备份 sources auto/review/manual-plan 归一化并可恢复', async () => {
    const { plan } = await setup()
    const file = await buildMigrationFile({ includeReviewLogs: false })
    const legacy = JSON.parse(JSON.stringify(file)) as typeof file & {
      data: { plans?: Array<{ sources: Record<string, string> }> }
    }
    const planData = legacy.data.plans?.find((row) => (row as { id?: string }).id === plan.id) as
      | { sources: Record<string, string>; wordIds: string[] }
      | undefined
    expect(planData).toBeTruthy()
    planData!.sources = {
      [planData!.wordIds[0]!]: 'auto',
      [planData!.wordIds[1]!]: 'review',
      [planData!.wordIds[2]!]: 'manual-plan',
    }
    legacy.checksum = (await computeChecksum(migrationChecksumPayload(legacy))).hex
    const report = await importMigration(JSON.stringify(legacy), { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    const restored = (await getDb().plans.get(plan.id))!
    expect(restored.sources[planData!.wordIds[0]!]).toBe('goal')
    expect(restored.sources[planData!.wordIds[1]!]).toBe('goal')
    expect(restored.sources[planData!.wordIds[2]!]).toBe('manual')
  })
})
