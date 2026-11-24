import { describe, expect, it } from 'vitest'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const page = readFileSync(
  fileURLToPath(new URL('../../src/ui/decks/GeneratePage.tsx', import.meta.url)),
  'utf8',
)

describe('task-299 0.6.0 统一词级 runner/并发批次预算', () => {
  it('词级 6 类型统一任务，写入 job 并复用 runMultiObjectGeneration', () => {
    for (const kind of ['examples', 'phrases', 'mnemonics', 'root-etymology', 'derivation', 'rare-meanings']) {
      expect(page).toContain(`'${kind}'`)
    }
    expect(page).toContain('runGenerationJob')
    expect(page).toContain('const selectedWordLevel = selectedKinds')
    expect(page).toContain('runGenerationJob')
    expect(page).toContain('createGenerationJob')
    expect(page).toContain('targets: allTargets')
    expect(page).toContain('targetKey: `${kind}:${target.wordId}${suffix}`')
    expect(page).toContain('batchSize,')
    expect(page).toContain('concurrency,')
    expect(page).toContain('maxCostPerRun: budgetYuan')
  })

  it('并发 1–8 / 批次 1–50 / 预算输入', () => {
    expect(page).toContain('min={1} max={50}')
    expect(page).toContain('Math.max(1, Math.min(50')
    expect(page).toContain('min={1} max={8}')
    expect(page).toContain('Math.max(1, Math.min(8')
    expect(page).toContain('预算 ¥')
  })
})

import 'fake-indexeddb/auto'
import { createGenerationJob, getGenerationJob, resetDatabase } from '../../src/data'

describe('task-299 job targets targetKey 持久化', () => {
  it('创建后读回 targets 带 targetKey/context 且唯一', async () => {
    await resetDatabase()
    const targets = Array.from({ length: 34 }, (_, index) => ({
      wordId: `word-${index}`,
      headword: `word${index}`,
      kind: index % 2 === 0 ? 'examples' : 'semantics',
      targetKey: `${index % 2 === 0 ? 'examples' : 'semantics'}:word-${index}${index % 2 === 0 ? '' : `#m${(index % 3) + 1}`}`,
      context: index % 2 === 0 ? {} : { meaningIndex: (index % 3) + 1 },
    }))
    const job = await createGenerationJob({
      kind: 'examples',
      source: 'test',
      targets,
      kinds: ['examples', 'semantics'],
      targetTotal: targets.length,
    })
    const read = await getGenerationJob(job.id)
    expect(read?.targets).toHaveLength(34)
    expect(read?.targets?.filter((target) => target.targetKey).length).toBe(34)
    expect(new Set(read?.targets?.map((target) => target.targetKey)).size).toBe(34)
    expect(read?.targets?.[1]?.context?.meaningIndex).toBe(2)
  })
})
