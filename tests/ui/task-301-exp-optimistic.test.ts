import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createWordState } from '../../src/core'
import type { DailyPlan, Rating } from '../../src/data'
import { previewRatingPlan, rollbackPlanAfterFailure, sameOptimisticPlan } from '../../src/ui/study/lib/preview-rating-plan'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ActionBar } from '../../src/ui/study/components/ActionBar'
// @ts-expect-error 项目未装 @types/node；仅测试 node 环境读取源码
import { readFileSync } from 'node:fs'
// @ts-expect-error 同上
import { fileURLToPath } from 'node:url'

const src = (file: string) =>
  readFileSync(fileURLToPath(new URL(`../../src/${file}`, import.meta.url)), 'utf8')

function planOf(wordIds: string[]): DailyPlan {
  return {
    id: '2026-11-25:deck',
    date: '2026-11-25',
    deckId: 'deck',
    wordIds,
    index: 0,
    ratings: [],
    sources: Object.fromEntries(wordIds.map((id) => [id, 'new'])),
    createdAt: 0,
    updatedAt: 0,
    completedAt: null,
  } as unknown as DailyPlan
}

function stateOf(wordId: string) {
  return { ...createWordState({ wordId, deckId: 'deck', now: 1_000 }), lastReviewedAt: null }
}

describe('task-301 exp 乐观翻页纯函数', () => {
  it('首词：familiar 推进 index 到下一词', () => {
    const plan = planOf(['a', 'b', 'c'])
    const preview = previewRatingPlan({ plan, wordId: 'a', rating: 'familiar', state: stateOf('a'), now: 1_000 })
    expect(preview.plan.index).toBe(1)
    expect(preview.plan.completedAt).toBeNull()
    expect(preview.plan.wordIds[1]).toBe('b')
  })

  it('回炉：forgot 插入同词且 index 仍前进', () => {
    const plan = planOf(['a', 'b', 'c'])
    const preview = previewRatingPlan({ plan, wordId: 'a', rating: 'forgot', state: stateOf('a'), now: 1_000 })
    expect(preview.plan.index).toBe(1)
    expect(preview.plan.wordIds.filter((id) => id === 'a').length).toBeGreaterThan(1)
    expect(preview.plan.sources['a']).toBe('requeue')
  })

  it('完成今日：最后一词后 completedAt 置位', () => {
    const plan = planOf(['a'])
    const preview = previewRatingPlan({ plan, wordId: 'a', rating: 'familiar', state: stateOf('a'), now: 1_000 })
    expect(preview.plan.index).toBe(1)
    expect(preview.plan.completedAt).toBe(1_000)
  })

  it('连评 10 词：index 单调到完成', () => {
    let plan = planOf(Array.from({ length: 10 }, (_, i) => `w${i}`))
    let now = 1_000
    const ratings: Rating[] = ['familiar', 'vague', 'forgot']
    let steps = 0
    while (plan.completedAt == null && steps < 40) {
      const wordId = plan.wordIds[plan.index]!
      const preview = previewRatingPlan({
        plan,
        wordId,
        rating: ratings[steps % ratings.length]!,
        state: stateOf(wordId),
        now: (now += 1_000),
      })
      expect(preview.plan.index).toBeGreaterThan(plan.index)
      plan = preview.plan
      steps += 1
    }
    expect(steps).toBeGreaterThanOrEqual(10)
    expect(plan.completedAt).not.toBeNull()
  })

  it('失败回滚决策：未提交+已乐观+有 pre-plan 才回滚', () => {
    const before = planOf(['a', 'b'])
    expect(rollbackPlanAfterFailure(before, true, false)).toBe(before)
    expect(rollbackPlanAfterFailure(before, true, true)).toBeNull()
    expect(rollbackPlanAfterFailure(before, false, false)).toBeNull()
    expect(rollbackPlanAfterFailure(null, true, false)).toBeNull()
  })

  it('sameOptimisticPlan 推进一致/不一致', () => {
    const a = planOf(['a', 'b'])
    const b = { ...a, index: 1, ratings: [{ wordId: 'a', rating: 'familiar', reviewedAt: 1, longTermUpdate: true }] } as DailyPlan
    const c = { ...b, index: 0 }
    expect(sameOptimisticPlan(b, b)).toBe(true)
    expect(sameOptimisticPlan(c, b)).toBe(false)
  })
})

describe('task-301 exp hook 门闩源码', () => {
  it('先 applyPlan+loadWordAt，保存期间 submitting 保持，失败回滚', () => {
    const hook = src('ui/study/hooks/useStudySession.ts')
    expect(hook).toContain('previewRatingPlan')
    expect(hook).toContain('optimisticApplied')
    expect(hook).toContain('applyPlan(optimisticPlan)')
    expect(hook).toContain('submittingRef.current = true')
    expect(hook).toContain('applyPlan(rollbackPlan)')
    expect(hook).toContain('if (!planAlreadyShown) await loadWordAt')
    expect(hook).toContain('const rollbackPlan = rollbackPlanAfterFailure(')
    expect(hook).toContain('await loadWordAt(rollbackPlan.index, rollbackPlan, loadedSettings)')
    // 失败路径在 submitted=true 之前，不会走 scheduleProgressCheckpoint/learned 持久化
    expect(hook.indexOf('submitted = true')).toBeLessThan(hook.indexOf('scheduleProgressCheckpoint()'))
  })

  it('ActionBar ratingDisabled=true 时三键全部 disabled', () => {
    const html = renderToStaticMarkup(
      createElement(ActionBar, { onRate: () => undefined, ratingDisabled: true }),
    )
    const disabledCount = (html.match(/<button[^>]*disabled=""/g) ?? []).length
    expect(disabledCount).toBe(3)
  })
})
