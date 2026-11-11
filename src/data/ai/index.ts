/**
 * AI 生成服务出口（task-70）。
 *
 * UI/CLI 只从这里 import；内部文件：
 * - types.ts     公共类型（无浏览器依赖）
 * - prompts.ts   prompt 模板 v1（与 arch 批量 CLI task-73 共用；纯函数）
 * - cost.ts      成本估算/预算（纯函数）
 * - provider.ts  DeepSeek/OpenAI 兼容 provider + 错误分类（key 不入错误）
 * - transport.ts 浏览器代理 / APK 原生桥 / 注入 fetch
 * - generate.ts  批量生成（并发 3、修复重试、429 退避、取消、成本上限）
 * - targets.ts   生成范围与排除（复用 data 层查询）
 * - settings.ts  ai.* 设置读写、key 掩码/导出脱敏
 *
 * 隐私：`ai.apiKey` 仅本机；本模块任何日志/错误/导出上下文都不含 key（用 sanitize/redact）。
 */

export type {
  AiConfig,
  AiError,
  AiErrorCode,
  AiProviderId,
  AiTransport,
  ContentKind,
  CoreSense,
  GenerateRequest,
  GenerateResponse,
  GenerateResult,
  GenerateTarget,
  GenerationKind,
  MeaningMapEntry,
  PackExample,
  PackItemV1,
  PackMnemonic,
  PackPhrase,
  SenseConfidence,
  SingleContentKind,
  TokenUsage,
} from './types'
export { targetKey } from './types'

export {
  AI_DEFAULT_TIMEOUT_MS,
  AI_MAX_RESPONSE_BYTES,
  AI_PROXY_DEFAULT_URL,
  AiNetworkError,
  AiTimeoutError,
  createAiHttpClient,
  createFetchHttpClient,
  createNativeHttpClient,
  createProxyHttpClient,
  isNativeAiAvailable,
  resolveTransport,
} from './transport'
export type { AiApiBridge, AiApiBridgeResult, AiHttpClient, AiHttpRequest, AiHttpResponse } from './transport'

export {
  AiRequestError,
  buildChatUrl,
  classifyHttpStatus,
  createLlmProvider,
  parseChatResponse,
  sanitizeSnippet,
} from './provider'
export type { ChatBody, ChatMessage, ChatResponse, CreateLlmProviderOptions, LlmProvider } from './provider'

export {
  AI_MNEMONIC_TYPE_MAP,
  CONTENT_LIMITS,
  MNEMONIC_TYPES,
  PACK_ITEMS_JSON_SCHEMA,
  PROMPT_VERSION,
  PROMPT_VERSION_V3,
  SEMANTICS_JSON_SCHEMA,
  buildRepairPrompt,
  buildSemanticsRepairPromptV3,
  buildSystemPrompt,
  buildSystemPromptV3,
  buildUserPrompt,
  buildUserPromptV3,
  toCoreMnemonicType,
} from './prompts'
export type { BuildUserPromptOptions, RawPackItem, SemanticsPromptTarget } from './prompts'

export {
  DEFAULT_MODEL_PRICE,
  INPUT_TOKENS_BASE,
  INPUT_TOKENS_PER_TARGET,
  MODEL_PRICES,
  OUTPUT_TOKENS_PER_ITEM,
  SEMANTICS_OUTPUT_TOKENS,
  addUsage,
  emptyUsage,
  estimateBatchCost,
  estimateBatchTokens,
  estimateCost,
  estimateTextTokens,
  formatCostYuan,
} from './cost'
export type { ModelPrice } from './cost'

export {
  MAX_CONCURRENCY,
  MAX_REPAIR_RETRIES,
  RATE_LIMIT_BACKOFF_MS,
  SERVER_BACKOFF_MS,
  coreSenseSchema,
  extractJsonObject,
  generateItems,
  makeAiError,
  meaningMapEntrySchema,
  packExampleSchema,
  packItemSchema,
  packItemsResponseSchema,
  packMnemonicSchema,
  packPhraseSchema,
  aggregateSemanticsLabels,
  normalizeCoreSenseLabel,
  selfMeaningSemanticsItem,
  semanticsItemSchema,
  semanticsMeaningEntrySchema,
  semanticsMeaningItemSchema,
  semanticsMeaningsResponseSchema,
  semanticsResponseSchema,
  stripCodeFence,
  validateGeneratedItems,
  validateSemanticsItems,
} from './generate'
export type {
  GenerateDeps,
  PackItemsResponse,
  SemanticsAggregateResult,
  SemanticsMeaningEntry,
  SemanticsMeaningItem,
  SemanticsValidateTarget,
  SleepFn,
} from './generate'

export {
  addRejectedTargetKeys,
  buildGenerateTargets,
  clearRejectedTargetKeys,
  getRejectedTargetKeys,
  selectGenerateTargets,
} from './targets'
export type { BuildTargetsOptions, GenerateScope, TargetSourceWord } from './targets'

export {
  AI_SETTING_KEYS,
  DEFAULT_AI_CONFIG,
  clearAiApiKey,
  getSessionApiKey,
  loadAiConfig,
  loadAiSettings,
  maskApiKey,
  redactAiConfig,
  saveAiConfig,
  saveAiSettings,
  setSessionApiKey,
} from './settings'
export type { AiSettingsState, SaveAiConfigOptions, SaveAiSettingsOptions } from './settings'
