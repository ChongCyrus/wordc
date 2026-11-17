import { describe, expect, it } from 'vitest'
import {
  CORE_SENSE_MEANING_PREFIX,
  advanceWeighted,
  buildCoreSenseWeightedUnits,
  coreSenseFamiliarity,
  coreSenseStatKey,
  createSession,
  resolveCoreSenseStatKey,
  tapMemory,
  toCoreSenseSessionWord,
} from '../../src/core'
import type { MeaningStat, SessionWord } from '../../src/core'
import type { RareCoreSense } from '../../src/core/types'

const stat = (clicks: number, encounters: number): MeaningStat => ({ clicks, encounters })

describe('task-211 · 本义 stats key（JSON 可逆，label 可含任意字符）', () => {
  it('key 可逆：label 含 | / 引号 / 空格', () => {
    expect(coreSenseStatKey(1, ' 公开|宣告 ')).toBe(JSON.stringify(['公开|宣告', 1]))
    expect(coreSenseStatKey(2, 'a"b|c')).toBe(JSON.stringify(['a"b|c', 2]))
  })

  it('resolve：exact → label（重排）→ index（重命名）', () => {
    const stats: Record<string, MeaningStat> = {
      [coreSenseStatKey(1, '甲')]: stat(1, 2),
      [coreSenseStatKey(2, '乙')]: stat(3, 4),
    }
    expect(coreSenseStatKey(1, '甲')).toBe(JSON.stringify(['甲', 1]))
    // exact
    expect(resolveCoreSenseStatKey(stats, { index: 1, label: '甲' })).toBe(coreSenseStatKey(1, '甲'))
    // index 重排：当前 index=2、label 甲 → 命中旧 key（label 优先）
    expect(resolveCoreSenseStatKey(stats, { index: 2, label: '甲' })).toBe(coreSenseStatKey(1, '甲'))
    // label 重命名：当前 label=乙二、index=2 → index 兜底
    expect(resolveCoreSenseStatKey(stats, { index: 2, label: '乙二' })).toBe(coreSenseStatKey(2, '乙'))
    // 无统计
    expect(resolveCoreSenseStatKey(stats, { index: 9, label: '无' })).toBeNull()
  })

  it('coreSenseFamiliarity 复用 familiarity；encounters=0 → null', () => {
    const stats = { [coreSenseStatKey(1, '甲')]: stat(1, 4) }
    expect(coreSenseFamiliarity(stats, { index: 1, label: '甲' })).toBeCloseTo(0.25)
    expect(coreSenseFamiliarity({ [coreSenseStatKey(1, '甲')]: stat(0, 0) }, { index: 1, label: '甲' })).toBeNull()
    expect(coreSenseFamiliarity({}, { index: 1, label: '甲' })).toBeNull()
  })
})

describe('task-211 · buildCoreSenseWeightedUnits（只记本义）', () => {
  const senses = [
    { index: 1, label: '甲' },
    { index: 2, label: '乙' },
    { index: 3, label: '丙' },
  ]
  const coreSenseStats: Record<string, MeaningStat> = {
    [coreSenseStatKey(1, '甲')]: stat(1, 2), // f=0.5
    [coreSenseStatKey(3, '丙')]: stat(2, 2), // f=1
  }

  it('加权 total 用现有 weighted 设置；familiarity 独立；pseudo id 带 core: 前缀', () => {
    const r = buildCoreSenseWeightedUnits({ base: 3, coreSenses: senses, coreSenseStats })
    expect(r.hasUsable).toBe(true)
    expect(r.excludedRare).toBe(0)
    // 默认 min1 max10 k1：f 0.5→round(3*1.5)=5；无 stats→3；f1→6
    expect(r.units.map((u) => u.totalRepeats)).toEqual([5, 3, 6])
    expect(r.units[0]!.familiarity).toBeCloseTo(0.5)
    expect(r.units[1]!.familiarity).toBeNull()
    for (const unit of r.units) {
      expect(unit.sessionMeaningId).toBe(`${CORE_SENSE_MEANING_PREFIX}${unit.key}`)
      expect(r.totals[unit.sessionMeaningId]).toBe(unit.totalRepeats)
    }
  })

  it('rare 本义默认排除（label 优先 / index 兜底）；excludeRare=false 全纳入', () => {
    const rare: RareCoreSense[] = [
      { coreSenseIndex: 1, label: '甲旧label', updatedAt: 0 }, // label 不命中，index 命中 → 排除甲
      { coreSenseIndex: 99, label: '丙', updatedAt: 0 }, // label 命中 → 排除丙
    ]
    const r = buildCoreSenseWeightedUnits({ base: 3, coreSenses: senses, coreSenseStats, rareCoreSenses: rare })
    expect(r.units.map((u) => u.label)).toEqual(['乙'])
    expect(r.excludedRare).toBe(2)
    const all = buildCoreSenseWeightedUnits({
      base: 3,
      coreSenses: senses,
      coreSenseStats,
      rareCoreSenses: rare,
      excludeRare: false,
    })
    expect(all.units.map((u) => u.label)).toEqual(['甲', '乙', '丙'])
    expect(all.excludedRare).toBe(0)
  })

  it('无 coreSenses / 全 rare → hasUsable=false（UI 回退普通加权）', () => {
    expect(buildCoreSenseWeightedUnits({ base: 3, coreSenses: [] }).hasUsable).toBe(false)
    const allRare = buildCoreSenseWeightedUnits({
      base: 3,
      coreSenses: senses,
      rareCoreSenses: senses.map((s, i) => ({ coreSenseIndex: i + 1, label: s.label, updatedAt: 0 })),
    })
    expect(allRare.hasUsable).toBe(false)
    expect(allRare.units).toEqual([])
    expect(allRare.excludedRare).toBe(3)
  })

  it('脏数据：空 label/非法 index 跳过、重复 label 去重；不修改入参', () => {
    const dirty = [
      { index: 0, label: '零' },
      { index: 1, label: '  ' },
      { index: 2, label: '甲' },
      { index: 3, label: '甲' },
      { index: 4, label: '丁' },
    ]
    const r = buildCoreSenseWeightedUnits({ base: 3, coreSenses: dirty })
    expect(r.units.map((u) => u.label)).toEqual(['甲', '丁'])
    expect(dirty).toHaveLength(5)
  })
})

describe('task-211 · pseudo SessionWord 复用现有 w-c 状态机', () => {
  const word: SessionWord = {
    wordId: 'd:alpha',
    deckId: 'd',
    headword: 'alpha',
    meanings: [{ meaningId: 'd:alpha#M1', pos: 'n.', cn: '甲' }],
    phrases: [{ en: 'a phrase', cn: '短语' }],
  }

  it('toCoreSenseSessionWord：meaningId 带 core: 前缀、phrases 清空、不污染原 word', () => {
    const r = buildCoreSenseWeightedUnits({ base: 3, coreSenses: [{ index: 1, label: '甲' }, { index: 2, label: '乙' }] })
    const pseudo = toCoreSenseSessionWord(word, r.units)
    expect(pseudo.meanings.map((m) => m.cn)).toEqual(['甲', '乙'])
    expect(pseudo.meanings.every((m) => m.meaningId.startsWith(CORE_SENSE_MEANING_PREFIX))).toBe(true)
    expect(pseudo.phrases).toEqual([])
    expect(pseudo.headword).toBe('alpha')
    // 原 word 不变
    expect(word.meanings[0]!.meaningId).toBe('d:alpha#M1')
    expect(word.phrases).toHaveLength(1)
  })

  it('createSession：本义单元按各自 weightedTotal 计数，完成回注释面', async () => {
    const r = buildCoreSenseWeightedUnits({
      base: 3,
      coreSenses: [{ index: 1, label: '甲' }, { index: 2, label: '乙' }],
      coreSenseStats: { [coreSenseStatKey(1, '甲')]: stat(1, 1) }, // f=1 → 6
    })
    const pseudo = toCoreSenseSessionWord(word, r.units)
    let session = createSession({
      word: pseudo,
      settings: { totalRepeats: 3, mode: 'sequential', showPhrases: true, exampleCount: 2, showPhonetic: true },
      weightedTotals: r.totals,
    })
    // 甲 total=6，乙=3；点击甲 6 次后进入下一个
    session = { ...session, stage: 'memory', activeMeaningId: pseudo.meanings[0]!.meaningId }
    for (let i = 0; i < 6; i += 1) session = tapMemory(session)
    expect(session.needsAdvance).toBe(true)
    session = advanceWeighted(session)
    expect(session.activeMeaningId).toBe(pseudo.meanings[1]!.meaningId)
    for (let i = 0; i < 3; i += 1) session = tapMemory(session)
    session = advanceWeighted(session)
    expect(session.stage).toBe('annotation')
    expect(session.wcCompletedOnce).toBe(true)
  })
})
