/**
 * 学习流程状态机（SPEC §4，AC3 核心）—— 与 UI 解耦的纯函数。
 *
 * 三态页面（同一路由 /study 内切换，不换路由）：
 *
 *   [board 白板面] --tapBoard--> [annotation 注释面] --openMemory--> [memory w-c]
 *        ▲                            ▲  │                              │
 *        │                     exitMemory│                              │ advanceMemory
 *        │                             └── memory（全部 c 满次数）──────┘
 *        └── submitRating 后下一词（由 UI/队列控制）
 *
 * 关键规则（D12/D13/D15/D16）：
 * - 动作幂等：阶段不对时原样返回。
 * - w-c 总次数可配（memory.totalRepeats，1–10），mode=sequential/random。
 * - 随机模式（用户原文语义，2026-11-11 修正）：**每次点击后**把当前 c 计数 +1，然后立刻从
 *   「所有 计数 < total 的 c」中**均匀随机**选下一个 active（**允许选中刚才那个 c**）；
 *   不存在未满 c 时一轮结束、回注释面（wcCompletedOnce=true）。
 *   一轮总点击次数仍 = 含义数 × total（随机只会改变顺序，不会多/少）。
 * - 中断快照：wcCounts 可由 data 层持久化，再次 createSession({savedCounts}) 恢复。
 * - `tapMemory` 满次数后只置 `needsAdvance=true`，由 UI 等动画结束再调 `advanceMemory`（D16 观感）。
 */

import { clamp } from './params'
import type { SessionSnapshot } from './types'

/** 当前设置范围（SPEC §5）：越界值读时 clamp，不抛错 */
export const TOTAL_REPEATS_MIN = 1
export const TOTAL_REPEATS_MAX = 10
export const EXAMPLE_COUNT_MIN = 0
export const EXAMPLE_COUNT_MAX = 3

export interface SessionWord {
  wordId: string
  deckId: string
  headword: string
  phonetic?: string // 已按设置挑选好的展示文本
  meanings: Array<{ meaningId: string; pos?: string; cn: string }>
  phrases: Array<{ en: string; cn: string }>
}

export interface SessionSettings {
  totalRepeats: number // memory.totalRepeats，1–10，默认 3
  mode: 'sequential' | 'random'
  showPhrases: boolean
  exampleCount: number // board.exampleCount，0–3
  showPhonetic: boolean
}

/** 默认设置（与 SPEC §5 默认值一致） */
export const DEFAULT_SESSION_SETTINGS: SessionSettings = {
  totalRepeats: 3,
  mode: 'sequential',
  showPhrases: true,
  exampleCount: 2,
  showPhonetic: true,
}

export interface SessionState {
  word: SessionWord
  settings: SessionSettings
  stage: 'board' | 'annotation' | 'memory'
  /** 当前 w-c 活动含义 id；非 memory 阶段为 null */
  activeMeaningId: string | null
  /** 每个含义的累计次数（含上次退出保留） */
  wcCounts: Record<string, number>
  /** w-c 页是否已完成过一轮（用于“记忆完成”提示） */
  wcCompletedOnce: boolean
  /** 是否已记录 encounters（一次会话只记一次，见 §4.6） */
  encountersRecorded: boolean
  startedAt: number
  /** 用于 UI 判断“刚满、待切换”，由 tapMemory 返回 */
  needsAdvance: boolean
}

type Random = () => number

function clampIndex(random: Random, length: number): number {
  if (length <= 0) return 0
  const raw = random()
  const idx = Math.floor((Number.isFinite(raw) ? raw : 0) * length)
  return clamp(idx, 0, length - 1)
}

function meaningsOf(state: SessionState): SessionWord['meanings'] {
  return state.word.meanings
}

function countOf(state: SessionState, meaningId: string): number {
  return state.wcCounts[meaningId] ?? 0
}

function totalOf(state: SessionState): number {
  return state.settings.totalRepeats
}

function unfilledOf(state: SessionState): SessionWord['meanings'] {
  const total = totalOf(state)
  return meaningsOf(state).filter((m) => countOf(state, m.meaningId) < total)
}

/** 规范化会话设置（越界 clamp；不抛错） */
export function normalizeSessionSettings(
  settings: Partial<SessionSettings> | undefined,
): SessionSettings {
  const s = { ...DEFAULT_SESSION_SETTINGS, ...(settings ?? {}) }
  return {
    totalRepeats: Math.round(
      clamp(
        Number.isFinite(s.totalRepeats) ? s.totalRepeats : DEFAULT_SESSION_SETTINGS.totalRepeats,
        TOTAL_REPEATS_MIN,
        TOTAL_REPEATS_MAX,
      ),
    ),
    mode: s.mode === 'random' ? 'random' : 'sequential',
    showPhrases: s.showPhrases !== false,
    exampleCount: Math.round(
      clamp(
        Number.isFinite(s.exampleCount) ? s.exampleCount : DEFAULT_SESSION_SETTINGS.exampleCount,
        EXAMPLE_COUNT_MIN,
        EXAMPLE_COUNT_MAX,
      ),
    ),
    showPhonetic: s.showPhonetic !== false,
  }
}

/** 创建一次词的学习会话（默认从白板面开始；savedCounts 来自中断快照） */
export function createSession(input: {
  word: SessionWord
  settings: SessionSettings
  savedCounts?: Record<string, number>
  now?: number
}): SessionState {
  const settings = normalizeSessionSettings(input.settings)
  const total = settings.totalRepeats
  const word: SessionWord = {
    ...input.word,
    meanings: input.word.meanings.map((m) => ({ ...m })),
    phrases: input.word.phrases.map((p) => ({ ...p })),
  }
  const wcCounts: Record<string, number> = {}
  for (const m of word.meanings) {
    const saved = input.savedCounts?.[m.meaningId] ?? 0
    const safe = Number.isFinite(saved) ? Math.max(0, Math.floor(saved)) : 0
    wcCounts[m.meaningId] = Math.min(safe, total)
  }
  const wcCompletedOnce =
    word.meanings.length > 0 &&
    word.meanings.every((m) => (wcCounts[m.meaningId] ?? 0) >= total)
  return {
    word,
    settings,
    stage: 'board',
    activeMeaningId: null,
    wcCounts,
    wcCompletedOnce,
    encountersRecorded: false,
    startedAt: input.now ?? Date.now(),
    needsAdvance: false,
  }
}

/** 是否应先记录 encounters：UI 在 `tapBoard` 前判断（true → 调 data.recordMeaningEncounters） */
export function shouldRecordEncounters(state: SessionState): boolean {
  return !state.encountersRecorded
}

/** board → annotation（整屏点击，300ms 防误触由 UI 做）；非 board 原样返回 */
export function tapBoard(state: SessionState): SessionState {
  if (state.stage !== 'board') return state
  return {
    ...state,
    stage: 'annotation',
    encountersRecorded: true,
    needsAdvance: false,
  }
}

/**
 * annotation → memory（选首个未满含义；random 模式随机选一个未满）。
 *
 * 记忆流程**可反复进行**（Lead 2026-11-11 用户需求，对齐“反复磨炼”）：
 * 若全部含义次数已满，则把 `wcCounts` 重置为 0 并重开一轮（而不是直接返回注释面）；
 * `wcCompletedOnce` 保留为 true，仅用于提示文案（「记忆完成（可再次点击继续）」），不再阻断操作。
 */
export function openMemory(state: SessionState, random: Random = Math.random): SessionState {
  if (state.stage !== 'annotation') return state
  let working = state
  let unfilled = unfilledOf(working)
  if (unfilled.length === 0 && working.word.meanings.length > 0) {
    // 已全部记满：重置计数、重开一轮（可反复点「记忆」）
    const wcCounts: Record<string, number> = {}
    for (const m of working.word.meanings) wcCounts[m.meaningId] = 0
    working = { ...working, wcCounts, wcCompletedOnce: true, needsAdvance: false }
    unfilled = unfilledOf(working)
  }
  if (unfilled.length === 0) {
    // 没有任何含义（脏数据兜底）：留在注释面
    return { ...working, stage: 'annotation', activeMeaningId: null, needsAdvance: false, wcCompletedOnce: true }
  }
  const active =
    working.settings.mode === 'sequential'
      ? unfilled[0]!
      : unfilled[clampIndex(random, unfilled.length)]!
  return {
    ...working,
    stage: 'memory',
    activeMeaningId: active.meaningId,
    needsAdvance: false,
  }
}

/**
 * 点击屏幕（顶栏/词组区以外）：当前 c 次数 +1。
 *
 * - sequential：满次数后置 `needsAdvance=true`，UI 等 200ms 动画后调 `advanceMemory` 切下一个 c。
 * - **random（用户原文语义）**：每次 tap 后**立刻**从「所有计数 < total 的 c」中均匀随机选
 *   下一个 active（**允许选中刚才那个 c**）；若已无未满 c → 本轮结束，直接回注释面并置
 *   `wcCompletedOnce=true`（不需要再调 advanceMemory）。
 *
 * @param random 随机源（0..1，可注入以便单测；默认 Math.random）
 */
export function tapMemory(state: SessionState, random: Random = Math.random): SessionState {
  if (state.stage !== 'memory' || state.activeMeaningId == null) return state
  const id = state.activeMeaningId
  const total = totalOf(state)
  const next = Math.min(countOf(state, id) + 1, total)
  const wcCounts = { ...state.wcCounts, [id]: next }

  if (state.settings.mode === 'random') {
    const unfilled = meaningsOf(state).filter((m) => (wcCounts[m.meaningId] ?? 0) < total)
    if (unfilled.length === 0) {
      // 一轮结束：所有 c 计数都 ≥ total → 回注释面（task-22：随机模式不再需要 advanceMemory）
      return {
        ...state,
        wcCounts,
        stage: 'annotation',
        activeMeaningId: null,
        needsAdvance: false,
        wcCompletedOnce: true,
      }
    }
    // 从未满全集里均匀随机选（包含当前 c；不排除任何未满项）
    const pick = unfilled[clampIndex(random, unfilled.length)]!
    return {
      ...state,
      wcCounts,
      activeMeaningId: pick.meaningId,
      needsAdvance: false,
    }
  }

  return { ...state, wcCounts, needsAdvance: next >= total }
}

/** needsAdvance 时切换到下一个未满 c；全部满 → 回注释面。未满时不动作（幂等） */
export function advanceMemory(state: SessionState, random: Random = Math.random): SessionState {
  if (state.stage !== 'memory' || !state.needsAdvance) return state
  const total = totalOf(state)
  const meanings = meaningsOf(state)
  const unfilled = meanings.filter((m) => countOf(state, m.meaningId) < total)
  if (unfilled.length === 0) {
    return {
      ...state,
      stage: 'annotation',
      activeMeaningId: null,
      needsAdvance: false,
      wcCompletedOnce: true,
    }
  }
  let pick: SessionWord['meanings'][number]
  if (state.settings.mode === 'sequential') {
    const len = meanings.length
    const activeIdx = state.activeMeaningId == null ? -1 : meanings.findIndex((m) => m.meaningId === state.activeMeaningId)
    const start = activeIdx < 0 ? 0 : activeIdx
    // 从当前 active 之后找第一个未满（回绕到开头）
    let found: SessionWord['meanings'][number] | undefined
    for (let k = 1; k <= len; k += 1) {
      const cand = meanings[(start + k) % len]
      if (cand && countOf(state, cand.meaningId) < total) {
        found = cand
        break
      }
    }
    pick = found ?? unfilled[0]!
  } else {
    // random 兜底：从未满全集均匀随机（允许与当前 c 相同）
    pick = unfilled[clampIndex(random, unfilled.length)]!
  }
  return {
    ...state,
    activeMeaningId: pick.meaningId,
    needsAdvance: false,
  }
}

/** memory → annotation（保留 wcCounts，不回白板面）；非 memory 原样返回 */
export function exitMemory(state: SessionState): SessionState {
  if (state.stage !== 'memory') return state
  return { ...state, stage: 'annotation', activeMeaningId: null, needsAdvance: false }
}

/**
 * 注释面点击某含义（标记不熟悉）。
 * 计数持久化由 UI 调 `data.recordMeaningClick(wordId, meaningId)` 完成；
 * core 保持纯函数，这里只做合法性校验并把状态原样返回（幂等，方便 UI 无脑调用）。
 */
export function markMeaning(state: SessionState, meaningId: string): SessionState {
  if (!meaningsOf(state).some((m) => m.meaningId === meaningId)) return state
  return state
}

/** 全部含义次数都 ≥ totalRepeats（vacuous truth：没有含义也算完成） */
export function isMemoryComplete(state: SessionState): boolean {
  const total = totalOf(state)
  return meaningsOf(state).every((m) => countOf(state, m.meaningId) >= total)
}

/** 剩余还需点击的总次数（UI 可显示进度） */
export function remainingMemoryTaps(state: SessionState): number {
  const total = totalOf(state)
  return meaningsOf(state).reduce(
    (sum, m) => sum + Math.max(0, total - countOf(state, m.meaningId)),
    0,
  )
}

/** 生成中断快照（供 data 层写 meta: session:<wordId>；D15） */
export function sessionSnapshot(state: SessionState, now: number = Date.now()): SessionSnapshot {
  return {
    wordId: state.word.wordId,
    deckId: state.word.deckId,
    wcCounts: { ...state.wcCounts },
    wcActiveMeaningId: state.activeMeaningId,
    stage: state.stage,
    startedAt: state.startedAt,
    updatedAt: now,
  }
}

/** 从快照里取出可恢复的 wcCounts（stage 不恢复：重新进入总是从白板面开始，§4.1） */
export function countsFromSnapshot(snapshot: SessionSnapshot | null | undefined): Record<string, number> {
  return snapshot?.wcCounts ? { ...snapshot.wcCounts } : {}
}
