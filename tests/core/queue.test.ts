import { describe, expect, it } from 'vitest'
import {
  RequeueQueue,
  insertRequeue,
  isDue,
  pickQueue,
  requeueGapOf,
  retrievabilityNow,
  shuffleWith,
} from '../../src/core'
import type { WordState } from '../../src/core'
import { DAY, NOW, makeReviewed, makeState, mulberry32, seqRandom } from './helpers'

function newState(id: string, deckId = 'deck'): WordState {
  return makeState({ wordId: id, deckId })
}

describe('core/queue · pickQueue（先复习后新学 / 每日学习量=单词数）', () => {
  it('复习按遗忘程度（retrievability 升序）排序，先复习后新学', () => {
    // 三个到期词：stability 越小 → 遗忘越多 → 越靠前
    const soon = makeReviewed({ wordId: 'deck:soon', stability: 2, lastReviewedAt: NOW - 8 * DAY })
    const later = makeReviewed({ wordId: 'deck:later', stability: 30, lastReviewedAt: NOW - 8 * DAY })
    const middle = makeReviewed({ wordId: 'deck:middle', stability: 10, lastReviewedAt: NOW - 8 * DAY })
    const newWord = newState('deck:new')

    const q = pickQueue([soon, later, middle, newWord], { now: NOW, dailyGoal: 10 })
    expect(q.reviewQueue.map((s) => s.wordId)).toEqual(['deck:soon', 'deck:middle', 'deck:later'])
    expect(q.newQueue.map((s) => s.wordId)).toEqual(['deck:new'])
    expect(q.dueCount).toBe(3)
    expect(q.newBudget).toBe(7)
    expect(q.totalPlanned).toBe(4)
    // 验证排序口径：retrievabilityNow 单调不减
    const rs = q.reviewQueue.map((s) => retrievabilityNow(s, NOW))
    expect(rs).toEqual([...rs].sort((a, b) => a - b))
  })

  it('复习量超过 dailyGoal → 复习全部保留、新学为 0（task-26：不硬截断）', () => {
    const states: WordState[] = []
    for (let i = 0; i < 5; i += 1) {
      states.push(makeReviewed({ wordId: `deck:r${i}`, stability: 5 + i, lastReviewedAt: NOW - 10 * DAY }))
    }
    states.push(newState('deck:new1'), newState('deck:new2'))
    const q = pickQueue(states, { now: NOW, dailyGoal: 3 })
    expect(q.reviewQueue).toHaveLength(5) // 全部到期词，不按 goal 截断
    expect(q.newBudget).toBe(0)
    expect(q.newQueue).toHaveLength(0)
    expect(q.dueCount).toBe(5)
    expect(q.totalPlanned).toBe(5)
  })

  it('未到期 / new / suspended 不进复习队列', () => {
    const notDue = makeReviewed({ wordId: 'deck:notDue', dueAt: NOW + DAY })
    const suspended = makeReviewed({ wordId: 'deck:sus', phase: 'suspended', dueAt: NOW - DAY })
    const mastered = makeReviewed({ wordId: 'deck:mas', phase: 'mastered', dueAt: null })
    const fresh = newState('deck:new')
    const q = pickQueue([notDue, suspended, mastered, fresh], { now: NOW, dailyGoal: 5 })
    expect(q.reviewQueue).toHaveLength(0)
    expect(q.newQueue.map((s) => s.wordId)).toEqual(['deck:new'])
    expect(isDue(notDue, NOW)).toBe(false)
  })

  it('新词按 orderOf 升序；缺省 order 按 wordId 字典序', () => {
    const a = newState('deck:a')
    const b = newState('deck:b')
    const c = newState('deck:c')
    const q = pickQueue([c, a, b], {
      now: NOW,
      dailyGoal: 10,
      orderOf: { 'deck:a': 30, 'deck:b': 10, 'deck:c': 20 },
    })
    expect(q.newQueue.map((s) => s.wordId)).toEqual(['deck:b', 'deck:c', 'deck:a'])

    const q2 = pickQueue([c, a, b], { now: NOW, dailyGoal: 10 })
    expect(q2.newQueue.map((s) => s.wordId)).toEqual(['deck:a', 'deck:b', 'deck:c'])
  })

  it('newOrder=random：结果与注入 random 同源可复现，且元素集合不变', () => {
    const states = ['a', 'b', 'c', 'd', 'e'].map((id) => newState(`deck:${id}`))
    const r1 = pickQueue(states, {
      now: NOW,
      dailyGoal: 10,
      newOrder: 'random',
      random: mulberry32(42),
    })
    const r2 = pickQueue(states, {
      now: NOW,
      dailyGoal: 10,
      newOrder: 'random',
      random: mulberry32(42),
    })
    expect(r1.newQueue.map((s) => s.wordId)).toEqual(r2.newQueue.map((s) => s.wordId))
    expect(new Set(r1.newQueue.map((s) => s.wordId)).size).toBe(5)
  })

  it('deckId 过滤：只取指定词库', () => {
    const a = makeReviewed({ wordId: 'deckA:a', deckId: 'deckA' })
    const b = makeReviewed({ wordId: 'deckB:b', deckId: 'deckB' })
    const n1 = newState('deckA:n1', 'deckA')
    const n2 = newState('deckB:n2', 'deckB')
    const q = pickQueue([a, b, n1, n2], { now: NOW, dailyGoal: 10, deckId: 'deckA' })
    expect(q.reviewQueue.map((s) => s.wordId)).toEqual(['deckA:a'])
    expect(q.newQueue.map((s) => s.wordId)).toEqual(['deckA:n1'])
    // null / undefined = 全部词库
    const all = pickQueue([a, b, n1, n2], { now: NOW, dailyGoal: 10, deckId: null })
    expect(all.dueCount).toBe(2)
  })

  it('extraNewWordIds：加学词不计入 dailyGoal，追加末尾且不重复', () => {
    const states = ['n1', 'n2', 'n3', 'n4'].map((id) => newState(`deck:${id}`))
    const q = pickQueue(states, {
      now: NOW,
      dailyGoal: 2,
      extraNewWordIds: ['deck:n4', 'deck:n1'],
    })
    expect(q.newBudget).toBe(2)
    expect(q.extraCount).toBe(1)
    expect(q.newQueue.map((s) => s.wordId)).toEqual(['deck:n1', 'deck:n2', 'deck:n4'])
    expect(q.totalPlanned).toBe(3)
    // 加学词只接受尚不存在的 new 词
    const q2 = pickQueue(states, { now: NOW, dailyGoal: 2, extraNewWordIds: ['nope'] })
    expect(q2.extraCount).toBe(0)
  })

  it('每日学习量 0：到期复习仍全部进队列（不硬截断），新学为 0', () => {
    const q = pickQueue([makeReviewed({ wordId: 'deck:a' }), newState('deck:n')], {
      now: NOW,
      dailyGoal: 0,
    })
    expect(q.reviewQueue).toHaveLength(1)
    expect(q.newQueue).toHaveLength(0)
    expect(q.dueCount).toBe(1)
    expect(q.totalPlanned).toBe(1)
  })

  it('shuffleWith 纯函数：不改入参、同 random 同结果', () => {
    const input = ['a', 'b', 'c', 'd']
    const out = shuffleWith(input, seqRandom([0.1, 0.9, 0.5]))
    expect(input).toEqual(['a', 'b', 'c', 'd'])
    expect(out).not.toBe(input)
    expect(new Set(out)).toEqual(new Set(input))
  })
})

describe('core/queue · 当日回炉（§3.9）', () => {
  it('回炉 gap：不认识 4、模糊 8、认识不插回', () => {
    expect(requeueGapOf('forgot')).toBe(4)
    expect(requeueGapOf('vague')).toBe(8)
    expect(requeueGapOf('familiar')).toBe(0)
    expect(requeueGapOf('forgot', { requeueGapForgot: 2 })).toBe(2)
  })

  it('insertRequeue：不认识插到当前+4、模糊插到当前+8、认识移除', () => {
    const queue = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']
    expect(insertRequeue(queue, 0, 'forgot')).toEqual([
      'b', 'c', 'd', 'e', 'a', 'f', 'g', 'h', 'i', 'j', 'k',
    ])
    expect(insertRequeue(queue, 0, 'vague')).toEqual([
      'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'a', 'j', 'k',
    ])
    expect(insertRequeue(queue, 2, 'familiar')).toEqual([
      'a', 'b', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k',
    ])
  })

  it('insertRequeue：队列尾部（gap 超出长度）插到最后，不越界', () => {
    const queue = ['a', 'b', 'c']
    expect(insertRequeue(queue, 2, 'forgot')).toEqual(['a', 'b', 'c'])
  })

  it('RequeueQueue：不认识当天再出现一次且位置 = 当前+4', () => {
    const q = new RequeueQueue(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(q.current()).toBe('a')
    const res = q.submitCurrent('forgot')
    expect(res.requeue).toBe('requeue-forgot')
    expect(q.toArray()).toEqual(['b', 'c', 'd', 'e', 'a', 'f', 'g'])
    expect(q.current()).toBe('b')
  })

  it('RequeueQueue：模糊 gap=8；认识的词不再出现', () => {
    const q = new RequeueQueue(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'])
    q.submitCurrent('familiar') // a 移除
    expect(q.toArray()).not.toContain('a')
    q.submitCurrent('vague') // 当前 b → 插到 index+8
    expect(q.toArray().indexOf('b')).toBe(8)
  })

  it('RequeueQueue：回炉词再次出现在当天队列后可再次评分（不重复无限回炉由 UI 控制）', () => {
    const q = new RequeueQueue(['a', 'b'])
    q.submitCurrent('forgot')
    expect(q.toArray()).toEqual(['b', 'a'])
    expect(q.current()).toBe('b')
    q.submitCurrent('familiar')
    expect(q.current()).toBe('a')
    q.submitCurrent('familiar')
    expect(q.current()).toBeNull()
    expect(q.remaining).toBe(0)
  })

  it('RequeueQueue：空队列 submitCurrent 返回 none', () => {
    const q = new RequeueQueue([])
    expect(q.current()).toBeNull()
    expect(q.submitCurrent('forgot')).toEqual({ requeue: 'none', requeuedAt: null })
  })
})
