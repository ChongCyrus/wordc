/**
 * 墨墨 StudyRecord → 本地 WordState 的纯映射器（SPEC §7.3 / D24 / D43）。
 *
 * 字段映射（能拿到的都按官方实测口径，拿不到的一律近似并标注）：
 * | StudyRecord             | WordState                         | 规则 |
 * |-------------------------|-----------------------------------|------|
 * | voc_spelling            | 匹配 Word.headwordLower           | trim+合并空白+小写；匹配不到记 unmatched，**不造词** |
 * | first_study_date        | firstSeenAt                       | 北京时间解析（D45） |
 * | last_study_date         | lastReviewedAt                    | 同上 |
 * | next_study_date         | dueAt（本地日期 00:00）           | 缺失 → last+1 天；WELL_FAMILIAR → null |
 * | last_response           | lastRating / phase                | FAMILIAR/VAGUE/FORGET/WELL_FAMILIAR/CANCEL_WELL_FAMILIAR；UNSPECIFIED/null → null（见过一次未评分，不当作答错，D43） |
 * | study_count             | reps                              | 直接映射（展示用） |
 * | tags STICKING           | difficulty=8、lapses=max(2,⌊study_count/3⌋) | 顽固词近似 |
 * | （无）                  | stability                         | 用间隔反推 `interval / -log2(0.9)`；未评分/无数据用 initialStability(5) |
 * | （无）                  | meaningStats                      | 每个含义 {clicks:1, encounters:2} → f=0.5（D24 中性初始） |
 *
 * 纯函数：只依赖入参（matcher/now），不碰 DB、不发网络。
 */

import {
  addDays,
  clamp,
  initialStability,
  retrievability,
  startOfLocalDay,
} from '../../core'
import type { ImportIssue, Rating, WordState } from '../../core'
import { makeIssue } from '../schema'
import { parseMaimemoDate } from './maimemo-client'
import type { StudyRecord } from './maimemo-types'

const DAY_MS = 86_400_000
/** 保留率阈值（与 core 默认 R_target=0.9 一致）：-log2(0.9) ≈ 0.152 */
const LOG2_RETENTION = -Math.log2(0.9)

/** 匹配到的本地词条信息 */
export interface MatchedWordInfo {
  wordId: string
  deckId: string
  meaningIds: string[]
  spelling: string
}

/** 匹配器：normalized spelling → 本地词条（由 data 层用词库构建） */
export type RecordMatcher = (normalizedSpelling: string) => MatchedWordInfo | null

export interface MapStudyRecordsResult {
  states: WordState[]
  /** 成功映射的单词数（按 wordId 去重） */
  matched: number
  /** 未匹配拼写（最多 100 个，按出现顺序） */
  unmatched: string[]
  unmatchedCount: number
  /** 解析失败/脏数据跳过数 */
  skipped: number
  issues: ImportIssue[]
}

/** 规整拼写（与 §1.4 normalizeHeadword 一致） */
export function normalizeSpelling(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

interface InterpretedResponse {
  rating: Rating | null
  wellFamiliar: boolean
  raw: string | null
  known: boolean
}

/** last_response 枚举解释（SPEC §7.3） */
export function interpretResponse(value: unknown): InterpretedResponse {
  const raw = typeof value === 'string' ? value.trim().toUpperCase() : null
  switch (raw) {
    case 'FAMILIAR':
      return { rating: 'familiar', wellFamiliar: false, raw, known: true }
    case 'VAGUE':
      return { rating: 'vague', wellFamiliar: false, raw, known: true }
    case 'FORGET':
      return { rating: 'forgot', wellFamiliar: false, raw, known: true }
    case 'WELL_FAMILIAR':
      return { rating: 'familiar', wellFamiliar: true, raw, known: true }
    case 'CANCEL_WELL_FAMILIAR':
      return { rating: 'familiar', wellFamiliar: false, raw, known: true }
    case 'STUDY_RESPONSE_UNSPECIFIED':
    case null:
    case '':
      return { rating: null, wellFamiliar: false, raw, known: true }
    default:
      // 未知枚举：按「见过一次未评分」处理，不当作答错
      return { rating: null, wellFamiliar: false, raw, known: false }
  }
}

function tagsOf(record: StudyRecord): string[] {
  const tags = record.tags
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).toUpperCase())
  if (typeof tags === 'string' && tags.trim()) {
    return tags
      .split(/[;,]/)
      .map((tag) => tag.trim().toUpperCase())
      .filter(Boolean)
  }
  return []
}

/** 单条记录 → WordState（不写库） */
export function mapStudyRecord(
  record: StudyRecord,
  match: MatchedWordInfo,
  now: number = Date.now(),
): WordState {
  const response = interpretResponse(record.last_response)
  const tags = tagsOf(record)

  const firstRaw = parseMaimemoDate(record.first_study_date)
  const lastRaw = parseMaimemoDate(record.last_study_date)
  const nextRaw = parseMaimemoDate(record.next_study_date)

  // 按 SPEC §7.3：firstSeenAt 取 first_study_date；缺失 → phase='new'
  const firstSeenAt = firstRaw
  const lastReviewedAt = lastRaw

  // —— 难度 / 遗忘次数 ——
  const studyCount = Number.isFinite(record.study_count) ? Math.max(0, Math.floor(record.study_count!)) : 0
  let difficulty = 5
  let lapses = 0
  if (tags.includes('STICKING')) {
    difficulty = 8
    lapses = Math.max(2, Math.floor(studyCount / 3))
  }
  if (response.rating === 'forgot') lapses = Math.max(lapses, 1)

  // —— interval → 记忆半衰期近似（SPEC §7.3；用原始时间算，避免 00:00 归一引入偏差）——
  const rawIntervalDays =
    nextRaw != null && lastReviewedAt != null
      ? Math.max(0, Math.round((nextRaw - lastReviewedAt) / DAY_MS))
      : 0
  const nextIntervalDays = Math.max(1, rawIntervalDays)
  let stability = rawIntervalDays > 0 ? rawIntervalDays / LOG2_RETENTION : 0.1
  if (response.rating == null) {
    // 见过一次但未评分：h 用初始值（D43，不能按答错/遗忘处理）
    stability = initialStability(5)
  }
  stability = clamp(stability, 0.1, 4096)

  // —— phase（§7.3：无 first_study_date → new；FORGET 且次日回炉 → learning）——
  let phase: WordState['phase']
  if (response.wellFamiliar) phase = 'mastered'
  else if (firstRaw == null) phase = 'new'
  else if (
    response.rating === 'forgot' &&
    nextRaw != null &&
    lastReviewedAt != null &&
    nextRaw - lastReviewedAt <= DAY_MS
  ) {
    phase = 'learning'
  } else phase = 'review'

  // —— 到期日（dueAt = 本地日期 00:00；new/mastered 为 null，§1.2）——
  let dueAt: number | null
  if (phase === 'new' || phase === 'mastered') {
    dueAt = null
  } else if (nextRaw != null) {
    dueAt = startOfLocalDay(nextRaw)
  } else if (lastReviewedAt != null) {
    dueAt = startOfLocalDay(addDays(lastReviewedAt, 1))
  } else {
    dueAt = null
  }

  // —— 熟知度快照（实时回忆概率）——
  const elapsedDays = lastReviewedAt != null ? Math.max(0, (now - lastReviewedAt) / DAY_MS) : 0
  const p = lastReviewedAt == null ? 1 : retrievability(stability, elapsedDays)

  const meaningStats: WordState['meaningStats'] = {}
  for (const meaningId of match.meaningIds) {
    // D24：不熟悉度初始 0.5（中性），即 clicks=1 / encounters=2
    meaningStats[meaningId] = { clicks: 1, encounters: 2 }
  }

  return {
    wordId: match.wordId,
    deckId: match.deckId,
    phase,
    stability,
    difficulty,
    reps: studyCount,
    lapses,
    firstSeenAt,
    lastReviewedAt,
    dueAt,
    nextIntervalDays,
    retrievability: p,
    lastRating: response.rating,
    sameDayCount: 0,
    sameDayDate: '',
    meaningStats,
    sameDayRequeued: 0,
    importedFrom: 'maimemo',
    importedAt: now,
    createdAt: firstSeenAt ?? now,
    updatedAt: now,
  }
}

const MAX_ISSUES = 50
const MAX_UNMATCHED = 100

/**
 * 批量映射（纯函数）。脏数据不抛错：
 * - 无 voc_spelling / 非对象 → `skipped + 1` + W_SKIPPED issue；
 * - 匹配不到 → 进入 `unmatched`（不造词、不跳过计数，D43）；
 * - 同一 wordId 多条记录 → 取 `last_study_date` 最新的那条（按 wordId 去重）。
 */
export function mapStudyRecords(
  records: readonly unknown[],
  matcher: RecordMatcher,
  now: number = Date.now(),
): MapStudyRecordsResult {
  const issues: ImportIssue[] = []
  const statesByWordId = new Map<string, WordState>()
  const unmatched: string[] = []
  const unmatchedSeen = new Set<string>()
  let unmatchedCount = 0
  let skipped = 0

  const pushIssue = (issue: ImportIssue): void => {
    if (issues.length < MAX_ISSUES) issues.push(issue)
  }

  records.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      skipped += 1
      pushIssue(makeIssue('warning', 'W_SKIPPED', `第 ${index + 1} 条记录不是对象，已跳过`, { path: `records[${index}]` }))
      return
    }
    const record = raw as StudyRecord
    const spelling = normalizeSpelling(record.voc_spelling)
    if (!spelling) {
      skipped += 1
      pushIssue(
        makeIssue('warning', 'W_SKIPPED', `第 ${index + 1} 条记录缺少 voc_spelling，已跳过`, {
          path: `records[${index}].voc_spelling`,
        }),
      )
      return
    }

    const match = matcher(spelling)
    if (!match) {
      unmatchedCount += 1
      if (!unmatchedSeen.has(spelling)) {
        unmatchedSeen.add(spelling)
        if (unmatched.length < MAX_UNMATCHED) unmatched.push(String(record.voc_spelling))
      }
      return
    }

    if (!interpretResponse(record.last_response).known) {
      pushIssue(
        makeIssue('warning', 'W_SKIPPED', `未知 last_response「${String(record.last_response)}」，已按未评分处理`, {
          path: `records[${index}].last_response`,
        }),
      )
    }

    const state = mapStudyRecord(record, match, now)
    const existing = statesByWordId.get(state.wordId)
    if (existing) {
      const existingAt = existing.lastReviewedAt ?? -Infinity
      const incomingAt = state.lastReviewedAt ?? -Infinity
      if (incomingAt >= existingAt) statesByWordId.set(state.wordId, state)
      return
    }
    statesByWordId.set(state.wordId, state)
  })

  if (unmatchedCount > 0) {
    pushIssue(
      makeIssue(
        'warning',
        'W_SKIPPED',
        `${unmatchedCount} 个墨墨单词不在当前词库中，已跳过（可手动加词后再次导入）`,
        { path: 'records' },
      ),
    )
  }
  if (skipped > 0) {
    pushIssue(makeIssue('warning', 'W_SKIPPED', `${skipped} 条记录无法解析，已跳过`, { path: 'records' }))
  }

  return {
    states: [...statesByWordId.values()],
    matched: statesByWordId.size,
    unmatched,
    unmatchedCount,
    skipped,
    issues,
  }
}
