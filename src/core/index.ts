/**
 * core 层出口（SPEC §9.2）：纯 TS 领域逻辑。
 *
 * 约束（架构测试强制）：
 * - 不得 import react / react-dom / react-router-dom / dexie / zustand / DOM API / IndexedDB。
 * - UI / data 只从 `src/core` 这个出口 import（不要深挖子文件）。
 *
 * 约定：所有函数都是纯函数（不读时钟、不写库），`now` 显式传入；
 * 参数可注入 `Partial<AlgoParams>` 便于单测与 A/B。
 */

// —— 类型（§1.2，全部 export type）——
export type {
  Deck,
  DeckSource,
  Word,
  Meaning,
  Example,
  Mnemonic,
  Phrase,
  Phonetic,
  Rating,
  Phase,
  WordState,
  MeaningStat,
  ReviewLog,
  SessionSnapshot,
  SettingsMap,
  SettingKey,
  SettingRecord,
  MetaRecord,
  DeckFile,
  MigrationFile,
  ImportIssue,
  ImportReport,
} from './types'
export type {
  PlanWordSource,
  PlanRating,
  DailyPlan,
  HomeStudyState,
} from './types'

// —— 参数 ——
export { DEFAULT_PARAMS, resolveParams, clamp, clamp01 } from './params'
export type { AlgoParams } from './params'

// —— id ——
export {
  normalizeHeadword,
  wordIdOf,
  meaningIdOf,
  newDeckId,
  fnv1a32,
  isWordIdOfDeck,
  headwordOfWordId,
  wordIdOfMeaning,
} from './ids'

// —— 时间 ——
export {
  localDateKey,
  startOfLocalDay,
  addDays,
  dayDiff,
  daysBetween,
  isSameLocalDay,
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
} from './time'

// —— DHP ——
export {
  retrievability,
  initialStability,
  stabilityAfterRecall,
  stabilityAfterForget,
} from './dhp'

// —— 调度 ——
export {
  intervalFromRetention,
  scheduleNext,
  previewNext,
  predictAll,
  isFirstShow,
  firstFamiliarDays,
  firstFamiliarHalfLife,
  firstVagueDays,
  firstVagueHalfLife,
  firstForgetDays,
  createWordState,
  requeueKindOf,
  isDue,
  isNew,
  memoryDurabilityDays,
  retrievabilityNow,
} from './schedule'
export type { ScheduleResult, NextPreview, Predict, WordPredicts } from './schedule'

// —— 队列 ——
export { pickQueue, shuffleWith, insertRequeue, requeueGapOf, RequeueQueue } from './queue'
export type { QueueOptions, DailyQueue, RequeueKind } from './queue'

// —— 不熟悉度 ——
export {
  familiarity,
  emptyMeaningStat,
  normalizeMeaningStat,
  applyMeaningClick,
  applyMeaningEncounter,
  applyMeaningEncounters,
  familiarityOfMeaning,
} from './familiarity'

// —— 会话状态机 ——
export {
  createSession,
  tapBoard,
  openMemory,
  tapMemory,
  advanceMemory,
  exitMemory,
  markMeaning,
  isMemoryComplete,
  remainingMemoryTaps,
  sessionSnapshot,
  countsFromSnapshot,
  shouldRecordEncounters,
  normalizeSessionSettings,
  DEFAULT_SESSION_SETTINGS,
  TOTAL_REPEATS_MIN,
  TOTAL_REPEATS_MAX,
} from './session'
export type { SessionWord, SessionSettings, SessionState } from './session'

// —— 今日计划 / 首页状态（SPEC-v2 §3.4/§6.2）——
export { deriveHomeState, getCurrentWordId } from './plan'
export type { HomeStateInput } from './plan'

// —— 统计 ——
export {
  computeStudyStreak,
  computeDailyStats,
  computeFeedbackDistribution,
  computeForgettingCurve,
  computeUnfamiliarTop,
  computeReviewPressure,
  computeStatsOverview,
  currentRetrievability,
} from './stats'
export type {
  StatsOverview,
  DailyStatPoint,
  FeedbackDistribution,
  ForgettingCurveBucket,
  UnfamiliarTopItem,
  ReviewPressurePoint,
} from './stats'
