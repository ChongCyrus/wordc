/**
 * 调度（SPEC §3.3 / §3.4 / §3.5）：把「评分」变成新的 WordState + 待写 ReviewLog。
 *
 * 定稿策略 = MaiMemo MM-3.2+ 生产口径「保留率阈值法」：
 *   nextInterval = clamp(round(-h · log2(R_target)), 1, 365)，R_target = 0.9
 *
 * 规则要点：
 * - 认识 familiar：p 走公式 2，d 不变，间隔按阈值法。
 * - 模糊 vague：  p 走公式 3，d 不变，间隔按阈值法（通常 1–5 天）。
 * - 不认识 forgot：p 走公式 3，d = min(d+2, 18)，**强制次日复习**。
 * - **只有「当天第一次反馈」影响长期调度**；同日后续评分只累计 sameDayCount、不改 h/d/dueAt/phase。
 * - 新词首次评分**绝不套答错公式**（p=1 会让 (1-p)^-0.227 = ∞）。
 * - 所有函数纯函数：不读时钟、不改入参，`now` 显式传入。
 */

import {
  initialStability,
  retrievability,
  stabilityAfterForget,
  stabilityAfterRecall,
} from './dhp'
import { clamp, clamp01, resolveParams } from './params'
import type { AlgoParams, LevelTransition, ProgressLevel } from './params'
import { addDays, localDateKey, startOfLocalDay } from './time'
import type { Rating, ReviewLog, WordState } from './types'

/** 保留率阈值策略（默认调度）：h=1.76、R=0.9 → 0.267 天 → 取整 1 */
export function intervalFromRetention(
  h: number,
  rTarget: number = 0.9,
  params?: Partial<AlgoParams>,
): number {
  const p = resolveParams(params)
  const safeH = Number.isFinite(h) && h > 0 ? h : p.stabilityMin
  const target = clamp(rTarget, 0.5, 0.99)
  const raw = -safeH * Math.log2(target)
  return clamp(Math.round(raw), p.intervalMin, p.intervalMax)
}

/** 是否到期（dueAt 是到期日 00:00 本地时间；当天任何时刻均视为到期） */
export function isDue(state: WordState, now: number): boolean {
  return (
    state.phase !== 'new' &&
    state.phase !== 'mastered' &&
    state.phase !== 'suspended' &&
    state.dueAt != null &&
    state.dueAt <= now
  )
}

/** 新词是否可进入学习队列（受 dailyGoal 配额控制） */
export function isNew(state: WordState): boolean {
  return state.phase === 'new'
}

/** 记忆持久度（对外展示，天）= 当前安排的复习间隔 */
export function memoryDurabilityDays(state: WordState): number {
  return state.nextIntervalDays
}

/** 熟知度（对外展示，0–1）= 当前回忆概率（实时计算） */
export function retrievabilityNow(state: WordState, now: number): number {
  if (state.lastReviewedAt == null) return 1
  const elapsedDays = Math.max(0, (now - state.lastReviewedAt) / 86_400_000)
  return retrievability(state.stability, elapsedDays)
}

// ============ 新词首评间隔（research 04 §11.4 候选 A） ============

/**
 * 首评「认识」对应的记忆半衰期：`h = K · h0(d)`（K=100 为拟合经验常数，**非官方值**）。
 * 与官方截图锚点（dog 78 天 / nose 56 天）同族；参数化便于 A/B 校准。
 */
export function firstFamiliarHalfLife(
  difficulty: number,
  params?: Partial<AlgoParams>,
): number {
  const q = resolveParams(params)
  const d = clamp(difficulty, q.dMin, q.dInitialMax)
  return q.firstIntervalK * initialStability(d, q)
}

/** 首评「认识」的长期间隔（天）：`clamp(round(-h·log2(R)), firstFamiliarMin, firstFamiliarMax)` */
export function firstFamiliarDays(difficulty: number, params?: Partial<AlgoParams>): number {
  const q = resolveParams(params)
  const raw = -firstFamiliarHalfLife(difficulty, q) * Math.log2(q.retentionTarget)
  return clamp(Math.round(raw), q.firstFamiliarMin, q.firstFamiliarMax)
}

/** 首评「模糊」对应的记忆半衰期：对 `K_v·h0(d)` 套答错公式（p=R_target）；K_v 与认识的 K 解耦 */
export function firstVagueHalfLife(difficulty: number, params?: Partial<AlgoParams>): number {
  const q = resolveParams(params)
  const d = clamp(difficulty, q.dMin, q.dInitialMax)
  const hv = stabilityAfterForget(d, q.firstVagueIntervalK * initialStability(d, q), q.retentionTarget, q)
  return clamp(hv, q.stabilityMin, q.stabilityMax)
}

/** 首评「模糊」的长期间隔（天）：clamp 1..7（官方截图 2~3 天） */
export function firstVagueDays(difficulty: number, params?: Partial<AlgoParams>): number {
  const q = resolveParams(params)
  const raw = -firstVagueHalfLife(difficulty, q) * Math.log2(q.retentionTarget)
  return clamp(Math.round(raw), q.firstVagueMin, q.firstVagueMax)
}

/** 首评「忘记」的长期间隔（天）：固定 1 天（官方截图锚点） */
export function firstForgetDays(params?: Partial<AlgoParams>): number {
  return resolveParams(params).firstForgetDays
}

/**
 * 官方 `is_first_show`：该词是否「首次显示」→ 决定三键标签。
 * - 默认 `labelSwitch='firstEver'`：从未反馈过（firstSeenAt == null）→ true；
 * - `labelSwitch='firstToday'`：当日首显也算（残余风险项，可配置；需传 `now` 才能判断，缺省回落 firstEver）。
 *
 * 纯函数：不读时钟，`now` 由调用方显式传入（与其它 core 函数一致）。
 */
export function isFirstShow(
  state: WordState,
  params?: Partial<AlgoParams>,
  now?: number,
): boolean {
  const q = resolveParams(params)
  const isFirstEver = state.firstSeenAt == null
  if (q.labelSwitch === 'firstToday' && now != null && state.lastReviewedAt != null) {
    return isFirstEver || localDateKey(state.lastReviewedAt) !== localDateKey(now)
  }
  return isFirstEver
}

/** 读取某状态在指定本地日期的「今日进度」（缺失史兜底 progressBase） */
function todayProgressOf(state: WordState, today: string, q: AlgoParams): number {
  if (state.todayProgressDate === today) return clamp01(state.todayProgress ?? q.progressBase)
  return q.progressBase
}

/**
 * 同日反馈后的新进度：认识 +40pp（可达 100%）、模糊 +20pp、忘记 +0。
 * 默认模糊/忘记封顶 80%（`progressFailCap`）；`allowVagueComplete=true` 时模糊也能到 100%（完成当日）。
 */
function progressAfter(rating: Rating, progress: number, q: AlgoParams): number {
  const p = clamp01(progress)
  if (rating === 'familiar') return Math.min(1, p + q.progressFamiliarStep)
  if (rating === 'vague') {
    const next = p + q.progressVagueStep
    return q.allowVagueComplete ? Math.min(1, next) : Math.min(q.progressFailCap, next)
  }
  return Math.min(q.progressFailCap, p + q.progressForgetStep)
}

// ============ 三键「今日进度%」v2 档位模型（research 04 §15.4/§15.6，D 级推算） ============

/** 取状态当前档位（1 起，clamp 到表长度；缺失按 lastRating/首评档位回退） */
function progressLevelOf(state: WordState, q: AlgoParams): number {
  const n = Math.max(1, q.progressLevels.length)
  const raw = state.todayProgressLevel
  if (Number.isFinite(raw)) return clamp(Math.round(raw as number), 1, n)
  if (state.lastRating === 'forgot') return clamp(Math.round(q.progressInitialLevelForget), 1, n)
  return clamp(Math.round(q.progressInitialLevelVague), 1, n)
}

/** 档位表行（越界兜底第一行） */
function levelRow(level: number, q: AlgoParams): ProgressLevel {
  const idx = clamp(level - 1, 0, Math.max(0, q.progressLevels.length - 1))
  return q.progressLevels[idx] ?? { name: 'fallback', vague: q.progressBase, forget: 0, familiar: 1 }
}

/** 某档位下「认识」是否完成当日（'table' 模式按档位表 familiar 列） */
function canFinishFor(level: number, state: WordState | undefined, q: AlgoParams): boolean {
  switch (q.canFinishMode) {
    case 'never':
      return false
    case 'level>=3':
      return level >= 3
    case 'afterFirstFail': {
      if (!state) return false
      const base = clamp(Math.round(q.progressInitialLevelVague), 1, Math.max(1, q.progressLevels.length))
      return level > base || state.lastRating === 'vague' || state.lastRating === 'forgot'
    }
    case 'always':
      return true
    case 'table':
    default:
      return levelRow(level, q).familiar === 'days'
  }
}

/** 同日反馈的档位转移（实测表 + `inferred` 外推） */
function levelTransitionOf(rating: Rating, level: number, q: AlgoParams): LevelTransition {
  const table =
    rating === 'familiar'
      ? q.progressOnFamiliar
      : rating === 'vague'
        ? q.progressOnVague
        : q.progressOnForget
  return table[level] ?? { to: level, inferred: true }
}

export interface ScheduleResult {
  /** 新状态（不可变更新，不修改入参） */
  state: WordState
  /** 待写入日志（id 由 Dexie 生成） */
  log: ReviewLog
  /** 是否更新了长期状态（同一天非首次反馈 = false） */
  longTermUpdate: boolean
  /** 当日回炉建议（D10/§3.9）：认识 none；模糊 requeue-vague；不认识 requeue-forgot */
  requeue: 'requeue-forgot' | 'requeue-vague' | 'none'
  /** v2：本次反馈是否「完成当日复习」（todayProgress 达 1；见 SPEC-v2 §1.3） */
  completesToday: boolean
}

/** 当日回炉建议（供 data 层的 SubmitRatingResult 透传） */
export function requeueKindOf(rating: Rating): 'requeue-forgot' | 'requeue-vague' | 'none' {
  if (rating === 'forgot') return 'requeue-forgot'
  if (rating === 'vague') return 'requeue-vague'
  return 'none'
}

function makeLog(
  prev: WordState,
  next: WordState,
  rating: Rating,
  now: number,
  opts: { longTermUpdate: boolean; p: number | null; elapsedDays: number },
): ReviewLog {
  return {
    wordId: prev.wordId,
    deckId: prev.deckId,
    rating,
    reviewedAt: now,
    stabilityBefore: prev.stability,
    difficultyBefore: prev.difficulty,
    stabilityAfter: next.stability,
    difficultyAfter: next.difficulty,
    elapsedDays: opts.elapsedDays,
    nextIntervalDays: next.nextIntervalDays,
    retrievabilityAtReview: opts.p,
    longTermUpdate: opts.longTermUpdate,
  }
}

/**
 * 计算下一次复习状态（SPEC §3.5 精确伪代码）。
 *
 * @param prev   评分前状态（纯函数，不修改）
 * @param rating 认识 / 模糊 / 不认识
 * @param now    评分时刻（epoch ms，本地时区由 time.ts 处理）
 * @param params 参数覆盖（单测注入边界值用，默认 DEFAULT_PARAMS）
 */
export function scheduleNext(
  prev: WordState,
  rating: Rating,
  now: number,
  params?: Partial<AlgoParams>,
): ScheduleResult {
  const q = resolveParams(params)
  const today = localDateKey(now)
  const isFirstEver = prev.lastReviewedAt == null
  const isFirstToday = isFirstEver || localDateKey(prev.lastReviewedAt!) !== today
  const sameDayCount = isFirstToday ? 1 : prev.sameDayCount + 1

  const elapsedDays = isFirstEver
    ? 0
    : Math.max(0, (now - prev.lastReviewedAt!) / q.dayMs)

  // 1) 当天非首次反馈：不改 h/d/dueAt/phase，只累计计数、今日进度与日志
  if (!isFirstToday) {
    const sameDayRequeued =
      rating === 'familiar' ? prev.sameDayRequeued : prev.sameDayRequeued + 1
    const todayProgress = progressAfter(rating, todayProgressOf(prev, today, q), q)
    // v2 档位模型（可选）：更新 level；v1 模式保持单标量不变
    const v2 = q.progressModelMode === 'v2-levels'
    const prevLevel = progressLevelOf(prev, q)
    const transition = levelTransitionOf(rating, prevLevel, q)
    const nextLevel = v2 && transition.to !== 'complete' ? transition.to : prevLevel
    const completesToday = v2
      ? rating === 'familiar' &&
        transition.to === 'complete' &&
        canFinishFor(prevLevel, prev, q)
      : todayProgress >= 1
    const state: WordState = {
      ...prev,
      sameDayCount,
      sameDayRequeued,
      // v1「今日进度%」：认识+40pp / 模糊+20pp / 忘记+0，失败封顶 80%（v2 模式下仅兼容存储）
      todayProgress: completesToday ? 1 : todayProgress,
      todayProgressDate: today,
      todayProgressLevel: v2 ? nextLevel : prev.todayProgressLevel,
      canFinishToday: v2 ? canFinishFor(nextLevel, prev, q) : prev.canFinishToday,
      lastRating: rating,
      updatedAt: now,
    }
    return {
      state,
      log: makeLog(prev, state, rating, now, {
        longTermUpdate: false,
        p: retrievability(prev.stability, elapsedDays),
        elapsedDays,
      }),
      longTermUpdate: false,
      // 官方 help30：同一天内的再次反馈只影响“当天间隔几个单词后再出现”，不改长期间隔。
      // 所以这里仍然返回回炉建议（模糊/不认识可反复回炉，直到用户点认识）。
      requeue: requeueKindOf(rating),
      completesToday,
    }
  }

  // 2) 当天第一次反馈：更新长期状态
  let d = clamp(prev.difficulty, q.dMin, q.dMax)
  let h: number
  let p: number
  let intervalDays: number
  if (isFirstEver) {
    // 新词首评（research 04 §11.4 候选 A）：认识/模糊不再一律 1 天
    d = clamp(prev.difficulty, q.dMin, q.dInitialMax)
    p = 1
    if (rating === 'familiar') {
      h = firstFamiliarHalfLife(d, q)
      intervalDays = firstFamiliarDays(d, q)
    } else if (rating === 'vague') {
      h = firstVagueHalfLife(d, q)
      intervalDays = firstVagueDays(d, q)
    } else {
      // 首评忘记：回到初始半衰期 + 固定次日（官方截图）
      h = initialStability(d, q)
      intervalDays = firstForgetDays(q)
    }
  } else {
    p = retrievability(prev.stability, elapsedDays)
    h =
      rating === 'familiar'
        ? stabilityAfterRecall(d, prev.stability, p, q)
        : stabilityAfterForget(d, prev.stability, p, q)
    h = clamp(h, q.stabilityMin, q.stabilityMax)
    // task-26：忘记不再强制次日（按公式重算，可能 1/2/7 天）；forceNextDayOnForgot 仅作 A/B 开关
    intervalDays =
      rating === 'forgot' && q.forceNextDayOnForgot
        ? 1
        : intervalFromRetention(h, q.retentionTarget, q)
  }
  if (rating === 'forgot') d = clamp(d + q.dFailStep, q.dMin, q.dMax)
  else if (rating === 'vague') d = clamp(d + q.dVagueStep, q.dMin, q.dMax)
  h = clamp(h, q.stabilityMin, q.stabilityMax)

  // 3) 下次间隔与到期日（到期日 = 本地日期 00:00，不是 now + n*dayMs）
  intervalDays = clamp(intervalDays, q.intervalMin, q.intervalMax)
  const dueAt = startOfLocalDay(addDays(now, intervalDays))

  // 4) 计数与字段
  const phase: WordState['phase'] =
    rating === 'familiar'
      ? 'review'
      : prev.phase === 'new' || prev.phase === 'learning'
        ? 'learning'
        : 'lapsed'

  const next: WordState = {
    ...prev,
    phase,
    stability: h,
    difficulty: d,
    reps: prev.reps + (rating === 'familiar' ? 1 : 0),
    lapses: prev.lapses + (rating === 'familiar' ? 0 : 1),
    firstSeenAt: prev.firstSeenAt ?? now,
    lastReviewedAt: now,
    dueAt,
    nextIntervalDays: intervalDays,
    retrievability: p, // 结算时刻快照
    lastRating: rating,
    sameDayCount,
    sameDayDate: today,
    sameDayRequeued: 0,
    // 当日首评：认识 → 当日完成（100%）；模糊/忘记 → 基准 20%（截图 01）
    todayProgress: rating === 'familiar' ? 1 : q.progressBase,
    todayProgressDate: today,
    // v2 档位模型：首评「不确定」→L1a、「不认识」→L1b；首评「认识」→当日完成
    todayProgressLevel: clamp(
      Math.round(
        rating === 'forgot' ? q.progressInitialLevelForget : q.progressInitialLevelVague,
      ),
      1,
      Math.max(1, q.progressLevels.length),
    ),
    canFinishToday: canFinishFor(
      clamp(
        Math.round(
          rating === 'forgot' ? q.progressInitialLevelForget : q.progressInitialLevelVague,
        ),
        1,
        Math.max(1, q.progressLevels.length),
      ),
      undefined,
      q,
    ),
    updatedAt: now,
  }

  return {
    state: next,
    log: makeLog(prev, next, rating, now, {
      longTermUpdate: true,
      p,
      elapsedDays,
    }),
    longTermUpdate: true,
    requeue: requeueKindOf(rating),
    completesToday: next.todayProgress != null && next.todayProgress >= 1,
  }
}

/**
 * 「下一次出现」预览（v1 兼容接口；SPEC-v2 §2）。
 * 新代码请优先用 `predictAll()`；本函数内部基于 predictAll 取对应评分的预测项。
 */
export interface NextPreview {
  /** 本次评分后的长期间隔（天）；同日非首次反馈 = 当前 nextIntervalDays（长期不变） */
  longTermDays: number
  /** 当日回炉建议（与 ScheduleResult.requeue 同口径） */
  todayRequeue: 'requeue-forgot' | 'requeue-vague' | 'none'
  /** v2：该反馈是否属于「今日首评」场景 */
  first?: boolean
  /** v2：该反馈后的当日复习进度 0..1（投影值） */
  todayProgress?: number
  /** v2：该反馈后是否完成当日复习 */
  completesToday?: boolean
}

/**
 * 纯函数：预览「如果现在点这个 rating，会发生什么」，**不改状态、不写日志**。
 */
export function previewNext(
  rating: Rating,
  state: WordState,
  now: number,
  params?: Partial<AlgoParams>,
): NextPreview {
  const predict = predictAll(state, now, params)[rating]
  return {
    longTermDays: predict.days,
    todayRequeue: requeueKindOf(rating),
    first: predict.first,
    todayProgress: predict.progress,
    completesToday: predict.progress >= 1,
  }
}

// ============ 三键预测 v2（官方 Web 协议 Predict 结构，research 04 §3.1/§11.2） ============

/** 与官方 Web 协议 `Predict` 同名同义：{ first, days, progress } */
export interface Predict {
  /** 该反馈是否属于「今日首评」场景（→ 副标题显示 `今日 / N 天后`） */
  first: boolean
  /** 该反馈后的长期复习间隔（天） */
  days: number
  /** 该反馈后的「当日复习进度」0..1（→ `今日进度X%`，>=1 表示完成当日复习） */
  progress: number
}

/** 三键预测（顺序与 Rating 一致：认识/模糊/忘记） */
export type WordPredicts = Record<Rating, Predict>

/**
 * 三键预测（纯函数，一次算三支，供 UI 显示在按钮下方）。**不写库、不改状态。**
 *
 * 官方前端格式化规则（UI 侧实现，core 只出数据）：
 * ```
 * progress >= 1 → `${days} 天后`
 * first        → `今日 / ${days} 天后`
 * 否则          → `今日进度${round(100*progress)}%`
 * ```
 * 证据：research 04 §3.2（官方前端代码）+ §5.3（进度模型，推断）+ §11.4（首评间隔，候选 A）。
 *
 * - 今日首评：新词用候选 A 的 7–90 / 1–7 / 1 天；已学词用现有 DHP+阈值法；
 * - 同日回炉：长期间隔已固定，progress 按 20pp 模型投影（认识+40 / 模糊+20 / 忘记+0，失败封顶 80%）。
 */
export function predictAll(
  state: WordState,
  now: number,
  params?: Partial<AlgoParams>,
): WordPredicts {
  const q = resolveParams(params)
  const today = localDateKey(now)
  const isFirstEver = state.firstSeenAt == null
  const isFirstToday =
    isFirstEver || state.lastReviewedAt == null || localDateKey(state.lastReviewedAt) !== today

  if (isFirstToday) {
    const d = clamp(state.difficulty, q.dMin, q.dInitialMax)
    let fDays: number
    let vDays: number
    let xDays: number
    if (isFirstEver) {
      fDays = firstFamiliarDays(d, q)
      vDays = firstVagueDays(d, q)
      xDays = firstForgetDays(q)
    } else {
      // 复习日首评：与 scheduleNext 同源（保证 UI 显示 = 真实提交结果）
      fDays = scheduleNext(state, 'familiar', now, q).state.nextIntervalDays
      vDays = scheduleNext(state, 'vague', now, q).state.nextIntervalDays
      xDays = scheduleNext(state, 'forgot', now, q).state.nextIntervalDays
    }
    return {
      familiar: { first: true, days: fDays, progress: 1 },
      vague: { first: true, days: vDays, progress: q.progressBase },
      forgot: { first: true, days: xDays, progress: q.progressBase },
    }
  }

  // 同日回炉：长期间隔不变，投影「如果点这个，当日进度会变成多少」
  const days = state.nextIntervalDays
  if (q.progressModelMode === 'v2-levels') {
    // v2 档位模型（research 04 §15.4/§15.6）：V/W 由档位表唯一确定；F 由 canFinish 决定显示 days 还是 %
    const level = progressLevelOf(state, q)
    const row = levelRow(level, q)
    // canFinish 由 canFinishMode + level 派生（默认 'table' 按档位表 familiar 列）
    const canFinish = canFinishFor(level, state, q)
    const familiarProgress = canFinish ? 1 : typeof row.familiar === 'number' ? row.familiar : 1
    return {
      familiar: { first: false, days, progress: familiarProgress },
      vague: { first: false, days, progress: row.vague },
      forgot: { first: false, days, progress: row.forget },
    }
  }
  const p = todayProgressOf(state, today, q)
  return {
    familiar: { first: false, days, progress: progressAfter('familiar', p, q) },
    vague: { first: false, days, progress: progressAfter('vague', p, q) },
    forgot: { first: false, days, progress: progressAfter('forgot', p, q) },
  }
}

/** 新词状态工厂（data 层首次见到某词时用；与 scheduleNext 的 isFirstEver 分支对齐） */
export function createWordState(input: {
  wordId: string
  deckId: string
  difficulty?: number
  now?: number
  params?: Partial<AlgoParams>
}): WordState {
  const q = resolveParams(input.params)
  const difficulty = clamp(
    input.difficulty ?? q.d0,
    q.dMin,
    Math.min(q.dInitialMax, q.dMax),
  )
  const stability = clamp(initialStability(difficulty, q), q.stabilityMin, q.stabilityMax)
  const now = input.now ?? 0
  return {
    wordId: input.wordId,
    deckId: input.deckId,
    phase: 'new',
    stability,
    difficulty,
    reps: 0,
    lapses: 0,
    firstSeenAt: null,
    lastReviewedAt: null,
    dueAt: null,
    nextIntervalDays: intervalFromRetention(stability, q.retentionTarget, q),
    retrievability: 1,
    lastRating: null,
    sameDayCount: 0,
    sameDayDate: '',
    meaningStats: {},
    sameDayRequeued: 0,
    todayProgress: 0,
    todayProgressDate: '',
    todayProgressLevel: clamp(
      Math.round(q.progressInitialLevelVague),
      1,
      Math.max(1, q.progressLevels.length),
    ),
    canFinishToday: canFinishFor(
      clamp(Math.round(q.progressInitialLevelVague), 1, Math.max(1, q.progressLevels.length)),
      undefined,
      q,
    ),
    createdAt: now,
    updatedAt: now,
  }
}
