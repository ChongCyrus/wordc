/**
 * AI 生成服务公共类型（task-70）。
 *
 * 对应 docs/ARCH-CONTENT-PACKS.md §4–§7 与 docs/SPEC-CONTENT-PACKS.md §2（momo-pack）。
 * 本文件不依赖浏览器/Dexie，可被 Node CLI（arch task-73）复用。
 */

/** 内容类型（与 momo-pack kind 对齐） */
export type ContentKind = 'examples' | 'phrases' | 'mnemonics' | 'mixed'

/** 只生成这三类中的一种（生成请求的 kind 不允许 mixed） */
export type SingleContentKind = Exclude<ContentKind, 'mixed'>

/** 生成请求支持的 kind：三类内容 + 语义结构（本义/引申链） */
export type GenerationKind = SingleContentKind | 'semantics'

/** 本义/引申链的置信度（task-76） */
export type SenseConfidence = 'high' | 'medium' | 'low'

/** 一个「本义」（task-76 prompt v3 输出；落 momo-pack item.coreSenses） */
export interface CoreSense {
  /** 1 起，unique */
  index: number
  /** ≤8 字中文概括 */
  label: string
  /** 可选说明（≤60 字） */
  note?: string
  /** 可选来源说明（如「古英语原义」「词根义」「隐喻」） */
  origin?: string
  /** 置信度：无法可靠推演时 low */
  confidence: SenseConfidence
}

/** 某中文含义 → 本义的映射（落 momo-pack item.meaningMap） */
export interface MeaningMapEntry {
  /** 1 起，对应 Word.meanings 下标 */
  meaningIndex: number
  /** 指向 CoreSense.index */
  coreSenseIndex: number
  /** 可选：引申关系说明（≤60 字） */
  note?: string
  /** 可选：多步本义链（顺序即展示顺序，如 ["一起吃饭的人","一起做事的人","公司"]；缺省 UI 回退 [label, note]） */
  steps?: string[]
}

export type AiProviderId = 'deepseek' | 'openai-compatible'
export type AiTransport = 'auto' | 'proxy' | 'native'

/** 错误分类（UI 按类给文案；arch/Lead 约定命名） */
export type AiErrorCode =
  | 'AI_DISABLED'
  | 'AI_NO_KEY'
  | 'AI_AUTH'
  | 'AI_QUOTA'
  | 'AI_RATE_LIMIT'
  | 'AI_FORMAT'
  | 'AI_TIMEOUT'
  | 'AI_NETWORK'
  | 'AI_BAD_RESPONSE'
  | 'AI_EMPTY'
  | 'AI_COST_LIMIT'
  | 'AI_CANCELED'
  | 'AI_UNKNOWN'

export interface AiError {
  code: AiErrorCode
  /** 给用户/日志的错误摘要（**不得包含 apiKey**） */
  message: string
  /** 是否可重试（已由 generate 内部处理；UI 一般只看 code） */
  retryable?: boolean
  /** HTTP 状态码（若有） */
  status?: number
  /** 出错的 target key（`headwordLower#meaningIndex`） */
  targetKey?: string
}

/** token 用量（OpenAI 兼容 usage 字段） */
export interface TokenUsage {
  input: number
  output: number
  total: number
}

/** Provider 运行时配置（来自 settings `ai.*`，可被 UI/CLI 覆盖） */
export interface AiConfig {
  provider: AiProviderId
  /** provider baseURL；deepseek 默认 https://api.deepseek.com */
  baseUrl: string
  model: string
  /** ⚠️ 敏感：只在内存中用于 Authorization 头，不导出/不日志 */
  apiKey: string
  transport: AiTransport
  /** 每批目标数（1–50） */
  batchSize: number
  /** 单次运行成本上限（元；0=不限制） */
  maxCostPerRun: number
  temperature?: number
  timeoutMs?: number
  /**
   * 是否在请求体带 `response_format:{type:'json_object'}`。
   * 默认 true；智谱/硅基流动/火山/千帆等部分免费模型不支持时置 false，
   * 关闭后靠 prompt 约束 + 解析容错（stripCodeFence / JSON 修复重试）。
   */
  jsonMode?: boolean
  /** 浏览器本地代理地址（transport=proxy 时使用；默认 http://127.0.0.1:8788） */
  proxyUrl?: string
}

/** 一个生成目标（某词的某含义或整个词） */
export interface GenerateTarget {
  wordId: string
  headword: string
  headwordLower: string
  /** 可选：直接消费 data 层 packs.Target 时带上（生成 prompt 不使用） */
  deckId?: string
  /** 可选：含义 scope 的 meaningId（生成 prompt 不使用） */
  meaningId?: string
  /** 1 起的含义下标；省略=词级 */
  meaningIndex?: number
  meanings: Array<{ id: string; pos?: string; cn: string }>
  /** 已有内容数量（prompt 里让模型避开重复） */
  existing: { examples: number; phrases: number; mnemonics: number }
}

/** 生成结果里的内容条目（momo-pack v1 条目的子集） */
export interface PackExample {
  en: string
  cn: string
}

export interface PackPhrase {
  en: string
  cn: string
  /** 覆盖条目级含义下标（1 起） */
  meaningIndex?: number
}

export interface PackMnemonic {
  type: 'root' | 'assoc' | 'story'
  text: string
}

/** momo-pack v1 条目（定位用 headword/headwordLower + meaningIndex） */
export interface PackItemV1 {
  headword: string
  headwordLower?: string
  meaningIndex?: number
  examples?: PackExample[]
  phrases?: PackPhrase[]
  mnemonics?: PackMnemonic[]
  /** task-76：本义列表（1–3 个；仅 kind=semantics/mixed 使用） */
  coreSenses?: CoreSense[]
  /** task-76：每个中文含义 → 本义映射（必须覆盖全部含义） */
  meaningMap?: MeaningMapEntry[]
}

export interface GenerateRequest {
  kind: GenerationKind
  targets: GenerateTarget[]
  config: AiConfig
  signal?: AbortSignal
  onProgress?: (p: { done: number; total: number; costYuan: number }) => void
}

export interface GenerateResult {
  target: GenerateTarget
  /** 成功时的内容条目（未成功则 undefined） */
  item?: PackItemV1
  /** 单条目标失败原因 */
  error?: AiError
  /** 模型原始响应片段（调试用；已脱敏，不含 key） */
  raw?: string
  usage?: TokenUsage
}

export interface GenerateResponse {
  results: GenerateResult[]
  usage: TokenUsage
  /** 估算/累计成本（元） */
  costYuan: number
  /** 是否因取消而提前结束 */
  canceled: boolean
  /** 本次生成使用的 prompt 版本（UI 写 pack.meta.promptVersion 用；task-100） */
  promptVersion: string
}

/** 生成结果的单位置键：`headwordLower` 或 `headwordLower#meaningIndex` */
export function targetKey(headwordLower: string, meaningIndex?: number): string {
  return meaningIndex == null ? headwordLower : `${headwordLower}#${meaningIndex}`
}
