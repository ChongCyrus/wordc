/**
 * 每日学习队列 + 当日回炉队列（SPEC §3.8 / §3.9，AC4 依赖）。
 *
 * 官方语义（research §5.2）：
 * - 「每日学习量 = 复习单词量 + 新学单词量」，单位是**单词数**；
 * - **先复习后新学**；复习按遗忘程度高→低（retrievabilityNow 升序）；
 * - 复习量占满学习量时，新学量为 0；
 * - 用户手动「加学」的新词立即学习，**不计入 dailyGoal**。
 *
 * `pickQueue` 是纯函数，**不查 DB**（数据层负责把 states 查出来传进来）。
 */

import { clamp } from './params'
import type { AlgoParams } from './params'
import { isDue, requeueKindOf } from './schedule'
import { resolveParams } from './params'
import { retrievabilityNow } from './schedule'
import type { Rating, WordState } from './types'

export interface QueueOptions {
  now: number
  /** 设置 study.dailyGoal，默认 30 */
  dailyGoal: number
  /** 指定词库（null/undefined = 所有词库） */
  deckId?: string | null
  /** 新词排序：'order'（词库顺序，默认）| 'random' */
  newOrder?: 'order' | 'random'
  /** 用户手动「加学」的词：立即入新学队列且不计入 dailyGoal（官方口径） */
  extraNewWordIds?: string[]
  /** 测试注入随机源（0..1） */
  random?: () => number
  /** 新词排序所需 order 映射（wordId → order），由 data 层提供，缺省按 wordId 字典序 */
  orderOf?: Record<string, number>
  /**
   * 每日复习上限（task-51，设置 `study.dailyReviewCap`）：
   * - 0/undefined = 不限（默认，官方语义）；
   * - >0 = 只把「按遗忘度排序的前 cap 个到期词」放进 reviewQueue；
   *   超出的到期词**不做任何修改**（dueAt 不变，明天自然再到期）。
   */
  reviewCap?: number
}

export interface DailyQueue {
  /** 已排序：遗忘程度高→低 */
  reviewQueue: WordState[]
  newQueue: WordState[]
  /** 今日实际入队的到期复习数（= reviewQueue.length；task-51 起受 reviewCap 限制） */
  dueCount: number
  /** 全部到期复习数（含被 reviewCap 顺延的 backlog；task-51 新增） */
  dueTotal: number
  /** = max(0, dailyGoal - reviewQueue.length) */
  newBudget: number
  /** reviewQueue.length + newQueue.length（含加学词） */
  totalPlanned: number
  extraCount: number
}

function inDeck(state: WordState, deckId: string | null | undefined): boolean {
  return deckId == null || state.deckId === deckId
}

/** Fisher-Yates（纯函数：返回新数组，用注入的 random） */
export function shuffleWith<T>(items: readonly T[], random: () => number): T[] {
  const arr = items.slice()
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const raw = random()
    const j = clamp(Math.floor((Number.isFinite(raw) ? raw : 0) * (i + 1)), 0, i)
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr
}

/**
 * 每日队列（纯函数）。
 *
 * **每日学习量 = 复习 + 新学目标，不限制复习总量**（官方文档；task-26 用户 P0）：
 * - `reviewQueue` = **全部到期词**（按遗忘程度排序，**不再按 dailyGoal 截断**）；
 * - `newBudget = max(0, dailyGoal - dueCount)`；复习量超出目标时新学量为 0；
 * - `totalPlanned` = 实际队列长度（复习 + 新学，含手动加学词）。
 *
 * 排序细节：review 以 `retrievabilityNow` 升序（越低越先），同值按 `dueAt` 升序，再按 wordId
 * 字典序保证确定性（`Array.prototype.sort` 在 V8 是稳定排序，但显式 tie-break 更稳）。
 */
export function pickQueue(states: readonly WordState[], opts: QueueOptions): DailyQueue {
  const deckId = opts.deckId ?? null
  const goal = Math.max(0, Math.floor(Number.isFinite(opts.dailyGoal) ? opts.dailyGoal : 0))
  const random = opts.random ?? Math.random

  const due = states.filter((s) => inDeck(s, deckId) && isDue(s, opts.now))
  const reviewSorted = due.slice().sort((a, b) => {
    const ra = retrievabilityNow(a, opts.now)
    const rb = retrievabilityNow(b, opts.now)
    if (ra !== rb) return ra - rb
    const da = a.dueAt ?? Number.POSITIVE_INFINITY
    const db = b.dueAt ?? Number.POSITIVE_INFINITY
    if (da !== db) return da - db
    return a.wordId < b.wordId ? -1 : a.wordId > b.wordId ? 1 : 0
  })
  // task-26：复习量默认不截断；task-51：设置每日复习上限时只取前 cap 个（其余保持到期，明天再入队）
  const cap =
    Number.isFinite(opts.reviewCap) && (opts.reviewCap as number) > 0
      ? Math.min(9999, Math.floor(opts.reviewCap as number))
      : 0
  const reviewQueue = cap > 0 ? reviewSorted.slice(0, cap) : reviewSorted
  // 新学预算 = 学习量 − **今日实际入队复习数**（cap 只限制自动入队，不改变 backlog）
  const newBudget = Math.max(0, goal - reviewQueue.length)

  const news = states.filter((s) => inDeck(s, deckId) && s.phase === 'new')
  let newsOrdered: WordState[]
  if (opts.newOrder === 'random') {
    newsOrdered = shuffleWith(news, random)
  } else {
    const orderOf = opts.orderOf
    newsOrdered = news.slice().sort((a, b) => {
      const oa = orderOf?.[a.wordId] ?? Number.POSITIVE_INFINITY
      const ob = orderOf?.[b.wordId] ?? Number.POSITIVE_INFINITY
      if (oa !== ob) return oa - ob
      return a.wordId < b.wordId ? -1 : a.wordId > b.wordId ? 1 : 0
    })
  }
  const newQueue = newsOrdered.slice(0, newBudget)

  // 手动加学：不计入 budget，追加到末尾（不重复）
  const extraIds = opts.extraNewWordIds ?? []
  const picked = new Set(newQueue.map((s) => s.wordId))
  const extras: WordState[] = []
  for (const id of extraIds) {
    if (picked.has(id)) continue
    const st = states.find((s) => s.wordId === id)
    if (st && st.phase === 'new' && inDeck(st, deckId)) {
      extras.push(st)
      picked.add(id)
    }
  }
  newQueue.push(...extras)

  return {
    reviewQueue,
    newQueue,
    dueCount: reviewQueue.length,
    dueTotal: due.length,
    newBudget,
    totalPlanned: reviewQueue.length + newQueue.length,
    extraCount: extras.length,
  }
}

// ============ 当日回炉（SPEC §3.9） ============

export type RequeueKind = 'requeue-forgot' | 'requeue-vague' | 'none'

/** 回炉插入间隔：不认识 = 4 个词位，模糊 = 8 个词位（D10，可 A/B） */
export function requeueGapOf(rating: Rating, params?: Partial<AlgoParams>): number {
  const q = resolveParams(params)
  if (rating === 'forgot') return q.requeueGapForgot
  if (rating === 'vague') return q.requeueGapVague
  return 0
}

/**
 * 把「刚评分的词」按规则插回队列（纯函数版）。
 *
 * @param queue       当前队列（wordId 列表）
 * @param currentIndex 刚评分的词在队列中的下标
 * @param rating      本次评分
 * @returns 新队列；认识的话不插回（等于移除）
 */
export function insertRequeue(
  queue: readonly string[],
  currentIndex: number,
  rating: Rating,
  params?: Partial<AlgoParams>,
): string[] {
  const wordId = queue[currentIndex]
  if (wordId == null) return queue.slice()
  const kind = requeueKindOf(rating)
  const rest = queue.slice()
  rest.splice(currentIndex, 1)
  if (kind === 'none') return rest // 认识：当天不再出现
  const gap = requeueGapOf(rating, params)
  const pos = clamp(currentIndex + Math.max(1, gap), 0, rest.length)
  rest.splice(pos, 0, wordId)
  return rest
}

/**
 * 学习会话内的可变队列（一次学习过程用；规则只在 core 里实现一次，可单测）。
 *
 * 用法：
 * ```ts
 * const q = new RequeueQueue(ids)
 * while (q.current()) {
 *   const rating = await studyOne(q.current()!)
 *   q.submitCurrent(rating)          // 内部按 §3.9 处理回炉
 * }
 * ```
 */
export class RequeueQueue {
  private items: string[]
  private index = 0
  private params: AlgoParams

  constructor(wordIds: readonly string[], params?: Partial<AlgoParams>) {
    this.items = wordIds.slice()
    this.params = resolveParams(params)
  }

  /** 队列总长度（含已学过的；回炉会把词插回来 → 可能变长） */
  get length(): number {
    return this.items.length
  }

  /** 当前位置 */
  get position(): number {
    return this.index
  }

  /** 剩余待学数量 */
  get remaining(): number {
    return Math.max(0, this.items.length - this.index)
  }

  /** 当前该学的词；队列走完返回 null */
  current(): string | null {
    return this.index < this.items.length ? this.items[this.index]! : null
  }

  /** 队列快照（调试/持久化用） */
  toArray(): string[] {
    return this.items.slice()
  }

  /**
   * 提交当前词的评分并推进。
   * @returns 回炉建议（data 层 SubmitRatingResult.requeue 同口径）与插入位置
   */
  submitCurrent(rating: Rating): { requeue: RequeueKind; requeuedAt: number | null } {
    const wordId = this.current()
    if (wordId == null) return { requeue: 'none', requeuedAt: null }
    const kind = requeueKindOf(rating)
    // 移除当前词（index 位置），index 保持指向下一词
    this.items.splice(this.index, 1)
    if (kind !== 'none') {
      const gap = requeueGapOf(rating, this.params)
      const pos = clamp(this.index + Math.max(1, gap), 0, this.items.length)
      this.items.splice(pos, 0, wordId)
      return { requeue: kind, requeuedAt: pos }
    }
    return { requeue: 'none', requeuedAt: null }
  }
}
