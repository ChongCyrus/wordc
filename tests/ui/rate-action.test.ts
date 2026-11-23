import { describe, expect, it, vi } from 'vitest'
import {
  decideRateSubmit,
  submitRatingByMode,
} from '../../src/ui/study/lib/rate-action'

describe('评分提交分支（task-44：回退改判走 reRateInPlan）', () => {
  it('browseBack → 调 reRateInPlan（改判），不调 rateInPlan', async () => {
    const rate = vi.fn().mockResolvedValue({ plan: { source: 'rate' } })
    const reRate = vi.fn().mockResolvedValue({ plan: { source: 're-rate' } })
    const result = await submitRatingByMode(
      { wordId: 'w1', rating: 'vague', browseBack: true },
      { rate, reRate },
    )
    expect(result).toEqual({ plan: { source: 're-rate' } })
    expect(reRate).toHaveBeenCalledWith({ wordId: 'w1', rating: 'vague' })
    expect(rate).not.toHaveBeenCalled()
  })

  it('非回退 → 调 rateInPlan（正常学习）', async () => {
    const rate = vi.fn().mockResolvedValue({ plan: { source: 'rate' } })
    const reRate = vi.fn().mockResolvedValue({ plan: { source: 're-rate' } })
    const result = await submitRatingByMode(
      { wordId: 'w2', rating: 'familiar', browseBack: false },
      { rate, reRate },
    )
    expect(result).toEqual({ plan: { source: 'rate' } })
    expect(rate).toHaveBeenCalledWith({ wordId: 'w2', rating: 'familiar' })
    expect(reRate).not.toHaveBeenCalled()
  })

  it('planId / now 透传给 data 函数', async () => {
    const rate = vi.fn().mockResolvedValue(null)
    const reRate = vi.fn().mockResolvedValue(null)
    await submitRatingByMode(
      { wordId: 'w3', rating: 'forgot', browseBack: true, planId: 'plan-1', now: 123 },
      { rate, reRate },
    )
    expect(reRate).toHaveBeenCalledWith({
      wordId: 'w3',
      rating: 'forgot',
      planId: 'plan-1',
      now: 123,
    })
  })

  it('decideRateSubmit：只有 browseBack 时为 browse-rerate', () => {
    expect(decideRateSubmit({ browseBack: true })).toBe('browse-rerate')
    expect(decideRateSubmit({ browseBack: false })).toBe('normal-rate')
  })
})
