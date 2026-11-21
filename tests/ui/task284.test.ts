import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')
const panel = src('ui/ai/RareMeaningsBatchPanel.tsx')
const ai = src('ui/ai/AiGeneratePanel.tsx')

describe('task-281 批量不常考重构', () => {
  it('已选词来源/筛选/批次/续跑/应用新 API', () => {
    expect(ai).toContain('selectedWordIds={selectedWordIds}')
    expect(panel).toContain('selectedWordIds')
    expect(panel).toContain("['selected', `已选")
    expect(panel).toContain('getRareMarkCandidates')
    expect(panel).toContain('rareStatus')
    expect(panel).toContain('仅未检查')
    expect(panel).toContain('继续下一批')
    expect(panel).toContain('50 / 批')
    expect(panel).toContain('1000')
    expect(panel).toContain('saveRareMarkBatchJob')
    expect(panel).toContain('getRareMarkBatchJob')
    expect(panel).toContain('applyRareMarkResults')
    expect(panel).toContain('已检查')
    expect(panel).toContain('candidateTotal - candidateCounts.unchecked')
    expect(panel).toContain('{items.length === 0 ? (')
    expect(panel).toContain('标记本批')
    expect(panel).toContain('batch-derivation-apply-sep')
    expect(panel).toContain('requestTokenRef')
    expect(panel).toContain('selectedUnique')
    expect(panel).toContain('确认批量标记')
    expect(panel).toContain('含义：')
    expect(panel).toContain('本义：')
    expect(panel).toContain('selectAllPicked')
    expect(panel).toContain('本批已检查')
    expect(panel).toContain('无标记')
    expect(panel).toContain('标记本批')
    expect(panel).toContain('rareMeaningIndexes: pickedMeanings[item.wordId] ?? []')
  })
})
