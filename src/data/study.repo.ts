/**
 * 学习状态 / 每日队列 / 评分提交 / 不熟悉度 / 会话快照（SPEC §2.2 / §3 / §4.6 / §9.3）。
 *
 * 设计要点：
 * - **新词状态懒创建**：内置词库种子只写 decks+words（§1.6），未学词条没有 states 行；
 *   `getTodayQueue` 会为候选新词合成 `phase:'new'` 状态（不落库），首次评分/遇到时才写库。
 *   这样首启种子快、IndexedDB 小，且 `getDeckProgress` 的 newCount = wordCount - 已学。
 * - `submitRating` 在**同一事务**里写 states + reviewLogs + meta.lastStudyDate（§2.2-1）。
 * - 不熟悉度只由 UI 在指定时机调用（§4.6），core 只给纯函数。
 */

import {
  applyMeaningClick,
  applyMeaningEncounters,
  isDue,
  localDateKey,
  normalizeMeaningStat,
  pickQueue,
  requeueKindOf,
  scheduleNext,
} from '../core'
import type {
  DailyQueue,
  MetaRecord,
  Rating,
  ReviewLog,
  SessionSnapshot,
  Word,
  WordState,
} from '../core'
import { getDb } from './db'
import { applyRatingToPlan } from './plan-core'
import { dailyOrderRandom } from './plans.repo'
import { normalizeNewWordOrder } from './plan-random'
import type { NewWordOrder } from './plan-random'
import type { ReviewLogV2 } from './plan.types'
import { getSettings } from './settings.repo'
import { buildInitialState } from './word-factory'

/** `submitRating` 返回（§9.3 契约，一个字段都不能少） */
export interface SubmitRatingResult {
  state: WordState
  log: ReviewLog
  intervalDays: number
  longTermUpdate: boolean
  /** 当日回炉建议：'requeue-forgot' | 'requeue-vague' | 'none' */
  requeue: 'requeue-forgot' | 'requeue-vague' | 'none'
}

/** `getTodayQueue` 参数（§9.3） */
export interface TodayQueueOptions {
  deckId?: string | null
  now?: number
  dailyGoal?: number
  extraNewWordIds?: string[]
  /** 新词顺序：缺省读设置 `study.newWordOrder`（task-47） */
  newOrder?: NewWordOrder
  /** 测试注入随机源（缺省按「日期:词库」稳定种子派生） */
  random?: () => number
  /** 每日复习上限（task-51）：0/缺省=不限；>0 只取遗忘度最高的前 cap 个到期词 */
  reviewCap?: number
}

/** 词条 + 学习状态（未学 state 为 null，UI 按“新词”展示） */
export interface WordWithState {
  word: Word
  state: WordState | null
}

// ============ 读取状态 ============

/** 取某词的学习状态（未学返回 null） */
export async function getState(wordId: string): Promise<WordState | null> {
  const db = getDb()
  return (await db.states.get(wordId)) ?? null
}

/** 批量取状态；不传 ids 时取全部 */
export async function getStates(wordIds?: readonly string[]): Promise<WordState[]> {
  const db = getDb()
  if (!wordIds) return db.states.toArray()
  const rows = await db.states.bulkGet([...wordIds])
  return rows.filter((state): state is WordState => Boolean(state))
}

/** 取某词库全部状态 */
export async function getDeckStates(deckId: string): Promise<WordState[]> {
  const db = getDb()
  return db.states.where('deckId').equals(deckId).toArray()
}

/** 词条 +（可能为空的）学习状态；词条不存在返回 null */
export async function getWordWithState(wordId: string): Promise<WordWithState | null> {
  const db = getDb()
  const [word, state] = await Promise.all([db.words.get(wordId), db.states.get(wordId)])
  if (!word) return null
  return { word, state: state ?? null }
}

// ============ 每日队列 ============

/**
 * 今日学习队列（§3.8）：先复习后新学；返回的 `reviewQueue/newQueue` 是 WordState，
 * 渲染前用 `getWords([...ids])` 拿词条。
 *
 * 数据层负责：
 * - 从 settings 取 dailyGoal / selectedDeckId（调用方可覆盖）；
 * - 查已学 states（只有学过的词有行）；
 * - 按词库顺序为候选新词合成 `phase:'new'` 状态（最多 dailyGoal 个，够 pickQueue 截断）；
 * - 调 core 的纯函数 `pickQueue` 做排序/配额/加学词。
 */
export async function getTodayQueue(opts: TodayQueueOptions = {}): Promise<DailyQueue> {
  const db = getDb()
  const now = opts.now ?? Date.now()
  const settings = await getSettings()
  const deckId = opts.deckId === undefined ? settings['data.selectedDeckId'] : opts.deckId
  const dailyGoal = Math.max(0, Math.floor(opts.dailyGoal ?? settings['study.dailyGoal']))
  const extraIds = [...new Set(opts.extraNewWordIds ?? [])]

  const learnedStates = deckId
    ? await db.states.where('deckId').equals(deckId).toArray()
    : await db.states.toArray()
  const learned = learnedStates.filter((state) => state.phase !== 'new')
  const learnedIds = new Set(learned.map((state) => state.wordId))

  // 候选新词数量上界：复习没占满时最多 dailyGoal 个 + 手动加学
  const need = dailyGoal + extraIds.length
  const orderOf: Record<string, number> = {}
  const synthetic: WordState[] = []

  const pushSynthetic = (word: Word) => {
    if (learnedIds.has(word.id)) return
    if (synthetic.some((state) => state.wordId === word.id)) return
    orderOf[word.id] = word.order
    synthetic.push(buildInitialState(word, now))
  }

  if (need > 0) {
    const candidates = deckId
      ? await db.words
          .where('[deckId+order]')
          .between([deckId, -Infinity], [deckId, Infinity])
          .filter((word) => !learnedIds.has(word.id))
          .limit(need)
          .toArray()
      : await db.words.filter((word) => !learnedIds.has(word.id)).limit(need).toArray()
    for (const word of candidates) pushSynthetic(word)
  }

  // 手动「加学」的词：即使超出 order 候选窗口也要在队列里
  const missingExtras = extraIds.filter(
    (id) => !learnedIds.has(id) && !synthetic.some((state) => state.wordId === id),
  )
  if (missingExtras.length > 0) {
    const extraWords = await db.words.bulkGet(missingExtras)
    for (const word of extraWords) if (word) pushSynthetic(word)
  }

  // task-47：新词顺序设置（随机模式用「日期:词库」稳定种子，保证同一天多次调用顺序一致）
  let newOrder = opts.newOrder
  if (newOrder === undefined) {
    const row = await db.settings.get('study.newWordOrder')
    newOrder = normalizeNewWordOrder(row?.value)
  }
  const random =
    opts.random ?? (newOrder === 'random' ? dailyOrderRandom(deckId ?? null, now) : undefined)
  // task-51：每日复习上限（缺省读设置；只限制自动入队，不影响 extras/回炉）
  let reviewCap = opts.reviewCap
  if (reviewCap === undefined) {
    const row = await db.settings.get('study.dailyReviewCap')
    const num = Number(row?.value)
    reviewCap = Number.isInteger(num) && num >= 0 && num <= 9999 ? num : 0
  }
  // 手动加学词不计入 newBudget：从候选池剔除、统一追加到队尾
  // （否则 random 洗牌可能把它排进预算名次，导致 total 变少）
  const extraSet = new Set(extraIds)
  const extraStates = synthetic.filter((state) => extraSet.has(state.wordId))
  const baseSynthetic = synthetic.filter((state) => !extraSet.has(state.wordId))
  const queue = pickQueue([...learned, ...baseSynthetic], {
    now,
    dailyGoal,
    deckId: deckId ?? null,
    orderOf,
    extraNewWordIds: [],
    newOrder,
    random,
    reviewCap,
  })
  if (extraStates.length > 0) {
    queue.newQueue.push(...extraStates)
    queue.totalPlanned = queue.reviewQueue.length + queue.newQueue.length
    queue.extraCount = extraStates.length
  }
  return queue
}

/** 预取队列前 N 个词条（学习页进入下一词时不用再查库） */
export async function getNextWords(
  opts: { deckId?: string | null; limit?: number; now?: number } = {},
): Promise<Word[]> {
  const db = getDb()
  const limit = Math.max(0, Math.floor(opts.limit ?? 10))
  if (limit === 0) return []
  const queue = await getTodayQueue({ deckId: opts.deckId, now: opts.now })
  const ids = [...queue.reviewQueue, ...queue.newQueue].slice(0, limit).map((state) => state.wordId)
  const rows = await db.words.bulkGet(ids)
  const byId = new Map(rows.filter((word): word is Word => Boolean(word)).map((word) => [word.id, word]))
  return ids.map((id) => byId.get(id)).filter((word): word is Word => Boolean(word))
}

// ============ 评分提交 ============

/** 内部：事务内取/建状态 */
async function loadOrCreateState(wordId: string, now: number): Promise<WordState> {
  const db = getDb()
  const existing = await db.states.get(wordId)
  if (existing) return existing
  const word = await db.words.get(wordId)
  if (!word) throw new Error(`词条不存在：${wordId}`)
  return buildInitialState(word, now)
}

/** `submitRating` 的 v2 可选参数（SPEC-v2 §6.3 / ARCH-v2 §3.2） */
export interface SubmitRatingOptions {
  /** 今日 plan id：提供时在**同一事务**内推进 plan（索引/评分记录/回炉） */
  planId?: string
  /** 改判时新日志的 `correctedBy`（被撤销的旧 reviewLog id） */
  correctedFromLogId?: number
}

/**
 * 提交评分（v2）：调度更新 + states + reviewLogs（含 `stateBefore` 快照）+ plan 推进，
 * **全部在同一个事务里**（SPEC-v2 §6.3 硬约束；不允许先写状态后补 plan）。
 *
 * - `stateBefore`：评分前完整 WordState 深拷贝；该词首评前不存在 state 行时为 null（撤销时删除）；
 * - `opts.planId`：提供则按 rating 推进 plan（认识不插回炉；模糊/忘记按 gap 插入）；
 * - 返回的 `requeue` 仍是「当日回炉建议」，UI 可据此显示提示。
 */
export async function submitRating(
  wordId: string,
  rating: Rating,
  now: number = Date.now(),
  opts: SubmitRatingOptions = {},
): Promise<SubmitRatingResult> {
  const db = getDb()
  const today = localDateKey(now)
  return db.transaction(
    'rw',
    db.words,
    db.states,
    db.reviewLogs,
    db.plans,
    db.meta,
    async (): Promise<SubmitRatingResult> => {
      const word = await db.words.get(wordId)
      if (!word) throw new Error(`词条不存在：${wordId}`)
      const existingState = await db.states.get(wordId)
      const stateBefore: WordState | null = existingState ? { ...existingState } : null
      const prev = existingState ?? buildInitialState(word, now)
      const result = scheduleNext(prev, rating, now)
      const state: WordState = { ...result.state, updatedAt: now }
      await db.states.put(state)
      // v2：写入评分前快照（撤销唯一依据；旧日志无该字段 → 不可撤销）
      const logInput: ReviewLogV2 = { ...result.log, stateBefore }
      delete logInput.id
      if (opts.correctedFromLogId != null) logInput.correctedBy = opts.correctedFromLogId
      const id = await db.reviewLogs.add(logInput as ReviewLog)
      await db.meta.put({ key: 'lastStudyDate', value: today, updatedAt: now })

      // 同一事务推进今日 plan（若调用方给了 planId 且 plan 存在）
      if (opts.planId) {
        const plan = await db.plans.get(opts.planId)
        if (plan) {
          const nextPlan = applyRatingToPlan(plan, {
            wordId,
            rating,
            reviewedAt: now,
            longTermUpdate: result.longTermUpdate,
          })
          await db.plans.put(nextPlan)
          await db.meta.put({ key: 'plan.updatedAt', value: now, updatedAt: now })
          if (nextPlan.completedAt != null) {
            await db.meta.delete('plan.activeId')
          } else {
            await db.meta.put({ key: 'plan.activeId', value: nextPlan.id, updatedAt: now })
          }
        }
      }

      const log: ReviewLog = { ...logInput, id }
      return {
        state,
        log,
        intervalDays: state.nextIntervalDays,
        longTermUpdate: result.longTermUpdate,
        requeue: result.requeue,
      }
    },
  )
}

// ============ 不熟悉度（§4.6） ============

/**
 * 进入注释面：该词**全部**含义 encounters += 1（每个词每次会话只调一次，UI 幂等）。
 * 传 meaningIds 时只给存在的含义计数。
 */
export async function recordMeaningEncounters(
  wordId: string,
  meaningIds: string[],
): Promise<WordState> {
  const db = getDb()
  const now = Date.now()
  return db.transaction('rw', db.words, db.states, async (): Promise<WordState> => {
    const prev = await loadOrCreateState(wordId, now)
    const word = await db.words.get(wordId)
    const valid = word
      ? meaningIds.filter((id) => word.meanings.some((meaning) => meaning.id === id))
      : meaningIds
    const next: WordState = {
      ...prev,
      meaningStats: applyMeaningEncounters(prev.meaningStats, valid.length > 0 ? valid : []),
      updatedAt: now,
    }
    await db.states.put(next)
    return next
  })
}

/** 注释面点击某含义：clicks += 1（可重复点击，clicks 可 > encounters） */
export async function recordMeaningClick(
  wordId: string,
  meaningId: string,
  now: number = Date.now(),
): Promise<WordState> {
  const db = getDb()
  return db.transaction('rw', db.words, db.states, async (): Promise<WordState> => {
    const prev = await loadOrCreateState(wordId, now)
    const next: WordState = {
      ...prev,
      meaningStats: {
        ...prev.meaningStats,
        [meaningId]: applyMeaningClick(normalizeMeaningStat(prev.meaningStats[meaningId])),
      },
      updatedAt: now,
    }
    await db.states.put(next)
    return next
  })
}

// ============ 会话快照（D15 / §4.7） ============

function sessionKey(wordId: string): string {
  return `session:${wordId}`
}

/** 保存 w-c 进度快照（meta: `session:<wordId>`）；幂等覆盖 */
export async function saveSessionSnapshot(snapshot: SessionSnapshot): Promise<void> {
  const db = getDb()
  const now = Date.now()
  const record: MetaRecord<SessionSnapshot> = {
    key: sessionKey(snapshot.wordId),
    value: { ...snapshot, updatedAt: now },
    updatedAt: now,
  }
  await db.meta.put(record)
}

/** 读取 w-c 进度快照（损坏/不存在返回 null） */
export async function loadSessionSnapshot(wordId: string): Promise<SessionSnapshot | null> {
  const db = getDb()
  const row = await db.meta.get(sessionKey(wordId))
  const value = row?.value as SessionSnapshot | undefined
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.wordId !== 'string' ||
    typeof value.wcCounts !== 'object' ||
    value.wcCounts === null
  ) {
    return null
  }
  return value
}

/** 删除 w-c 快照（评分提交成功后调用，§4.7） */
export async function deleteSessionSnapshot(wordId: string): Promise<void> {
  const db = getDb()
  await db.meta.delete(sessionKey(wordId))
}

// ============ 杂项 ============

/** 今日到期数（首页/角标；不建队列，直接数 states） */
export async function countDue(deckId?: string | null, now: number = Date.now()): Promise<number> {
  const db = getDb()
  const states = deckId
    ? await db.states.where('deckId').equals(deckId).toArray()
    : await db.states.toArray()
  return states.filter((state) => isDue(state, now)).length
}

/** 内部：回炉建议（UI 也可自己用 core 的 requeueKindOf） */
export function requeueOf(rating: Rating): 'requeue-forgot' | 'requeue-vague' | 'none' {
  return requeueKindOf(rating)
}
