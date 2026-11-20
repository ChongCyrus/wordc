import { describe, expect, it } from 'vitest'
import {
  batchSummaryText,
  filterBatchCandidates,
} from '../../src/ui/me/BatchDerivationPanel'

describe('F11 批量生成引申图（task-170）', () => {
  it('搜索过滤：前缀优先、关键字次之、大小写不敏感', () => {
    const items = [
      { headword: 'margin' },
      { headword: 'marginal' },
      { headword: 'image' },
    ]
    expect(filterBatchCandidates(items, 'mar').map((i) => i.headword)).toEqual([
      'margin',
      'marginal',
    ])
    expect(filterBatchCandidates(items, 'IMAG').map((i) => i.headword)).toEqual(['image'])
    expect(filterBatchCandidates(items, '')).toHaveLength(3)
  })

  it('结果摘要格式', () => {
    expect(batchSummaryText({ total: 10, succeeded: 7, failed: 2, skipped: 1 })).toBe(
      '成功 7 / 失败 2 / 跳过 1（共 10）',
    )
  })
})
