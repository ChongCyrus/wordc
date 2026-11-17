/**
 * task-17 回归：对齐官方 help30（docs/research/01-algorithm.md §5.1）
 *
 * A) 「记忆」可反复进行：全部 c 记满后再点「记忆」→ 重置计数、重开一轮；
 * B) 同日第 1/2/3 次模糊/不认识都回炉（只改当天再出现的间隔，不改长期计划）；
 * C) `previewNext(rating, state, now)` 预览值正确（UI 按钮下方「N 天后 / 今日再出现」）。
 */
import { describe, expect, it } from 'vitest'
import {
  advanceMemory,
  createSession,
  createWordState,
  localDateKey,
  openMemory,
  previewNext,
  scheduleNext,
  tapBoard,
  tapMemory,
} from '../../src/core'
import type { Rating, SessionSettings, SessionState, WordState } from '../../src/core'
import { NOW } from './helpers'

const HOUR = 3_600_000
const DAY = 86_400_000
const WORD_ID = 'test-deck:embrace'

function makeWord() {
  return {
    wordId: WORD_ID,
    deckId: 'test-deck',
    headword: 'embrace',
    meanings: ['拥抱', '包含', '信奉'].map((cn, i) => ({
      meaningId: `${WORD_ID}#M${i + 1}`,
      pos: 'vt.',
      cn,
    })),
    phrases: [] as Array<{ en: string; cn: string }>,
  }
}

function makeSettings(overrides: Partial<SessionSettings> = {}): SessionSettings {
  return {
    totalRepeats: 3,
    mode: 'sequential',
    showPhrases: true,
    exampleCount: 2,
    showPhonetic: true,
    ...overrides,
  }
}

/** 已学过的词（review 态），lastReviewedAt 可指定为昨天（当天第一次反馈场景） */
function reviewed(overrides: Partial<WordState> = {}): WordState {
  return {
    ...createWordState({ wordId: 'deck:w', deckId: 'deck', now: NOW - 10 * DAY }),
    phase: 'review',
    stability: 30,
    difficulty: 6,
    reps: 2,
    firstSeenAt: NOW - 10 * DAY,
    lastReviewedAt: NOW - DAY,
    dueAt: NOW,
    nextIntervalDays: 5,
    sameDayCount: 0,
    sameDayDate: localDateKey(NOW - DAY),
    ...overrides,
  }
}

function runMemory(state: SessionState, random: () => number = () => 0): SessionState {
  let s = state
  for (let guard = 0; guard < 500 && s.stage === 'memory'; guard += 1) {
    s = tapMemory(s, random)
    if (s.needsAdvance) s = advanceMemory(s, random)
  }
  return s
}

function toAnnotation(state: SessionState): SessionState {
  return tapBoard(state)
}

describe('task-17 B · 同日多次模糊/不认识都可反复回炉', () => {
  it('同日第 1/2/3 次模糊：都 requeue-vague，长期状态只在第 1 次变', () => {
    // 当天第一次反馈（昨天评的 → 今天算第一次）
    const first = scheduleNext(reviewed(), 'familiar', NOW)
    expect(first.longTermUpdate).toBe(true)
    const locked = first.state // 之后同日反馈都应保持不变

    // 连续三次（链式）同一词模糊
    const r1 = scheduleNext(locked, 'vague', NOW + HOUR)
    const r2 = scheduleNext(r1.state, 'vague', NOW + 2 * HOUR)
    const r3 = scheduleNext(r2.state, 'vague', NOW + 3 * HOUR)
    const rows = [r1, r2, r3]
    expect(rows.map((r) => r.requeue)).toEqual([
      'requeue-vague',
      'requeue-vague',
      'requeue-vague',
    ])
    expect(rows.map((r) => r.longTermUpdate)).toEqual([false, false, false])
    for (const r of rows) {
      expect(r.state.stability).toBe(locked.stability)
      expect(r.state.difficulty).toBe(locked.difficulty)
      expect(r.state.dueAt).toBe(locked.dueAt)
      expect(r.state.nextIntervalDays).toBe(locked.nextIntervalDays)
    }
    // sameDayCount 递增（1 → 2 → 3 → 4），供 UI/统计参考
    expect(rows.map((r) => r.state.sameDayCount)).toEqual([2, 3, 4])
    expect(rows[2]!.state.sameDayRequeued).toBe(3)
  })

  it('同日第 1/2/3 次不认识：都 requeue-forgot，难度只在第 1 次 +2', () => {
    const first = scheduleNext(reviewed(), 'familiar', NOW)
    const locked = first.state
    const rows = [
      scheduleNext(locked, 'forgot', NOW + HOUR),
      scheduleNext(locked, 'forgot', NOW + 2 * HOUR),
      scheduleNext(locked, 'forgot', NOW + 3 * HOUR),
    ]
    expect(rows.map((r) => r.requeue)).toEqual([
      'requeue-forgot',
      'requeue-forgot',
      'requeue-forgot',
    ])
    for (const r of rows) {
      expect(r.state.difficulty).toBe(locked.difficulty) // 只第 1 次 +2
      expect(r.state.stability).toBe(locked.stability)
      expect(r.state.dueAt).toBe(locked.dueAt)
      expect(r.longTermUpdate).toBe(false)
    }
  })

  it('认识不 requeue（第 1 次与同日重复都不回炉）', () => {
    const first = scheduleNext(reviewed(), 'familiar', NOW)
    expect(first.requeue).toBe('none')
    const second = scheduleNext(first.state, 'familiar', NOW + HOUR)
    expect(second.requeue).toBe('none')
    expect(second.longTermUpdate).toBe(false)
  })

  it('「直到认识为止」：模糊/忘记可重复回炉，认识后当天不再出现', () => {
    let state = scheduleNext(reviewed(), 'familiar', NOW).state
    const kinds: string[] = []
    for (const rating of ['vague', 'forgot', 'vague', 'forgot'] as Rating[]) {
      const res = scheduleNext(state, rating, NOW + HOUR)
      kinds.push(res.requeue)
      state = res.state
    }
    expect(kinds).toEqual([
      'requeue-vague',
      'requeue-forgot',
      'requeue-vague',
      'requeue-forgot',
    ])
    const done = scheduleNext(state, 'familiar', NOW + 2 * HOUR)
    expect(done.requeue).toBe('none')
  })

  it('首次（当天第一次）模糊/不认识：至少回炉 1 次（官方口径）', () => {
    const vague = scheduleNext(reviewed(), 'vague', NOW)
    const forgot = scheduleNext(reviewed(), 'forgot', NOW)
    expect(vague.longTermUpdate).toBe(true)
    expect(forgot.longTermUpdate).toBe(true)
    expect(vague.requeue).toBe('requeue-vague')
    expect(forgot.requeue).toBe('requeue-forgot')
    expect(vague.state.nextIntervalDays).toBeGreaterThanOrEqual(1)
    expect(forgot.state.nextIntervalDays).toBe(1)
  })

  it('回炉规则可跑多轮：同一词多次 forgot 都被 RequeueQueue 重新插回队列', async () => {
    const { RequeueQueue } = await import('../../src/core')
    const q = new RequeueQueue(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'])
    const seen: string[] = []
    for (let guard = 0; guard < 60; guard += 1) {
      const cur = q.current()
      if (!cur) break
      seen.push(cur)
      if (cur === 'a') {
        // 第一次忘记 → 回炉；第二次（回炉出现后）模糊 → 再回炉；第三次认识 → 移除
        const count = seen.filter((x) => x === 'a').length
        const rating: Rating = count === 1 ? 'forgot' : count === 2 ? 'vague' : 'familiar'
        const res = q.submitCurrent(rating)
        expect(res.requeue).toBe(
          rating === 'forgot'
            ? 'requeue-forgot'
            : rating === 'vague'
              ? 'requeue-vague'
              : 'none',
        )
      } else {
        q.submitCurrent('familiar')
      }
    }
    expect(seen.filter((x) => x === 'a')).toHaveLength(3) // 共出现 3 次直到点认识
    expect(q.current()).toBeNull()
  })
})

describe('task-17 C · previewNext 预览（UI 按钮下方「N 天后 / 今日再出现」）', () => {
  it('当天第一次反馈：longTermDays = 真实提交后的长期间隔，模糊/不认识 todayRequeue=true', () => {
    const state = reviewed()
    const familiar = previewNext('familiar', state, NOW)
    const vague = previewNext('vague', state, NOW)
    const forgot = previewNext('forgot', state, NOW)

    // 与 scheduleNext 一致（预览不骗人）
    expect(familiar.longTermDays).toBe(
      scheduleNext(state, 'familiar', NOW).state.nextIntervalDays,
    )
    expect(vague.longTermDays).toBe(scheduleNext(state, 'vague', NOW).state.nextIntervalDays)
    expect(forgot.longTermDays).toBe(scheduleNext(state, 'forgot', NOW).state.nextIntervalDays)

    expect(familiar.todayRequeue).toBe('none')
    expect(vague.todayRequeue).toBe('requeue-vague')
    expect(forgot.todayRequeue).toBe('requeue-forgot')
    expect(forgot.longTermDays).toBe(1) // 「今日 · 1 天后」
  })

  it('同日再次反馈：长期计划不变 → longTermDays 保持当前 nextIntervalDays（如「78 天后」）', () => {
    const state = reviewed({
      lastReviewedAt: NOW,
      sameDayCount: 1,
      sameDayDate: localDateKey(NOW),
      nextIntervalDays: 78,
    })
    expect(previewNext('familiar', state, NOW + HOUR)).toMatchObject({
      longTermDays: 78,
      todayRequeue: 'none',
    })
    expect(previewNext('vague', state, NOW + HOUR)).toMatchObject({
      longTermDays: 78,
      todayRequeue: 'requeue-vague',
    })
    expect(previewNext('forgot', state, NOW + HOUR)).toMatchObject({
      longTermDays: 78,
      todayRequeue: 'requeue-forgot',
    })
  })

  it('新词预览：认识 21 天后（d=5 K=80）、模糊今日/2 天后（K_v=100）、不认识 1 天', () => {
    const fresh = createWordState({ wordId: 'deck:new', deckId: 'deck', now: NOW })
    expect(previewNext('familiar', fresh, NOW)).toMatchObject({ longTermDays: 21, todayRequeue: 'none' })
    expect(previewNext('vague', fresh, NOW)).toMatchObject({ longTermDays: 2, todayRequeue: 'requeue-vague' })
    expect(previewNext('forgot', fresh, NOW)).toMatchObject({ longTermDays: 1, todayRequeue: 'requeue-forgot' })
  })

  it('预览是纯函数：不改状态、不写日志', () => {
    const state = reviewed({ nextIntervalDays: 78 })
    const snapshot = JSON.stringify(state)
    const preview = previewNext('forgot', state, NOW)
    expect(JSON.stringify(state)).toBe(snapshot)
    expect(preview).toMatchObject({
      longTermDays: expect.any(Number),
      todayRequeue: 'requeue-forgot',
      first: true,
      completesToday: false,
    })
  })
})

describe('task-17 A · 记忆可反复进行（反复磨炼）', () => {
  it('完成一轮后再点「记忆」：重置计数、从 M1 重开一轮，可跑多轮', () => {
    let s = toAnnotation(createSession({ word: makeWord(), settings: makeSettings(), now: NOW }))
    s = openMemory(s)
    expect(s.activeMeaningId).toBe(`${WORD_ID}#M1`)
    s = runMemory(s)
    expect(s.stage).toBe('annotation')
    expect(s.wcCompletedOnce).toBe(true)
    expect(Object.values(s.wcCounts)).toEqual([3, 3, 3])

    // 再点「记忆」→ 重开一轮
    s = openMemory(s)
    expect(s.stage).toBe('memory')
    expect(s.activeMeaningId).toBe(`${WORD_ID}#M1`)
    expect(Object.values(s.wcCounts)).toEqual([0, 0, 0])
    expect(s.wcCompletedOnce).toBe(true) // 仅提示文案，不阻断

    s = runMemory(s)
    expect(s.stage).toBe('annotation')
    expect(Object.values(s.wcCounts)).toEqual([3, 3, 3])
  })

  it('可无限重复：连续 3 轮，每轮总点击 = totalRepeats × meanings', () => {
    let s = toAnnotation(createSession({ word: makeWord(), settings: makeSettings(), now: NOW }))
    for (let round = 1; round <= 3; round += 1) {
      s = openMemory(s)
      expect(s.stage).toBe('memory')
      let taps = 0
      for (let guard = 0; guard < 200 && s.stage === 'memory'; guard += 1) {
        s = tapMemory(s)
        taps += 1
        if (s.needsAdvance) s = advanceMemory(s, () => 0)
      }
      expect(taps).toBe(9)
      expect(Object.values(s.wcCounts)).toEqual([3, 3, 3])
      expect(s.wcCompletedOnce).toBe(true)
    }
  })

  it('随机模式同样可重开一轮（重置后重新收敛）', () => {
    let s = toAnnotation(
      createSession({ word: makeWord(), settings: makeSettings({ mode: 'random' }), now: NOW }),
    )
    s = runMemory(openMemory(s, () => 0.5))
    expect(s.stage).toBe('annotation')
    const again = openMemory(s, () => 0.5)
    expect(again.stage).toBe('memory')
    expect(Object.values(again.wcCounts)).toEqual([0, 0, 0])
    const done = runMemory(again, () => 0.5)
    expect(Object.values(done.wcCounts)).toEqual([3, 3, 3])
  })

  it('空含义词仍不进 memory（脏数据兜底不变）', () => {
    const s = toAnnotation(
      createSession({
        word: { ...makeWord(), meanings: [] },
        settings: makeSettings(),
        now: NOW,
      }),
    )
    const m = openMemory(s)
    expect(m.stage).toBe('annotation')
    expect(m.activeMeaningId).toBeNull()
  })

  it('重开一轮后快照反映的是新一轮计数（不会把旧一轮满次数写进去）', async () => {
    const { sessionSnapshot } = await import('../../src/core')
    let s = toAnnotation(createSession({ word: makeWord(), settings: makeSettings(), now: NOW }))
    s = runMemory(openMemory(s))
    s = openMemory(s) // 新一轮
    s = tapMemory(s) // 记 1 次
    const snap = sessionSnapshot(s, NOW)
    expect(snap.stage).toBe('memory')
    expect(snap.wcCounts).toEqual({
      [`${WORD_ID}#M1`]: 1,
      [`${WORD_ID}#M2`]: 0,
      [`${WORD_ID}#M3`]: 0,
    })
  })
})
