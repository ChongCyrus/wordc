/** 0.3.70：本义不熟悉度 coreSenseStats（key=JSON[label,index]、解析、迁移、独立于 meaningStats） */
import './test-utils'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildMigrationFile,
  coreSenseStatKey,
  createDeck,
  getCoreSenseStats,
  getDb,
  getWord,
  importMigration,
  recordCoreSenseClick,
  recordCoreSenseEncounters,
  resetDatabase,
  resolveCoreSenseStatKey,
} from '../../src/data'
import type { MeaningStat } from '../../src/core'

describe('0.3.70 · coreSenseStats', () => {
  beforeEach(async () => {
    await resetDatabase()
  })

  it('key=JSON[label,index]；resolve label 优先/index 兜底；点击不因重排重复计数', async () => {
    expect(coreSenseStatKey(1, ' 本义一 ')).toBe(JSON.stringify(['本义一', 1]))
    const stats: Record<string, MeaningStat> = {
      [coreSenseStatKey(2, '本义二')]: { clicks: 1, encounters: 3 },
    }
    // 同 label、index 变了 → label 命中旧 key
    expect(resolveCoreSenseStatKey(stats, { index: 9, label: '本义二' })).toBe(coreSenseStatKey(2, '本义二'))
    // label 不匹配 → index 兜底
    expect(resolveCoreSenseStatKey(stats, { index: 2, label: '新名' })).toBe(coreSenseStatKey(2, '本义二'))
    // 都没有 → null
    expect(resolveCoreSenseStatKey(stats, { index: 3, label: '无' })).toBeNull()

    const deck = await createDeck({ name: 'core-stats', words: [{ headword: 'alpha', meanings: [{ cn: '甲' }] }] })
    const wordId = `${deck.id}:alpha`
    let state = await recordCoreSenseEncounters(wordId, [
      { index: 1, label: '本义一' },
      { index: 2, label: '本义二' },
      { index: 2, label: '本义二' }, // 去重
      { index: 0, label: '非法' }, // 过滤
    ])
    expect(state.coreSenseStats).toEqual({
      [coreSenseStatKey(1, '本义一')]: { clicks: 0, encounters: 1 },
      [coreSenseStatKey(2, '本义二')]: { clicks: 0, encounters: 1 },
    })
    state = await recordCoreSenseClick(wordId, { index: 2, label: '本义二' })
    expect(state.coreSenseStats?.[coreSenseStatKey(2, '本义二')]).toEqual({ clicks: 1, encounters: 1 })
    // 本义重排（index 变、label 不变）点击：更新旧 key，不新增
    state = await recordCoreSenseClick(wordId, { index: 5, label: '本义二' })
    expect(Object.keys(state.coreSenseStats ?? {})).toHaveLength(2)
    expect(state.coreSenseStats?.[coreSenseStatKey(2, '本义二')]).toEqual({ clicks: 2, encounters: 1 })
    expect(state.meaningStats).toEqual({}) // 与 c 独立
  })

  it('mergeState：coreSenseStats 与本地取 max（clicks/encounters 各自）', async () => {
    const deck = await createDeck({ name: 'core-merge', words: [{ headword: 'gamma', meanings: [{ cn: '丙' }] }] })
    const wordId = `${deck.id}:gamma`
    await recordCoreSenseEncounters(wordId, [{ index: 1, label: '本义' }])
    await recordCoreSenseClick(wordId, { index: 1, label: '本义' })
    await recordCoreSenseClick(wordId, { index: 1, label: '本义' })
    const file = await buildMigrationFile({ includeReviewLogs: false })
    const key = coreSenseStatKey(1, '本义')
    const state = file.data.states.find((row) => row.wordId === wordId)!
    ;(state as { coreSenseStats: Record<string, MeaningStat> }).coreSenseStats = {
      [key]: { clicks: 5, encounters: 1 },
    }
    const report = await importMigration(JSON.stringify(file), { strategy: 'merge', force: true })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect(await getCoreSenseStats(wordId)).toEqual({ [key]: { clicks: 5, encounters: 1 } })
  })

  it('迁移往返包含 coreSenseStats；旧状态缺字段可导入', async () => {
    const deck = await createDeck({ name: 'core-migrate', words: [{ headword: 'beta', meanings: [{ cn: '乙' }] }] })
    const wordId = `${deck.id}:beta`
    await recordCoreSenseEncounters(wordId, [{ index: 1, label: '本义' }])
    await recordCoreSenseClick(wordId, { index: 1, label: '本义' })
    const file = await buildMigrationFile({ includeReviewLogs: false })
    expect((file.data.states[0] as { coreSenseStats?: unknown }).coreSenseStats).toBeTruthy()
    const text = JSON.stringify(file)
    await resetDatabase()
    const report = await importMigration(text, { strategy: 'replace' })
    expect(report.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect(await getCoreSenseStats(wordId)).toEqual({
      [coreSenseStatKey(1, '本义')]: { clicks: 1, encounters: 1 },
    })
    // 旧包缺 coreSenseStats：schema 允许，导入后 undefined
    const legacy = JSON.parse(text) as typeof file
    for (const state of legacy.data.states) delete (state as { coreSenseStats?: unknown }).coreSenseStats
    await resetDatabase()
    const legacyImport = await importMigration(JSON.stringify(legacy), { strategy: 'replace', force: true })
    expect(legacyImport.issues.filter((issue) => issue.level === 'error')).toEqual([])
    expect((await getDb().states.get(wordId))?.coreSenseStats).toBeUndefined()
    expect(await getWord(wordId)).toBeTruthy()
  })
})
