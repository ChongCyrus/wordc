/**
 * data 层出口（SPEC §9.3）：持久化 + 词库管理 + 导入导出 + 统计 + MaiMemo导入。
 *
 * 分层约束（D27）：
 * - **只有 src/data 可以碰 IndexedDB / fetch 外部数据**；
 * - UI 读：可用 `db.decks` 等做 `useLiveQuery`；写：一律走本文件导出的函数（§2.2-5 / §9.4）；
 * - core 保持纯函数，不 import data。
 *
 * 所有 data 函数错误用 throw（DB / 校验）；导入类函数返回 `ImportReport` 不 throw（§9.4）。
 */

// ============ 数据库 ============
export { db, getDb, resetDatabase, AppDatabase, DB_NAME, SCHEMA_VERSION } from './db'

// ============ 内置词库（AC7） ============
export {
  ensureBuiltinDecks,
  BUILTIN_DECK_IDS,
  isBuiltinDeckId,
  parseBuiltinDeckFile,
} from './builtin'
export type {
  BuiltinDeckId,
  BuiltinDeckFile,
  BuiltinSeedMeta,
  BuiltinSeedResult,
} from './builtin'
/** task-58：内置词库注册表（公开版 sanitize 后仅剩大纲） */
export { DECK_SOURCES } from './builtin/deck-sources'
export type { DeckSource } from './builtin/deck-sources'

// ============ 内置内容包自动导入（task-87） ============
export {
  DEFAULT_CONTENT_PACKS,
  DEFAULT_PACKS_META_KEY,
  DEFAULT_PACKS_VERSION,
  PRIVATE_CONTENT_PACKS,
  ensureDefaultContentPacks,
  getDefaultContentPacks,
  isPrivatePacksEnabled,
} from './default-packs'
export type {
  DefaultContentPackEntry,
  DefaultPackOutcome,
  EnsureDefaultPacksOptions,
  EnsureDefaultPacksResult,
} from './default-packs'

// ============ 内容包（momo-pack，v3 / task-69） ============
export {
  parsePackFile,
  previewPack,
  importPack,
  importContentPack,
  approveItems,
  rejectItems,
  applyApproved,
  exportPack,
  listPacks,
  getPack,
  listPackItems,
  getPackStats,
  deletePack,
  deletePacks,
  getEffectiveContent,
  selectTargets,
  selectTargetPage,
  pendingGenerationTargets,
  pendingGenerationTargetsPage,
  clearRejects,
  dedupePacks,
  listLegacySemanticsPacks,
  pruneLegacySemanticsPacks,
  replacePackContent,
  reapplyAppliedPacks,
  reapplyPack,
  clearContentForReplace,
  rejectGeneratedItem,
} from './packs.repo'
export type {
  ApplyResult,
  DedupePacksResult,
  EffectiveContent,
  EffectiveCoreSense,
  EffectiveMeaningMap,
  EffectiveMeaningSemantics,
  ImportPackResult,
  PackStats,
  ReapplyOptions,
  ReapplyProgress,
  ReplacePackResult,
} from './packs.repo'
export type {
  AppliedContent,
  ContentKind,
  CoreSenseV1,
  MeaningMapV1,
  ContentRejectRecord,
  FilterSet,
  PackCounts,
  PackExampleV1,
  PackFileV1,
  PackItemRecord,
  PackItemStatus,
  PackItemV1,
  PackKind,
  PackMetaV1,
  PackPhraseV1,
  PackPreview,
  PackRecord,
  PackSource,
  PackStatus,
  ResolvedItem,
  SkipReason,
  SkipRecord,
  Target,
  TargetPage,
  TargetPageOptions,
  TargetScope,
} from './packs/schema'
export { TARGET_PAGE_MAX } from './packs/schema'
export { LIMITS as PACK_LIMITS } from './packs/schema'

// ============ 词库管理（AC6） ============
export {
  listDecks,
  getDeck,
  getDeckProgress,
  createDeck,
  renameDeck,
  updateDeck,
  deleteDeck,
  setDefaultDeck,
  ensureSingleDefaultDeck,
  getWordsPage,
  getWord,
  getWords,
  searchWords,
  addWord,
  upsertWord,
  addWords,
  updateWord,
  deleteWord,
} from './decks.repo'
export type { CreateDeckInput, DeckProgress, WordPage, WordPageQuery } from './decks.repo'

// ============ 学习状态 / 每日队列 / 不熟悉度 ============
export {
  getState,
  getStates,
  getDeckStates,
  getWordWithState,
  getTodayQueue,
  getNextWords,
  submitRating,
  recordMeaningEncounters,
  recordMeaningClick,
  saveSessionSnapshot,
  loadSessionSnapshot,
  deleteSessionSnapshot,
  countDue,
} from './study.repo'
export type { SubmitRatingOptions, SubmitRatingResult, TodayQueueOptions, WordWithState } from './study.repo'

// ============ 设置（15 个 key，SPEC §5 / D48） ============
export {
  getSettings,
  getSetting,
  updateSettings,
  resetSettings,
  SETTINGS_DEFAULTS,
  SETTING_KEYS,
  isSettingKey,
  normalizeSettingValue,
  settingOrDefault,
} from './settings.repo'
export type { AppSettings } from './settings.repo'

// ============ 今日学习计划 v2（SPEC-v2 §6 / ARCH-v2 §3.2） ============
export {
  getTodayPlan,
  saveTodayPlan,
  hasResumablePlan,
  getCurrentWordId,
  setPlanIndex,
  advancePlanAfterRating,
  appendRequeue,
  completePlan,
  clearPlan,
  cleanupOldPlans,
  clearOldPlans,
  getHomeStudyData,
  getTodayBreakdown,
  getLastReviewSnapshot,
  getLastRatingRecord,
  undoLastRating,
  reRateInPlan,
  rateInPlan,
  ratedWordCount,
  recomputePlanForGoal,
  updateDailyGoalAndResync,
  normalizeDailyReviewCap,
} from './plans.repo'
export type {
  DailyGoalResyncResult,
  RecomputeGoalInput,
  RecomputeGoalResult,
  TodayPlanOptions,
} from './plans.repo'
export { mulberry32, planSeed, seededRandomFromPlan, newWordOrderKey, normalizeNewWordOrder } from './plan-random'
export type { NewWordOrder } from './plan-random'
export type {
  DailyPlan,
  HomeStudyData,
  HomeStudyState,
  LastReviewSnapshot,
  PlanRating,
  PlanWordSource,
  ReviewLogV2,
  TodayBreakdown,
  TodayBreakdownCounts,
  TodayWordCategory,
  TodayWordItem,
} from './plan.types'

// ============ 导入 / 导出（AC5） ============
export {
  exportDeck,
  exportMigration,
  buildDeckFile,
  buildMigrationFile,
  importDeckFile,
  importCsv,
  importMigration,
  clearAllData,
  getLastImportReport,
  deckFileName,
  migrationFileName,
  GENERATOR,
  APP_VERSION,
} from './import-export'
export type { ExportOptions, ImportOptions, MigrationFileWithMeta } from './import-export'

// ============ 统计 ============
export {
  getStatsOverview,
  getDailyStats,
  getDailyStatsRange,
  getStudyStreak,
  getFeedbackDistribution,
  getForgettingCurve,
  getReviewPressure,
  getUnfamiliarTop,
  getLastStudyDate,
  hasStudiedToday,
} from './stats.repo'
export type { AppStatsOverview, UnfamiliarTopDetail } from './stats.repo'

// ============ 词库格式：校验 / 规范化 / 工具（高级用法 / 测试） ============
export { parseDeckFile, parseMigrationFile, normalizeWordRecord, findIdRuleViolations } from './schema'
export type {
  ParsedDeckFile,
  ParsedMigrationFile,
  ParseResult,
  RawDeck,
  RawWord,
} from './schema'
export {
  buildWord,
  buildInitialState,
  parseMeaningString,
  dedupeMeanings,
  normalizePhonetic,
  meaningIdsOf,
} from './word-factory'
export type { RawMeaningInput, RawWordInput } from './word-factory'
export { parseCsv, csvToWordInputs } from './csv'
export {
  stableStringify,
  computeChecksum,
  verifyChecksum,
  sha256Hex,
  fnv1a64Hex,
  migrationChecksumPayload,
} from './checksum'
export type { ChecksumAlgo, ChecksumResult } from './checksum'

// ============ MaiMemo导入通道（task-8，SPEC §7） ============
export {
  importMaimemoProgress,
  importMaimemoRecords,
  setMaimemoSession,
  getMaimemoSession,
  mapStudyRecordsToStates,
  parseMaimemoRecordsJson,
  probeMaimemoToken,
  createMaimemoClient,
  MaimemoClient,
  isMaimemoError,
  parseMaimemoDate,
  formatMaimemoDate,
  MAIMEMO_MESSAGES,
  MANUAL_IMPORT_HINT,
  isNativeHttpAvailable,
  nativeFetch,
  cancelAllNativeRequests,
  maimemoMessageFor,
} from './api/maimemo'
export type {
  MaimemoImportResult,
  MaimemoError,
  MaimemoErrorCode,
  MaimemoSession,
  StudyRecord,
  MomoApiBridge,
  MomoApiBridgeResult,
} from './api/maimemo'

// ============ 类型再导出（UI 可以从 data 出口拿，不必深挖 core） ============
export type {
  Deck,
  DeckFile,
  ImportIssue,
  ImportReport,
  Meaning,
  MigrationFile,
  Rating,
  ReviewLog,
  SessionSnapshot,
  SettingKey,
  SettingRecord,
  SettingsMap,
  Word,
  WordState,
} from '../core'

// ============ AI 生成（task-70；UI 统一从 data 出口拿） ============
export {
  AI_MNEMONIC_TYPE_MAP,
  AI_SETTING_KEYS,
  DEFAULT_AI_CONFIG,
  PROMPT_VERSION_V3,
  SEMANTICS_OUTPUT_TOKENS,
  addRejectedTargetKeys,
  aggregateSemanticsLabels,
  buildGenerateTargets,
  clearAiApiKey,
  clearRejectedTargetKeys,
  createAiHttpClient,
  createLlmProvider,
  estimateBatchCost,
  estimateCost,
  formatCostYuan,
  generateItems,
  getRejectedTargetKeys,
  isNativeAiAvailable,
  loadAiConfig,
  loadAiSettings,
  maskApiKey,
  normalizeCoreSenseLabel,
  redactAiConfig,
  buildSemanticsRepairPromptV3,
  buildSystemPromptV3,
  buildUserPromptV3,
  selfMeaningSemanticsItem,
  stripCodeFence,
  validateSemanticsItems,
  resolveTransport,
  saveAiConfig,
  saveAiSettings,
  selectGenerateTargets,
  targetKey,
  toCoreMnemonicType,
} from './ai'
export type {
  AiConfig,
  AiError,
  AiErrorCode,
  AiProviderId,
  AiSettingsState,
  AiTransport,
  BuildTargetsOptions,
  CoreSense,
  GenerateDeps,
  GenerateRequest,
  GenerateResponse,
  GenerateResult,
  GenerateScope,
  GenerateTarget,
  GenerationKind,
  MeaningMapEntry,
  LlmProvider,
  PackExample,
  PackMnemonic,
  PackPhrase,
  SaveAiConfigOptions,
  SenseConfidence,
  SaveAiSettingsOptions,
  SingleContentKind,
  TokenUsage,
} from './ai'

export {
  appendGenerationDraftItems,
  clearGenerationDraft,
  createGenerationDraft,
  getGenerationDraft,
  listGenerationDrafts,
  updateGenerationDraftCursor,
} from './generation-draft'
export type {
  GenerationDraft,
  GenerationDraftItemInput,
  GenerationDraftMeta,
} from './generation-draft'
