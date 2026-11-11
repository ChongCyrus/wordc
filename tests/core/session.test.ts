import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SESSION_SETTINGS,
  advanceMemory,
  countsFromSnapshot,
  createSession,
  exitMemory,
  isMemoryComplete,
  markMeaning,
  normalizeSessionSettings,
  openMemory,
  remainingMemoryTaps,
  sessionSnapshot,
  shouldRecordEncounters,
  tapBoard,
  tapMemory,
} from '../../src/core'
import type { SessionSettings, SessionState } from '../../src/core'
import { mulberry32, NOW } from './helpers'

const WORD_ID = 'test-deck:embrace'

function makeWord(meanings: string[] = ['拥抱', '包含', '信奉']) {
  return {
    wordId: WORD_ID,
    deckId: 'test-deck',
    headword: 'embrace',
    phonetic: '[ɪmˈbreɪs]',
    meanings: meanings.map((cn, i) => ({
      meaningId: `${WORD_ID}#M${i + 1}`,
      pos: 'vt.',
      cn,
    })),
    phrases: [] as Array<{ en: string; cn: string }>,
  }
}

function makeSettings(overrides: Partial<SessionSettings> = {}): SessionSettings {
  return { ...DEFAULT_SESSION_SETTINGS, totalRepeats: 3, mode: 'sequential', ...overrides }
}

function makeSession(
  settings: Partial<SessionSettings> = {},
  meanings?: string[],
  savedCounts?: Record<string, number>,
): SessionState {
  return createSession({
    word: makeWord(meanings),
    settings: makeSettings(settings),
    savedCounts,
    now: NOW,
  })
}

/** 从注释面开始跑完 w-c（sequential 满次数后调 advanceMemory；random 每次 tap 自己重选） */
function runMemory(state: SessionState, random: () => number = () => 0): SessionState {
  let s = state
  for (let guard = 0; guard < 200 && s.stage === 'memory'; guard += 1) {
    s = tapMemory(s, random)
    if (s.needsAdvance) s = advanceMemory(s, random)
  }
  return s
}

const M1 = `${WORD_ID}#M1`
const M2 = `${WORD_ID}#M2`
const M3 = `${WORD_ID}#M3`

function toAnnotation(state: SessionState): SessionState {
  const tapped = tapBoard(state)
  return tapped
}

describe('core/session · 三态流程（AC3）', () => {
  it('初始状态：白板面、无 active、未记录 encounters', () => {
    const s = makeSession()
    expect(s.stage).toBe('board')
    expect(s.activeMeaningId).toBeNull()
    expect(s.wcCounts).toEqual({ [`${WORD_ID}#M1`]: 0, [`${WORD_ID}#M2`]: 0, [`${WORD_ID}#M3`]: 0 })
    expect(s.encountersRecorded).toBe(false)
    expect(s.needsAdvance).toBe(false)
    expect(s.startedAt).toBe(NOW)
  })

  it('board --tapBoard--> annotation（且 encountersRecorded 置 true）', () => {
    const s = makeSession()
    expect(shouldRecordEncounters(s)).toBe(true)
    const a = tapBoard(s)
    expect(a.stage).toBe('annotation')
    expect(a.encountersRecorded).toBe(true)
    expect(shouldRecordEncounters(a)).toBe(false)
  })

  it('sequential：3 个含义 × 总次数 3 → 计数 [3,3,3]，顺序 M1→M2→M3，结束后回注释面', () => {
    let s = toAnnotation(makeSession())
    s = openMemory(s)
    expect(s.stage).toBe('memory')
    expect(s.activeMeaningId).toBe(`${WORD_ID}#M1`)

    const order: string[] = [s.activeMeaningId!]
    for (let guard = 0; guard < 50 && s.stage === 'memory'; guard += 1) {
      s = tapMemory(s)
      if (s.needsAdvance) {
        s = advanceMemory(s, () => 0)
        if (s.stage === 'memory' && s.activeMeaningId) order.push(s.activeMeaningId)
      }
    }
    expect(s.wcCounts).toEqual({
      [`${WORD_ID}#M1`]: 3,
      [`${WORD_ID}#M2`]: 3,
      [`${WORD_ID}#M3`]: 3,
    })
    expect(order).toEqual([`${WORD_ID}#M1`, `${WORD_ID}#M2`, `${WORD_ID}#M3`])
    expect(s.stage).toBe('annotation')
    expect(s.activeMeaningId).toBeNull()
    expect(s.wcCompletedOnce).toBe(true)
    expect(isMemoryComplete(s)).toBe(true)
    expect(remainingMemoryTaps(s)).toBe(0)
  })

  it('tapMemory 满次数后只置 needsAdvance，不自动切换（UI 200ms 动画后调 advanceMemory）', () => {
    let s = openMemory(toAnnotation(makeSession()))
    s = tapMemory(s)
    expect(s.needsAdvance).toBe(false)
    s = tapMemory(s)
    expect(s.needsAdvance).toBe(false)
    s = tapMemory(s)
    expect(s.needsAdvance).toBe(true)
    expect(s.wcCounts[`${WORD_ID}#M1`]).toBe(3)
    expect(s.activeMeaningId).toBe(`${WORD_ID}#M1`)
    // 未满时 advanceMemory 幂等
    let notReady = tapMemory(openMemory(toAnnotation(makeSession())))
    const same = advanceMemory(notReady, () => 0)
    expect(same).toBe(notReady)
    // 满后 advance 才切换
    const advanced = advanceMemory(s, () => 0)
    expect(advanced.activeMeaningId).toBe(`${WORD_ID}#M2`)
    expect(advanced.needsAdvance).toBe(false)
  })

  it('tapMemory 次数封顶（连点不会超过 totalRepeats）', () => {
    let s = openMemory(toAnnotation(makeSession()))
    for (let i = 0; i < 6; i += 1) s = tapMemory(s)
    expect(s.wcCounts[`${WORD_ID}#M1`]).toBe(3)
  })

  it('exitMemory：memory → annotation，保留 wcCounts', () => {
    let s = openMemory(toAnnotation(makeSession()))
    s = tapMemory(s)
    s = tapMemory(s)
    const exited = exitMemory(s)
    expect(exited.stage).toBe('annotation')
    expect(exited.activeMeaningId).toBeNull()
    expect(exited.wcCounts[`${WORD_ID}#M1`]).toBe(2)
    // 非 memory 阶段幂等
    expect(exitMemory(exited)).toBe(exited)
  })
})

describe('core/session · mode=random（AC3，用户原文语义 2026-11-11）', () => {
  it('每次 tap 后立刻从未满全集随机选下一个 c（允许连续抽中同一个 c）', () => {
    // open: random=0.99 → unfilled[2] = M3
    let s = openMemory(toAnnotation(makeSession({ mode: 'random' })), () => 0.99)
    expect(s.stage).toBe('memory')
    expect(s.activeMeaningId).toBe(M3)

    const seqTaps = [0.0, 0.5, 0.34, 0.99, 0.0, 0.0, 0.99, 0.0, 0.0]
    const expectedActive: Array<string | null> = [
      M1, // tap1: M3→1，未满 [M1,M2,M3] idx0
      M2, // tap2: M1→1，idx1
      M2, // tap3: M2→1，idx1 → 连续抽中同一个 c
      M3, // tap4: M2→2，idx2
      M1, // tap5: M3→2，idx0
      M1, // tap6: M1→2，idx0 → 再次连续同一个 c
      M3, // tap7: M1→3 满，未满 [M2,M3] idx1
      M2, // tap8: M3→3 满，仅 [M2]
      null, // tap9: M2→3，无未满 → 回注释面
    ]
    const seen: Array<string | null> = []
    for (let i = 0; i < seqTaps.length; i += 1) {
      s = tapMemory(s, () => seqTaps[i]!)
      seen.push(s.stage === 'annotation' ? null : s.activeMeaningId)
      expect(s.needsAdvance).toBe(false) // 随机模式不再需要 advanceMemory
    }
    expect(seen).toEqual(expectedActive)
  })

  it('选择集合包含当前 c（不排除当前）：active=M2 时随机 idx=1 仍选 M2', () => {
    // open: 3 个未满，random=0.5 → M2
    let s = openMemory(toAnnotation(makeSession({ mode: 'random' })), () => 0.5)
    expect(s.activeMeaningId).toBe(M2)
    // tap：未满仍为 [M1,M2,M3]，random=0.34 → idx1 = M2（当前 c 未被排除）
    s = tapMemory(s, () => 0.34)
    expect(s.activeMeaningId).toBe(M2)
    expect(s.wcCounts[M2]).toBe(1)
  })

  it('一轮总点击次数 = totalRepeats × meanings.length，最终全部填满（随机收敛）', () => {
    for (const seed of [1, 7, 42, 2026]) {
      let s = openMemory(toAnnotation(makeSession({ mode: 'random' })), mulberry32(seed))
      let taps = 0
      for (let guard = 0; guard < 200 && s.stage === 'memory'; guard += 1) {
        s = tapMemory(s, mulberry32(seed + taps))
        taps += 1
        // 随机模式下 tap 后 active 已切换；needsAdvance 恒为 false
        expect(s.needsAdvance).toBe(false)
      }
      expect(taps).toBe(9)
      expect(s.stage).toBe('annotation')
      expect(s.wcCompletedOnce).toBe(true)
      expect(Object.values(s.wcCounts)).toEqual([3, 3, 3])
    }
  })

  it('与 sequential 对比：相同点击次数、结束状态一致', () => {
    // sequential
    let seqState = openMemory(toAnnotation(makeSession({ mode: 'sequential' })))
    let seqTaps = 0
    for (let guard = 0; guard < 200 && seqState.stage === 'memory'; guard += 1) {
      seqState = tapMemory(seqState, () => 0)
      seqTaps += 1
      if (seqState.needsAdvance) seqState = advanceMemory(seqState, () => 0)
    }
    // random
    let rndState = openMemory(toAnnotation(makeSession({ mode: 'random' })), mulberry32(99))
    let rndTaps = 0
    for (let guard = 0; guard < 200 && rndState.stage === 'memory'; guard += 1) {
      rndState = tapMemory(rndState, mulberry32(99 + rndTaps))
      rndTaps += 1
    }
    expect(seqTaps).toBe(9)
    expect(rndTaps).toBe(9)
    expect(rndState.stage).toBe(seqState.stage)
    expect(rndState.wcCounts).toEqual(seqState.wcCounts)
    expect(rndState.wcCompletedOnce).toBe(seqState.wcCompletedOnce)
  })

  it('边界 totalRepeats=1：每个 c 点一次就填满，随机每步换 c，共 3 次点击', () => {
    let s = openMemory(toAnnotation(makeSession({ mode: 'random', totalRepeats: 1 })), () => 0.99)
    expect(s.activeMeaningId).toBe(M3)
    let taps = 0
    const actives: Array<string | null> = []
    for (let guard = 0; guard < 20 && s.stage === 'memory'; guard += 1) {
      s = tapMemory(s, () => 0)
      taps += 1
      actives.push(s.stage === 'annotation' ? null : s.activeMeaningId)
    }
    expect(taps).toBe(3)
    expect(actives).toEqual([M1, M2, null])
    expect(Object.values(s.wcCounts)).toEqual([1, 1, 1])
  })

  it('单含义随机模式等价 sequential：始终同一个 c，满后回注释面', () => {
    let s = openMemory(toAnnotation(makeSession({ mode: 'random' }, ['唯一释义'])), () => 0)
    expect(s.activeMeaningId).toBe(`${WORD_ID}#M1`)
    let taps = 0
    for (let guard = 0; guard < 20 && s.stage === 'memory'; guard += 1) {
      s = tapMemory(s, () => 0)
      taps += 1
      if (s.stage === 'memory') expect(s.activeMeaningId).toBe(`${WORD_ID}#M1`)
    }
    expect(taps).toBe(3)
    expect(s.stage).toBe('annotation')
    expect(s.wcCounts[`${WORD_ID}#M1`]).toBe(3)
  })

  it('完成后可重开一轮（task-17 行为不回归）：随机模式同样重置计数', () => {
    let s = openMemory(toAnnotation(makeSession({ mode: 'random' })), mulberry32(5))
    s = runMemory(s, mulberry32(5))
    expect(s.stage).toBe('annotation')
    expect(Object.values(s.wcCounts)).toEqual([3, 3, 3])

    const again = openMemory(s, mulberry32(6))
    expect(again.stage).toBe('memory')
    expect(Object.values(again.wcCounts)).toEqual([0, 0, 0])
    const done = runMemory(again, mulberry32(6))
    expect(done.stage).toBe('annotation')
    expect(Object.values(done.wcCounts)).toEqual([3, 3, 3])
  })
})

describe('core/session · 总次数边界（AC3）', () => {
  it('totalRepeats=1：每次 tap 即切换，3 个含义 3 次 tap 完成', () => {
    let s = openMemory(toAnnotation(makeSession({ totalRepeats: 1 })))
    let taps = 0
    for (let guard = 0; guard < 20 && s.stage === 'memory'; guard += 1) {
      s = tapMemory(s)
      taps += 1
      if (s.needsAdvance) s = advanceMemory(s, () => 0)
    }
    expect(taps).toBe(3)
    expect(s.stage).toBe('annotation')
    expect(Object.values(s.wcCounts)).toEqual([1, 1, 1])
  })

  it('totalRepeats=10：3 个含义 30 次 tap 完成', () => {
    let s = openMemory(toAnnotation(makeSession({ totalRepeats: 10 })))
    let taps = 0
    for (let guard = 0; guard < 100 && s.stage === 'memory'; guard += 1) {
      s = tapMemory(s)
      taps += 1
      if (s.needsAdvance) s = advanceMemory(s, () => 0)
    }
    expect(taps).toBe(30)
    expect(Object.values(s.wcCounts)).toEqual([10, 10, 10])
  })

  it('totalRepeats 越界被 clamp 到 1–10', () => {
    expect(normalizeSessionSettings({ totalRepeats: 0 }).totalRepeats).toBe(1)
    expect(normalizeSessionSettings({ totalRepeats: 99 }).totalRepeats).toBe(10)
    expect(normalizeSessionSettings({ totalRepeats: 3.6 }).totalRepeats).toBe(4)
    expect(normalizeSessionSettings({ exampleCount: -3 }).exampleCount).toBe(0)
    expect(normalizeSessionSettings({ exampleCount: 9 }).exampleCount).toBe(3)
    expect(normalizeSessionSettings({ mode: 'bogus' as 'random' }).mode).toBe('sequential')
    const s = createSession({ word: makeWord(), settings: makeSettings({ totalRepeats: 50 }), now: NOW })
    expect(s.settings.totalRepeats).toBe(10)
  })

  it('只有 1 个含义：不切换，满后直接回注释面', () => {
    let s = openMemory(toAnnotation(makeSession({}, ['唯一释义'])))
    expect(s.activeMeaningId).toBe(`${WORD_ID}#M1`)
    for (let i = 0; i < 3; i += 1) s = tapMemory(s)
    expect(s.needsAdvance).toBe(true)
    s = advanceMemory(s, () => 0)
    expect(s.stage).toBe('annotation')
    expect(s.wcCompletedOnce).toBe(true)
    expect(s.wcCounts[`${WORD_ID}#M1`]).toBe(3)
  })
})

describe('core/session · 中断恢复（D15）', () => {
  it('savedCounts 恢复：已满含义不再出现，从未满的下一个继续', () => {
    const saved = { [`${WORD_ID}#M1`]: 3, [`${WORD_ID}#M2`]: 1 }
    const s = toAnnotation(makeSession({}, undefined, saved))
    expect(s.wcCounts[`${WORD_ID}#M1`]).toBe(3)
    expect(s.wcCounts[`${WORD_ID}#M2`]).toBe(1)
    const m = openMemory(s)
    expect(m.activeMeaningId).toBe(`${WORD_ID}#M2`)
    expect(remainingMemoryTaps(m)).toBe(2 + 3)
    const done = runMemory(m)
    expect(done.stage).toBe('annotation')
    expect(done.wcCounts).toEqual({
      [`${WORD_ID}#M1`]: 3,
      [`${WORD_ID}#M2`]: 3,
      [`${WORD_ID}#M3`]: 3,
    })
  })

  it('savedCounts 全部已满：openMemory 重置计数、重开一轮（记忆可反复磨炼）', () => {
    const saved = { [`${WORD_ID}#M1`]: 3, [`${WORD_ID}#M2`]: 3, [`${WORD_ID}#M3`]: 3 }
    const s = toAnnotation(makeSession({}, undefined, saved))
    expect(s.wcCompletedOnce).toBe(true)
    const m = openMemory(s)
    expect(m.stage).toBe('memory')
    expect(m.activeMeaningId).toBe(`${WORD_ID}#M1`)
    expect(m.wcCounts).toEqual({ [`${WORD_ID}#M1`]: 0, [`${WORD_ID}#M2`]: 0, [`${WORD_ID}#M3`]: 0 })
    expect(m.wcCompletedOnce).toBe(true) // 只用于提示文案，不阻断操作
  })

  it('savedCounts 越界/脏值被收敛（负数→0、超过总次数→总次数）', () => {
    const saved = { [`${WORD_ID}#M1`]: -5, [`${WORD_ID}#M2`]: 99 }
    const s = makeSession({}, undefined, saved)
    expect(s.wcCounts[`${WORD_ID}#M1`]).toBe(0)
    expect(s.wcCounts[`${WORD_ID}#M2`]).toBe(3)
  })

  it('snapshot → countsFromSnapshot 往返', () => {
    let s = openMemory(toAnnotation(makeSession()))
    s = tapMemory(s)
    s = tapMemory(s)
    const snap = sessionSnapshot(s, NOW + 1000)
    expect(snap.wordId).toBe(WORD_ID)
    expect(snap.deckId).toBe('test-deck')
    expect(snap.stage).toBe('memory')
    expect(snap.wcCounts).toEqual(s.wcCounts)
    expect(snap.wcActiveMeaningId).toBe(s.activeMeaningId)
    expect(snap.startedAt).toBe(NOW)
    expect(snap.updatedAt).toBe(NOW + 1000)
    // 快照是拷贝：改快照不影响会话
    snap.wcCounts[`${WORD_ID}#M1`] = 99
    expect(s.wcCounts[`${WORD_ID}#M1`]).toBe(2)
    expect(countsFromSnapshot(snap)[`${WORD_ID}#M2`]).toBe(0)
    expect(countsFromSnapshot(null)).toEqual({})
  })
})

describe('core/session · 动作幂等 / 边界', () => {
  it('阶段不匹配时动作原样返回', () => {
    const s = makeSession()
    expect(openMemory(s)).toBe(s) // board 不能直接进 memory
    expect(tapMemory(s)).toBe(s)
    expect(advanceMemory(s, () => 0)).toBe(s)
    expect(exitMemory(s)).toBe(s)

    const a = tapBoard(s)
    expect(tapBoard(a)).toBe(a) // 重复 tapBoard 幂等
    expect(markMeaning(a, 'nope')).toBe(a) // 不存在的含义原样返回
  })

  it('markMeaning 是纯 no-op（clicks 由 data 层持久化）', () => {
    const a = toAnnotation(makeSession())
    const same = markMeaning(a, `${WORD_ID}#M2`)
    expect(same).toBe(a)
  })

  it('空含义词：isMemoryComplete 视为 true，openMemory 不进入 memory', () => {
    const s = openMemory(toAnnotation(makeSession({}, [])))
    expect(s.stage).toBe('annotation')
    expect(isMemoryComplete(s)).toBe(true)
  })

  it('随机模式全部记满后自动回注释面并置 wcCompletedOnce（无需 advanceMemory）', () => {
    let s = openMemory(toAnnotation(makeSession({ mode: 'random', totalRepeats: 1 })), mulberry32(3))
    s = runMemory(s, mulberry32(3))
    expect(s.stage).toBe('annotation')
    expect(s.wcCompletedOnce).toBe(true)
  })
})

describe('core/session · 完整链路', () => {
  it('白板面→注释面→记忆→回到注释面：状态保留、不重复记 encounters', () => {
    let s = makeSession({ mode: 'sequential' })
    s = tapBoard(s) // UI 此时调 data.recordMeaningEncounters
    expect(s.stage).toBe('annotation')
    s = openMemory(s)
    s = runMemory(s)
    expect(s.stage).toBe('annotation')
    expect(s.wcCompletedOnce).toBe(true)
    expect(s.encountersRecorded).toBe(true)
    // 从注释面再点「记忆」：重置计数、重开一轮（可反复磨炼，不再锁死）
    const again = openMemory(s)
    expect(again.stage).toBe('memory')
    expect(again.activeMeaningId).toBe(`${WORD_ID}#M1`)
    expect(Object.values(again.wcCounts)).toEqual([0, 0, 0])
    expect(again.wcCompletedOnce).toBe(true)
  })

  it('未满时中途退出再进：次数保留（同一次会话内）', () => {
    let s = openMemory(toAnnotation(makeSession()))
    s = tapMemory(s)
    s = exitMemory(s)
    s = openMemory(s, () => 0)
    expect(s.activeMeaningId).toBe(`${WORD_ID}#M1`)
    expect(s.wcCounts[`${WORD_ID}#M1`]).toBe(1)
  })
})
