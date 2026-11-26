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
  insertMissingBuiltinWords,
  ensureBuiltinDeckWords,
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
  getPackApplyBreakdown,
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
  pruneSupersededBuiltinSemanticsPacks,
  replacePackContent,
  resetSemanticsData,
  reapplyAppliedPacks,
  reapplyPack,
  applyGeneratedPack,
  applyReplacementPack,
  clearContentForReplace,
  rejectGeneratedItem,
} from './packs.repo'
export type {
  ApplyResult,
  PackApplyBreakdown,
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
export type {
  CreateDeckInput, DeckProgress, WordPage, WordPageQuery } from './decks.repo'

// ============ 学习状态 / 每日队列 / 不熟悉度 ============
export {
  startTempReview,
  rateTempReview,
  captureTempReviewSnapshot,
  recordPracticeSelfRating,
  skipPracticeWord,
  summarizePracticeReview,
  summarizeTempReview,
  advanceTempReviewBatch,
  applyTempReviewToDhp,
} from './temp-review'
export type {
  TempReviewSession,
  TempReviewPracticeRating,
  TempReviewFamiliaritySnapshot,
  TempReviewRecordInput,
  TempReviewSummary,
  TempReviewSummaryItem,
  TempReviewRecordMode,
  StartTempReviewInput,
  RateTempReviewInput,
  TempReviewQueueItem,
  TempReviewOutcome,
  ApplyTempReviewToDhpResult,
} from './temp-review'

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
export type {
  SubmitRatingOptions, SubmitRatingResult, TodayQueueOptions, WordWithState } from './study.repo'
export {
  coreSenseStatKey,
  getCoreSenseStats,
  recordCoreSenseClick,
  recordCoreSenseEncounters,
  resolveCoreSenseStatKey,
} from './core-sense-stats'
export type {
  CoreSenseRef } from './core-sense-stats'
export {
  DEFAULT_GENERATED_META_KEY,
  DEFAULT_GENERATED_VERSION,
  GENERATED_DERIVATION_BUNDLE_PATH,
  GENERATED_SENSE_MNEMONICS_PATH,
  defaultGeneratedPaths,
  ensureDefaultGeneratedData,
  forceImportDefaultGeneratedData,
  getGeneratedSeedStatus,
  GENERATED_SEED_STATE_KEY,
} from './default-generated'
export type {
  EnsureDefaultGeneratedOptions,
  EnsureDefaultGeneratedResult,
  GeneratedSeedState,
  GeneratedSeedStatus,
} from './default-generated'

export { getWordDetailBundle, getWordSemanticSessionData } from './word-detail'
export type {
  WordDetailBundle,
  WordSemanticSessionData,
  WordSemanticSessionMeaning,
  WordSemanticSessionWord,
} from './word-detail'

export {
  getChapterWordIds,
  getDeckChapters,
  getDeckWordIds,
  getDeckProgressLocation,
  getRankingWordIds,
  getWordFamiliarityRanking,
  getWordsByChapter,
} from './deck-insights'
export type {
  DeckChapterSummary,
  DeckChapterWords,
  DeckProgressLocation,
  WordFamiliarityRanking,
  WordFamiliarityRankingItem,
  WordListSort,
  WordWithFamiliarity,
} from './deck-insights'

export {
  AUTO_BACKUP_FLAG_ANOMALY,
  AUTO_BACKUP_RESTORE_STATE_KEY,
  AUTO_BACKUP_RUN_STATE_KEY,
  AUTO_BACKUP_FLAG_HAD_PROGRESS,
  AUTO_BACKUP_FLAG_LAST_DATE,
  AUTO_BACKUP_KEEP,
  AUTO_BACKUP_MAX_BYTES,
  checkProgressAnomaly,
  deleteAutoBackup,
  listAutoBackups,
  restoreAutoBackup,
  getAutoBackupRestoreStatus,
  getAutoBackupRunStatus,
  runAutoBackup,
  runSqliteFactsAutoBackup,
} from './auto-backup'
export type {
  AutoBackupBridge,
  AutoBackupEntry,
  AutoBackupRestoreResult,
  AutoBackupRestorePhase,
  AutoBackupRestoreStatus,
  AutoBackupRunPhase,
  AutoBackupRunStatus,
  AutoBackupRunMode,
  AutoBackupRunResult,
  AutoBackupSaveResult,
} from './auto-backup'

export {
  clearCoreSenseExamples,
  getCoreSenseRepresentative,
  listCoreSenseExampleViews,
  listCoreSenseRepresentatives,
  saveCoreSenseExamples,
} from './core-sense-examples'
export type {
  CoreSenseExampleEntry,
  CoreSenseExampleView,
  CoreSenseExampleViews,
  CoreSenseRepresentative,
} from './core-sense-examples'
export {
  clearCoreSensePhrases,
  listCoreSensePhraseViews,
  listCoreSensePhrases,
  saveCoreSensePhrases,
} from './core-sense-phrases'
export type {
  CoreSensePhraseEntry, CoreSensePhraseView, CoreSensePhraseViews } from './core-sense-phrases'
export { clearCoreSenseOverview, getCoreSenseOverview, saveCoreSenseOverview } from './core-sense-overview'
export type {
  CoreSenseOverview } from './core-sense-overview'
export {
  CORE_SENSE_MNEMONIC_FORMAT,
  CORE_SENSE_MNEMONIC_VERSION,
  applyCoreSenseMnemonicImport,
  applyCoreSenseMnemonicImportParsed,
  buildCoreSenseMnemonicExport,
  coreSenseMnemonicFileName,
  exportCoreSenseMnemonicJson,
  importCoreSenseMnemonicJson,
  previewCoreSenseMnemonicImport,
} from './core-sense-mnemonics'
export type {
  CoreSenseMnemonicExportFile,
  CoreSenseMnemonicImportCounts,
  CoreSenseMnemonicImportOptions,
  CoreSenseMnemonicImportProgress,
  CoreSenseMnemonicParsedData,
  CoreSenseMnemonicPreviewReport,
  CoreSenseMnemonicResolvedOverview,
  CoreSenseMnemonicResolvedSense,
  CoreSenseMnemonicImportIssue,
  CoreSenseMnemonicImportReport,
  CoreSenseMnemonicSenseExport,
  CoreSenseMnemonicWordExport,
} from './core-sense-mnemonics'

export { generateCoreSenseOverview, validateCoreSenseOverviewDraft } from './ai/core-sense-overview'
export type {
  CoreSenseOverviewResult,
  GenerateCoreSenseOverviewOptions,
  CoreSenseOverviewPromptSource,
} from './ai/core-sense-overview'

export { generateCoreSenseExamples, generateCoreSensePhrases } from './ai/core-sense-content'
export type {
  CoreSenseExamplesResult,
  CoreSensePhrasesResult,
  CoreSenseExamplesPromptSource,
  CoreSensePhrasesPromptSource,
} from './ai/core-sense-content'


// ============ 设置（15 个 key，SPEC §5 / D48） ============
export {
  getSettings,
  getSetting,
  updateSettings,
  setSettingsWriteMode,
  getSettingsWriteMode,
  setSettingsCheckpointScheduler,
  applyImportedSettings,
  enableSettingsSqliteWrite,
  getRawSettingDiagnostics,
  persistSettingsWriteMode,
  restoreSettingsWriteMode,
  SETTINGS_WRITE_SOURCE_KEY,
  resetSettings,
  SETTINGS_DEFAULTS,
  SETTING_KEYS,
  isSettingKey,
  normalizeSettingValue,
  settingOrDefault,
} from './settings.repo'
export type {
  AppSettings, SettingsWriteMode, EnableSettingsSqliteResult, RawSettingDiagnostic } from './settings.repo'

// ============ 今日学习计划 v2（SPEC-v2 §6 / ARCH-v2 §3.2） ============
export {
  getTodayPlan,
  appendNewWordsToTodayPlan,
  appendWordsToTodayPlan,
  getManualNewWordCandidateIds,
  getManualNewWordCandidates,
  pickUnlearnedNewWords,
  removeUnlearnedAutoNewWords,
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
  healTodayPlanAfterStartup,
  rebuildPlanCacheFromSqlite,
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
export { reconcileTodayPlanToSqlite } from './plan-reconcile'
export type { ReconcilePlanResult, ReconcilePlanOptions } from './plan-reconcile'
export type {
  DailyGoalResyncResult,
  RecomputeGoalInput,
  RecomputeGoalResult,
  TodayPlanOptions,
} from './plans.repo'
export { mulberry32, planSeed, seededRandomFromPlan, newWordOrderKey, normalizeNewWordOrder } from './plan-random'
export type {
  NewWordOrder } from './plan-random'
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
  exportMigrationText,
  estimateMigrationBytes,
  FULL_BACKUP_MAX_BYTES,
  MigrationTooLargeError,
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
export type {
  ExportOptions, ImportOptions, ImportSqliteStageImpl, MigrationFileWithMeta, MigrationSizeEstimate } from './import-export'

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
export type {
  AppStatsOverview, UnfamiliarTopDetail } from './stats.repo'

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
export type {
  RawMeaningInput, RawWordInput } from './word-factory'
export { parseCsv, csvToWordInputs } from './csv'
export {
  stableStringify,
  computeChecksum,
  verifyChecksum,
  sha256Hex,
  fnv1a64Hex,
  migrationChecksumPayload,
} from './checksum'
export type {
  ChecksumAlgo, ChecksumResult } from './checksum'

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
  listGenerationDraftItems,
  listGenerationDrafts,
  updateGenerationDraftCursor,
} from './generation-draft'
export type {
  GenerationDraft,
  GenerationDraftItem,
  GenerationDraftItemInput,
  GenerationDraftMeta,
} from './generation-draft'

export { absorbAiPack, appendAiPack, mergeDuplicateAiPacks } from './ai-packs'
export type {
  AppendAiPackResult } from './ai-packs'

export {
  deleteAiMnemonic,
  deleteUserMnemonic,
  deleteUserNote,
  editAiMnemonic,
  hideMnemonic,
  listMergedMnemonics,
  listUserMnemonics,
  listUserNotes,
  mnemonicKey,
  unhideMnemonic,
  upsertUserMnemonic,
  upsertUserNote,
} from './user-content'
export type {
  MergedMnemonic, UserMnemonicInput, UserNoteInput } from './user-content'

export { deleteDerivationMap, getDerivationMap, saveDerivationMap } from './derivation-map'
export type {
  DerivationMap, DerivationMapInput } from './derivation-map'

export { generateDerivationMap, validateDerivationMapDraft } from './ai/derivation-map'
export type {
  DerivationMapDraft, DerivationMapResult, GenerateDerivationMapOptions } from './ai/derivation-map'

export { clearNc, clearNcMeaningIds, getNc, getNcMeaningIds, setNc, setNcMeaningIds } from './nc'
export { findSubwordMeanings } from './subword'
export type {
  SubwordMeaning } from './subword'
export {
  DERIVATION_JSON_FORMAT,
  DERIVATION_JSON_VERSION,
  buildDerivationJson,
  parseDerivationJson,
} from './derivation-json'
export type {
  DerivationJson, DerivationJsonLine, DerivationJsonParseResult } from './derivation-json'

export {
  DERIVATION_BUNDLE_FORMAT,
  DERIVATION_BUNDLE_MAX_BYTES,
  DERIVATION_BUNDLE_VERSION,
  exportAllDerivationMaps,
  importDerivationBundle,
  parseDerivationBundle,
} from './derivation-bundle'
export type {
  DerivationBundle,
  DerivationBundleImportResult,
  DerivationBundleItem,
  DerivationBundleParseResult,
} from './derivation-bundle'

export { generateRootMnemonic, validateRootMnemonicDraft } from './ai/root-mnemonic'
export type {
  RootMnemonicGenerateResult, GenerateRootMnemonicOptions } from './ai/root-mnemonic'
export type {
  RootMnemonicPromptSource } from './ai/prompts'
export { generateRareMeanings, generateRareMeaningsBatch, validateRareMeaningsDraft } from './ai/rare-meanings'
export {
  generateMultiObject,
  parseMultiObjectResponse,
  buildMultiObjectSystemPrompt,
  buildMultiObjectUserPrompt,
  clampMultiObjectSize,
  chunkMultiObjectSources,
  MULTI_OBJECT_DEFAULT_SIZE,
  MULTI_OBJECT_MAX_SIZE,
} from './ai/multi-object'
export { runGenerationJob } from './ai/generation-runner'
export type {
  RunGenerationJobOptions, RunGenerationJobResult } from './ai/generation-runner'
export {
  MULTI_OBJECT_ADAPTERS,
  getMultiObjectAdapter,
  runMultiObjectGeneration,
} from './ai/multi-object-adapters'
export type {
  MultiObjectAdapterKind,
  MultiObjectAdapter,
  MultiObjectAdapterDeps,
  RunMultiObjectGenerationOptions,
  RunMultiObjectGenerationResult,
} from './ai/multi-object-adapters'
export type {
  MultiObjectKind,
  MultiObjectSource,
  MultiObjectItem,
  MultiObjectGenerateResult,
  MultiObjectItemValidator,
  GenerateMultiObjectOptions,
} from './ai/multi-object'
export {
  ensureRootEtymologyPreinstall,
  getRootEtymologyPreinstallStatus,
  GENERATED_ROOT_ETYMOLOGY_BUNDLE_PATH,
  ROOT_ETYMOLOGY_PREINSTALL_META_KEY,
} from './preinstall-root-etymology'
export type {
  EnsureRootEtymologyPreinstallOptions,
  RootEtymologyPreinstallResult,
  RootEtymologyPreinstallMeta,
} from './preinstall-root-etymology'
export {
  ROOT_ETYMOLOGY_BUNDLE_FORMAT,
  ROOT_ETYMOLOGY_BUNDLE_VERSION,
  buildRootEtymologyBundle,
  exportRootEtymologyBundleText,
  importRootEtymologyBundle,
  isRootEtymologyBundle,
  validateRootEtymologyBundleInput,
  mergeRootEtymologyBundles,
} from './root-etymology-bundle'
export type {
  RootEtymologyBundleItem,
  RootEtymologyBundle,
  RootEtymologyBundleImportReport,
  RootEtymologyBundleExportOptions,
  RootEtymologyBundleValidation,
} from './root-etymology-bundle'
export {
  buildGenerationTargets,
  buildMultiKindGenerationTargets,
  GENERATION_TARGET_KINDS,
} from './generation-targets'
export type {
  GenerationTargetKind,
  GenerationTargetItem,
  BuildGenerationTargetsInput,
  BuildGenerationTargetsResult,
} from './generation-targets'
export {
  GENERATION_JOBS_KEY,
  GENERATION_JOBS_MAX,
  listGenerationJobs,
  getGenerationJob,
  createGenerationJob,
  updateGenerationJob,
  appendGenerationJobResult,
  appendGenerationJobFailed,
  getGenerationJobPendingTargets,
  clampGenerationConcurrency,
  clampGenerationBatchSize,
  resumeGenerationJob,
  getGenerationJobProgress,
  pauseGenerationJob,
  cancelGenerationJob,
  deleteGenerationJob,
  renameGenerationJob,
  clearFinishedGenerationJobs,
} from './generation-jobs'
export type {
  GenerationJobStatus,
  GenerationJobFailedItem,
  GenerationJob,
  GenerationJobTarget,
} from './generation-jobs'
export {
  buildStateCheckpoint,
  saveStateCheckpoint,
  scheduleStateCheckpoint,
  flushStateCheckpoint,
  restoreStateCheckpointIfEmpty,
  getStateCheckpointStatus,
  STATE_CHECKPOINT_FORMAT,
  STATE_CHECKPOINT_VERSION,
  STATE_CHECKPOINT_LATEST,
  STATE_CHECKPOINT_KEEP,
} from './state-checkpoint'
export type {
  StateCheckpoint,
  StateCheckpointCounts,
  StateCheckpointStatus,
} from './state-checkpoint'
export {
  setSqliteTransport,
  isSqliteAvailable,
  sqliteCall,
  sqliteHealth,
  sqliteExec,
  sqliteTx,
  sqliteQuery,
  sqliteBackup,
  sqliteRestoreDb,
  sqliteIntegrity,
  SqliteError,
} from './native-sqlite'
export type {
  SqliteErrorCode,
  SqliteTransport,
  SqliteCallOptions,
  SqliteResponse,
} from './native-sqlite'
export {
  SQLITE_SCHEMA_VERSION,
  SQLITE_DB_NAME,
  SQLITE_DDL,
  ensureSqliteReady,
  ensureSqliteSchema,
  getSqliteHealth,
  sqliteStoreExec,
  sqliteStoreTx,
  sqliteStoreQuery,
  sqliteStoreBackup,
  sqliteStoreRestoreDb,
  sqliteStoreIntegrity,
} from './sqlite-store'
export type {
  SqliteHealthInfo, SqliteColumn, SqliteQueryResult, SqliteBackupResult } from './sqlite-store'
export { ensureM4b0Schema, getIdbFactCounts } from './sqlite-store'
export type {
  M4b0SchemaOptions, M4b0SchemaResult } from './sqlite-store'
export { SQLITE_ALLOWED_TABLES } from './sqlite-store'
export type {
  SqliteTable } from './sqlite-store'
export { getRawPlanDiagnostics } from './plan-diagnostics'
export type {
  PlanDiagnostics, RawSqlitePlanDiagnostic } from './plan-diagnostics'
export {
  repairMigratedPlans,
} from './plan-repair'
export type {
  PlanRepairChange,
  PlanRepairResult,
  RepairPlansOptions,
} from './plan-repair'
export {
  rebuildIdbCacheFromSqlite,
} from './cache-rebuild'
export type {
  CacheRebuildCounts,
  CacheRebuildResult,
  RebuildCacheOptions,
} from './cache-rebuild'
export {
  readStateThroughCache,
  readStatesThroughCache,
  readPlanThroughCache,
  readSettingsThroughCache,
  bootstrapM2ReadCache,
  primeM2ReadCacheForTests,
} from './sqlite-read'
export type {
  M2BootstrapResult } from './sqlite-read'
export {
  IDB_CACHE_META_KEY,
  getIdbCacheMeta,
  writeIdbCacheMeta,
  markIdbCacheDirty,
  clearIdbCacheDirty,
  isIdbCacheStale,
  readThroughIdbCache,
  rebuildIdbCache,
  idbCacheReady,
  getIdbCacheDiagnostics,
} from './idb-cache'
export type {
  IdbCacheMeta, RebuildIdbCacheInput } from './idb-cache'
export { getDataEpoch, bumpDataEpoch, DATA_EPOCH_KEY } from './data-epoch'
export { localDateKey } from '../core'
export { planIdOf } from './plan-core'
export {
  SQLITE_MIGRATION_VERSION,
  SQLITE_MIGRATION_STEP,
  readLegacyIdbMigrationData,
  migrateIdbToSqlite,
  sqliteMigrationTargetVersion,
} from './migration-sqlite'
export type {
  SqliteMigrationCounts,
  SqliteMigrationResult,
  MigrateIdbToSqliteOptions,
} from './migration-sqlite'
export {
  gatherDataSafetyDiagnostics,
  serializeSafetyDiagnostics,
  SAFETY_DIAGNOSTICS_FILE,
} from './safety-diagnostics'
export type {
  SafetyDiagnosticsPackage,
  GatherSafetyDiagnosticsOptions,
} from './safety-diagnostics'
export {
  getLearningWriteSource,
  restoreLearningWriteSource,
  requestSourceRecovery,
  shouldReloadForSourceRecovery,
  getLearningWriteDiagnostics,
  enableLearningSqliteWrite,
  revertLearningWriteSourceToIdb,
  persistLearningWriteSource,
  assertIdbMutationAllowed,
  recoverReadonlySourceFromSqlite,
  diagnoseAndRecoverSqliteSource,
  LearningWriteRetryableError,
  LearningWriteReadonlyError,
  LEARNING_WRITE_SOURCE_KEY,
} from './learning-write-source'
export type { LearningWriteSource, EnableLearningSqliteResult, LearningWriteRestoreDiag } from './learning-write-source'
export {
  repairLearningWriteSource,
  recoverInterruptedWriteSource,
  getWriteSourceRecoveryDiagnostics,
} from './write-source-recovery'
export type { RecoverWriteSourceResult } from './write-source-recovery'
export {
  ensureLegacyIdbMigratedToSqlite,
  getLegacyUpgradeDiagnostics,
  LEGACY_UPGRADE_DIAG_KEY,
} from './upgrade-migration'
export type { LegacyUpgradeResult } from './upgrade-migration'
export { submitRatingSqlite, flushRatingCacheWarmup, getRatingCacheDebugEvents } from './study-sqlite'
export { reRateInPlanSqlite } from './plan-sqlite'
export type { SubmitRatingSqliteOptions, SubmitRatingSqliteResult } from './study-sqlite'
export {
  markStartupPhase,
  finishStartupTiming,
  getStartupTiming,
  resetStartupTiming,
} from './startup-timing'
export type {
  StartupTiming } from './startup-timing'
export {
  createSqliteFactsBackup,
  listSqliteBackupFiles,
  listValidSqliteBackupFiles,
  deleteSqliteBackupFile,
  saveSqliteBackupManifest,
  getSqliteBackupManifest,
  deleteSqliteBackupManifest,
  listValidSqliteBackups,
  preflightSqliteRestore,
  getSqliteFactsManifest,
  restoreSqliteFactsBackup,
  isRestorableBackup,
  createSafetySnapshot,
  deleteSafetySnapshot,
  SQLITE_BACKUP_PREFIX,
} from './sqlite-backup'
export type { SqliteBackupManifest, CreateSqliteBackupResult, SqliteBackupFileEntry } from './sqlite-backup'
export {
  buildSqliteFactsCheckpoint,
  saveSqliteFactsCheckpoint,
  scheduleSqliteFactsCheckpoint,
  flushSqliteFactsCheckpoint,
  restoreSqliteFactsCheckpointIfEmpty,
  deleteSqliteFactsCheckpoints,
  setSqliteFactsCheckpointBridge,
  notifySqliteFactsChanged,
  flushSqliteFactsCheckpointAuto,
  getSqliteCheckpointStatus,
  SQLITE_CHECKPOINT_LATEST,
  SQLITE_CHECKPOINT_KEEP,
} from './sqlite-checkpoint'
export type { SqliteFactsCheckpoint } from './sqlite-checkpoint'
export {
  buildIdbRollbackCache,
  buildRollbackMigrationText,
  detectIdbDeltaSinceSqlite,
  applyIdbDeltaToSqlite,
  ROLLBACK_MANIFEST_KEY,
} from './idb-rollback'
export type { RollbackManifest } from './idb-rollback'
export { clearAllSqliteFacts } from './sqlite-clear'
export { getImportStageDiagnostics } from './import-diagnostics'
export { createFactsPreBackup } from './facts-prebackup'
export type { FactsPreBackupResult } from './facts-prebackup'
export {
  buildContentSnapshot,
  diffContentEntries,
  buildContentIncrement,
  validateContentIncrement,
  CONTENT_SNAPSHOT_FORMAT,
  CONTENT_INCREMENT_FORMAT,
  CONTENT_SNAPSHOT_VERSION,
} from './content-snapshot'
export type {
  ContentEntry,
  ContentSnapshotManifest,
  ContentEntity,
  ContentTombstone,
  ContentIncrementPackage,
  ContentDelta,
  BuildContentSnapshotOptions,
  BuildContentIncrementOptions,
} from './content-snapshot'
export {
  exportContentEntities,
  buildContentBaselineFile,
  saveContentBaselineFile,
  saveContentIncrementFile,
  restoreContentBaseline,
  restoreContentIncrementChain,
  saveContentBaselineChunked,
  restoreContentBaselineIndexed,
  getContentChainState,
  setContentChainState,
  markContentChainFailure,
  markContentChainSuccess,
  CONTENT_CHAIN_META_KEY,
} from './content-snapshot'
export type { ContentChainState, ContentBackupStorage, ContentBaselineFile } from './content-snapshot'
export {
  setContentBackupStorage,
  createContentBaseline,
  createContentIncrement,
  listContentBackups,
  restoreContentBackup,
  getContentBackupStatus,
  runContentAutoBackup,
  consumeInterruptedContentRestore,
  acknowledgeInterruptedContentRestore,
} from './content-backup'
export type { ContentBackupStatus, ContentBackupListItem } from './content-backup'
export {
  recordContentOp,
  recordContentOpsAfterTx,
  listContentOpsAfter,
  getContentEventLogState,
  markContentEventLogDirty,
  resetContentEventLog,
  isContentEventLogEnabled,
  CONTENT_EVENT_LOG_KEY,
} from './content-event-log'
export type { ContentEventOp, ContentEventLogState, ContentOpKind } from './content-event-log'
export {
  CONTENT_SCHEMA_VERSION,
  CONTENT_REVISION_KEY,
  CONTENT_PAGE_SIZE,
  readContentRevision,
  readContentCounts,
  assertContentSchemaVersion,
  listContentByRevision,
  writeContentRows,
  getContentRow,
  putContentRow,
  deleteContentRow,
} from './content-store'
export type { ContentKind as ContentKvKind, ContentKvRow, ContentListResult, ContentWriteInput } from './content-store'
export { buildContentMigrationPlan, runContentMigrationBatches, runContentMigrationShadow, runContentMigrationFormal, canSwitchContentWriteSource, finalizeContentWriteCoverage, getContentMigrationState, CONTENT_MIGRATION_STATE_KEY, ensureContentSourceV15, getContentSourceV15Status, CONTENT_SOURCE_V15_EVENT } from './content-migration-plan'
export type { ContentMigrationStateView, EnsureContentSourceV15Result } from './content-migration-plan'
export { switchContentWriteSource, rollbackContentWriteSource, resetContentWriteSourceForImport, discardStaleContentKv, reconcileInterruptedContentMigration, ensureContentSourceAfterImport, clearContentWriteSourceEmergency } from './content-switch'
export type { ContentSourceAfterImportResult } from './content-switch'
export { rebuildContentCacheFromSqlite } from './content-cache-rebuild'
export type { ContentCacheRebuildResult, ContentCacheRebuildTestHooks } from './content-cache-rebuild'
export {
  getContentWriteSource,
  getLegacyContentWriteSource,
  isNativeContentSqliteRuntime,
  isContentMigrationV15Done,
  getContentMigrationV15State,
  invalidateContentMigrationV15Cache,
  saveWordOverlay,
  saveContentEntitiesBatch,
  saveContentEntitiesChunked,
  ContentWriteError,
  CONTENT_WRITE_SOURCE_KEY,
  CONTENT_WRITE_SOURCE_EMERGENCY_KEY,
  CONTENT_MIGRATION_V15_KEY,
  CONTENT_V15_MIGRATION_STEP,
} from './content-write-source'
export type { ContentEntityRow, SaveContentEntitiesResult, ContentMigrationV15State, ContentMigrationV15Status, ContentMigrationV15From } from './content-write-source'
export type { ContentWriteSource } from './content-write-source'
export type { ContentMigrationBatch } from './content-migration-plan'
export { withDataWriteLock, pendingDataWrites } from './write-lock'
export { diffReplaceDeckWords } from './word-mutation'
export type {
  WordDiffResult } from './word-mutation'
export {
  partStatKey,
  getPartStats,
  recordPartEncounters,
  recordPartClick,
  getPartUnfamiliarity,
  getPartTotals,
} from './part-stats'
export type {
  PartRating } from './part-stats'
export { buildRootAffixMappings } from './root-affix'
export type {
  RootAffixExample,
  RootAffixPartMapping,
  RootAffixWordMapping,
  RootAffixMappingItem,
  BuildRootAffixMappingsOptions,
  RootAffixMappingsResult,
} from './root-affix'
export {
  queryAdvancedFilter,
  listSavedFilterSets,
  saveFilterSet,
  renameFilterSet,
  deleteFilterSet,
  takeFirstWordIds,
  chunkWordIds,
  SAVED_FILTER_SETS_KEY,
  SAVED_FILTER_SETS_MAX,
} from './advanced-filter'
export type {
  FilterGroupMatch,
  FilterField,
  FilterOperator,
  FilterCondition,
  FilterGroup,
  AdvancedFilter,
  AdvancedFilterQuery,
  AdvancedFilterItem,
  AdvancedFilterGroupSummary,
  AdvancedFilterResult,
  SavedFilterSet,
} from './advanced-filter'
export {
  generateRootEtymology,
  generateRootEtymologyBatch,
  buildRootEtymologySystemPrompt,
  buildRootEtymologyUserPrompt,
  toRootEtymologyPromptSource,
  ROOT_ETYMOLOGY_PROMPT_VERSION,
} from './ai/root-etymology'
export type {
  RareMeaningsGenerateResult,
  RareMeaningsPromptSource,
  RareMeaningsBatchItemResult,
  RareMeaningsBatchResult,
  GenerateRareMeaningsOptions,
  GenerateRareMeaningsBatchOptions,
} from './ai/rare-meanings'

export { clearRootMnemonic, getRootMnemonic, saveRootMnemonic } from './root-mnemonic'
export type {
  RootMnemonic } from './root-mnemonic'
export {
  clearRareCoreSenses,
  clearRareMeaningIds,
  filterStudyMeanings,
  getRareCoreSenseIndexes,
  getRareMeaningIds,
  getStudyMeanings,
  listRareCoreSenseViews,
  listRareCoreSenses,
  setRareMeaningIds,
  setRareCoreSenseIndexes,
  setRareCoreSenses,
  setRareMeaningIndexes,
  toggleRareMeaningId,
  getRareMarkCandidates,
  rareMarkStatusOf,
  applyRareMarkResults,
  saveRareMarkBatchJob,
  getRareMarkBatchJob,
  clearRareMarkBatchJob,
  RARE_MARK_VERSION,
  RARE_BATCH_META_KEY,
} from './rare-meanings'
export {
  ROOT_ETYMOLOGY_VERSION,
  normalizeRootEtymologyParts,
  validateRootEtymologyDraft,
  getRootEtymology,
  saveRootEtymology,
  deleteRootEtymology,
  applyRootEtymologyResults,
  getRootEtymologyCandidates,
} from './root-etymology'
export type {
  RootEtymologyDraft,
  SaveRootEtymologyOptions,
  RootEtymologyApplyItem,
  RootEtymologyCandidatesInput,
  RootEtymologyCandidateWord,
} from './root-etymology'
export type {
  RareCoreSense,
  RareCoreSenseView,
  RareCoreSenseViews,
  RareMarkStatus,
  RareMarkSource,
  RareMarkCandidatesInput,
  RareMarkCandidateWord,
  RareMarkCounts,
  RareMarkCandidatesResult,
  RareMarkApplyItem,
  RareMarkApplyResult,
  RareMarkBatchJob,
} from './rare-meanings'

export {
  applySenseMnemonicSuggestions,
  clearAllSenseMnemonics,
  clearSenseMnemonic,
  collectSenseMnemonicSources,
  listSenseMnemonicViews,
  listSenseMnemonics,
  saveSenseMnemonic,
} from './sense-mnemonic'
export type {
  SenseMnemonic,
  SenseMnemonicApplyResult,
  SenseMnemonicInput,
  SenseMnemonicScope,
  SenseMnemonicSource,
  SenseMnemonicSuggestion,
  SenseMnemonicView,
  SenseMnemonicViews,
} from './sense-mnemonic'
export {
  generateSenseMnemonic,
  generateSenseMnemonicBatch,
  validateSenseMnemonicDraft,
} from './ai/sense-mnemonic'
export type {
  SenseMnemonicGenerateResult,
  SenseMnemonicBatchItemResult,
  SenseMnemonicBatchProgress,
  SenseMnemonicBatchResult,
  GenerateSenseMnemonicOptions,
  GenerateSenseMnemonicBatchOptions,
  SenseMnemonicPromptSource,
} from './ai/sense-mnemonic'
