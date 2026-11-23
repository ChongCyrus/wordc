/** 0.9.0/task-14：词根/缀不熟悉度/加权总次数/持久化/旧包兼容 */
import './test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  buildMigrationFile,
  createDeck,
  getDb,
  getPartStats,
  getPartTotals,
  getPartUnfamiliarity,
  importMigration,
  partStatKey,
  recordPartClick,
  recordPartEncounters,
  resetDatabase,
  saveRootEtymology,
  updateSettings,
} from '../../src/data'

const PARTS = [
  { type: 'prefix' as const, text: 'pan-', meaning: '全部' },
  { type: 'root' as const, text: 'orama', meaning: '景象' },
]

async function setup() {
  const deck = await createDeck({ name: 'part-stats', words: [{ headword: 'panorama', meanings: [{ cn: '全景' }] }] })
  await updateSettings({ 'data.selectedDeckId': deck.id })
  const word = (await getDb().words.where('deckId').equals(deck.id).toArray())[0]!
  await saveRootEtymology(word.id, { parts: PARTS, composition: 'pan + orama' }, { source: 'manual' })
  return { word }
}

describe('0.9.0 · part stats', () => {
  beforeEach(async () => { await resetDatabase() })

  it('比例/clamp/默认0/持久化', async () => {
    const { word } = await setup()
    expect(await getPartStats(word.id)).toEqual({})
    expect(await getPartUnfamiliarity(word.id, PARTS[0]!)).toBe(0)
    await recordPartEncounters(word.id, PARTS)
    await recordPartEncounters(word.id, [PARTS[0]!])
    await recordPartClick(word.id, PARTS[0]!)
    const stats = await getPartStats(word.id)
    expect(stats[partStatKey('prefix', 'pan-')]).toEqual({ clicks: 1, encounters: 2 })
    expect(await getPartUnfamiliarity(word.id, PARTS[0]!)).toBe(0.5)
    expect(await getPartUnfamiliarity(word.id, PARTS[1]!)).toBe(0)
    // clicks>encounters clamp 1
    await recordPartClick(word.id, PARTS[0]!)
    await recordPartClick(word.id, PARTS[0]!)
    expect(await getPartUnfamiliarity(word.id, PARTS[0]!)).toBe(1)
    // 持久化读回
    expect((await getDb().states.get(word.id))?.partStats?.[partStatKey('root', 'orama')]).toEqual({ clicks: 0, encounters: 1 })
  })

  it('高不熟度 → 加权次数更多', async () => {
    const { word } = await setup()
    // prefix 低不熟（clicks=0/encounters=2），root 高不熟（clicks=2/encounters=2）
    await recordPartEncounters(word.id, PARTS)
    await recordPartEncounters(word.id, PARTS)
    await recordPartClick(word.id, PARTS[1]!)
    await recordPartClick(word.id, PARTS[1]!)
    const totals = await getPartTotals(word.id, 3, { minRepeats: 1, maxRepeats: 10, strength: 1 })
    const prefixKey = partStatKey('prefix', 'pan-')
    const rootKey = partStatKey('root', 'orama')
    expect(totals[prefixKey]).toBeLessThan(totals[rootKey]!)
    expect(totals[prefixKey]).toBeGreaterThanOrEqual(1)
    expect(totals[rootKey]).toBeLessThanOrEqual(10)
    expect(await getPartTotals('missing', 3)).toEqual({})
    // 0.9.0：与含义/本义同公式——weightedMemoryTotals(base, f, settings) 一致
    const settings = { minRepeats: 1, maxRepeats: 10, strength: 1 }
    const familiarityByKey = {
      [partStatKey('prefix', 'pan-')]: await getPartUnfamiliarity(word.id, PARTS[0]!),
      [partStatKey('root', 'orama')]: await getPartUnfamiliarity(word.id, PARTS[1]!),
    }
    const { weightedMemoryTotals } = await import('../../src/core/weighted-memory')
    expect(await getPartTotals(word.id, 3, settings)).toEqual(weightedMemoryTotals(3, familiarityByKey, settings))
  })

  it('迁移包带 partStats；旧状态缺省可导入', async () => {
    const { word } = await setup()
    await recordPartEncounters(word.id, PARTS)
    const file = await buildMigrationFile({ includeReviewLogs: false })
    expect(file.data.states[0]?.partStats).toBeTruthy()
    // 旧包：删除 partStats 后强制导入
    const raw = JSON.parse(JSON.stringify(file)) as { data: { states: Array<{ partStats?: unknown }> } }
    delete raw.data.states[0]!.partStats
    const report = await importMigration(JSON.stringify(raw), { strategy: 'replace', force: true })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect((await getDb().states.get(word.id))?.partStats).toBeUndefined()
  })
})
