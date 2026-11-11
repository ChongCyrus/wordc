/**
 * 内容包 `momo-pack` v1 —— 运行时校验 + 记录类型（SPEC-CONTENT-PACKS §2 / §3）。
 *
 * 设计（与迁移包一致）：
 * - zod 只校验形状/类型，产出结构化 `ImportIssue`（UI 可逐条展示）；
 * - checksum 校验在 `parsePackFile`（packs.repo）里做：canonical = stableStringify({format,formatVersion,kind,items})；
 * - 内容包**不覆盖词条本体**，只携带 examples/phrases/mnemonics。
 */

import { z } from 'zod'
import type { ImportIssue, Mnemonic } from '../../core'
import { normalizeHeadword } from '../../core'
import { makeIssue } from '../schema'
import { fnv1a64Hex, stableStringify } from '../checksum'

export const PACK_FORMAT = 'momo-pack'
export const PACK_FORMAT_VERSION = 1

/** 内容类型（mixed = 条目内可混合多种；导出/生成时按类型拆） */
export type PackKind = 'examples' | 'phrases' | 'mnemonics' | 'semantics' | 'mixed'
/** 单类内容类型（合并/拒绝记忆的粒度） */
export type ContentKind = 'examples' | 'phrases' | 'mnemonics' | 'semantics'
export type PackSource = 'ai' | 'manual' | 'import' | 'export'
export type PackStatus = 'reviewing' | 'partial' | 'applied' | 'empty'
export type PackItemStatus = 'pending' | 'approved' | 'rejected' | 'applied' | 'skipped'
export type SkipReason =
  | 'unknown-word'
  | 'unknown-meaning'
  | 'duplicate'
  | 'limit'
  | 'rejected'
  | 'invalid'

/** 合并后的内容上限（SPEC §2.3） */
export const LIMITS = {
  wordExamples: 8,
  meaningExamples: 4,
  phrases: 8,
  mnemonics: 4,
} as const

/** 助记类型（对齐 core `Mnemonic.type`；未知值回退「其他」） */
export const MNEMONIC_TYPES: ReadonlyArray<Mnemonic['type']> = [
  '联想',
  '谐音',
  '词根',
  '词源',
  '串记',
  '口诀',
  '其他',
]

const exampleSchema = z.object({
  en: z.string().min(1),
  cn: z.string().default(''),
})

const phraseSchema = z.object({
  en: z.string().min(1),
  cn: z.string().default(''),
  /** 覆盖条目级 meaningIndex（1 起）；缺省用条目级 */
  meaningIndex: z.number().int().min(1).optional(),
})

const mnemonicSchema = z.object({
  type: z.string().default('其他'),
  text: z.string().min(1),
})

/** 本义（core sense）：一个词的多条含义共享的「本义/派生链」节点（task-75） */
const coreSenseSchema = z.object({
  /** 条目内部编号（1 起，仅本 item 内有效；跨包合并时会重编号） */
  index: z.number().int().min(1),
  /** 本义标签（短中文/英文，如「抓住/握住」「容器」） */
  label: z.string().min(1),
  note: z.string().optional(),
  /** 来源：本义/引申/隐喻等（自由文本，UI 展示用） */
  origin: z.string().optional(),
  /** 置信度 high/medium/low；可缺失（缺失=未标注，AI 侧可自行按 low 处理） */
  confidence: z.enum(['high', 'medium', 'low']).optional(),
})

/** 含义 → 本义映射（1 起；coreSenseIndex 指向本 item 的 coreSenses） */
const meaningMapSchema = z.object({
  meaningIndex: z.number().int().min(1),
  coreSenseIndex: z.number().int().min(1),
  note: z.string().optional(),
  /** task-75：多步本义链（本义→引申→…，顺序即展示顺序）；可选，缺省时 UI 回退 label+note */
  steps: z.array(z.string().min(1)).optional(),
})

export const packItemSchema = z.object({
  headword: z.string().min(1),
  headwordLower: z.string().min(1).optional(),
  meaningIndex: z.number().int().min(1).optional(),
  examples: z.array(exampleSchema).optional(),
  phrases: z.array(phraseSchema).optional(),
  mnemonics: z.array(mnemonicSchema).optional(),
  /** task-75：w-c 本义/引申链（kind=semantics/mixed） */
  coreSenses: z.array(coreSenseSchema).optional(),
  meaningMap: z.array(meaningMapSchema).optional(),
})

export const packMetaSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    source: z.enum(['ai', 'manual', 'import', 'export']).optional(),
    provider: z.string().nullable().optional(),
    model: z.string().optional(),
    promptVersion: z.string().optional(),
    scope: z.unknown().optional(),
    createdBy: z.string().optional(),
    licenseNote: z.string().optional(),
    checksumAlgo: z.enum(['sha256', 'fnv1a64']).optional(),
  })
  .optional()

export const packFileSchema = z.object({
  format: z.literal(PACK_FORMAT),
  formatVersion: z.literal(PACK_FORMAT_VERSION),
  kind: z.enum(['examples', 'phrases', 'mnemonics', 'semantics', 'mixed']),
  createdAt: z.number().int().nonnegative(),
  generator: z.string().min(1),
  meta: packMetaSchema,
  items: z.array(packItemSchema).min(1).max(20000),
  checksum: z.string().min(8),
})

export type PackExampleV1 = z.infer<typeof exampleSchema>
export type PackPhraseV1 = z.infer<typeof phraseSchema>
export type PackMnemonicV1 = z.infer<typeof mnemonicSchema>
export type CoreSenseV1 = z.infer<typeof coreSenseSchema>
export type MeaningMapV1 = z.infer<typeof meaningMapSchema>
export type PackItemV1 = z.infer<typeof packItemSchema>
export type PackMetaV1 = NonNullable<z.infer<typeof packMetaSchema>>
export type PackFileV1 = z.infer<typeof packFileSchema>

/** 内容包文件 checksum 的 canonical 载荷（meta/generator/createdAt 不参与） */
export function packChecksumPayload(file: Pick<PackFileV1, 'format' | 'formatVersion' | 'kind' | 'items'>): string {
  return stableStringify({ format: file.format, formatVersion: file.formatVersion, kind: file.kind, items: file.items })
}

/** 单条内容的稳定 canonical（contentHash / 拒绝记忆用） */
export function contentCanonical(
  kind: ContentKind,
  headwordLower: string,
  meaningIndex: number | undefined,
  value: string,
): string {
  return stableStringify({
    kind,
    headwordLower,
    meaningIndex: meaningIndex ?? 0,
    value,
  })
}

/** 单条内容的稳定 hash（FNV-1a64，16 hex；跨环境确定，无需 WebCrypto） */
export function contentHash(
  kind: ContentKind,
  headwordLower: string,
  meaningIndex: number | undefined,
  value: string,
): string {
  return fnv1a64Hex(contentCanonical(kind, headwordLower, meaningIndex, value))
}

/** 规范化 en：trim + 小写（例句/词组去重 key） */
export function normalizeEn(en: string): string {
  return String(en ?? '').trim().toLowerCase()
}

/** 助记去重 key：`type:text` 规范化 */
export function mnemonicKey(mnemonic: PackMnemonicV1): string {
  return `${String(mnemonic.type ?? '其他').trim()}:${String(mnemonic.text ?? '').trim()}`
}

/** 英文/别名助记类型 → core 中文枚举（AI prompt 用 root/assoc/story；task-70 对齐） */
const MNEMONIC_TYPE_ALIASES: Record<string, Mnemonic['type']> = {
  root: '词根',
  etymology: '词源',
  assoc: '联想',
  association: '联想',
  story: '串记',
  mnemonic: '联想',
  sound: '谐音',
  homophone: '谐音',
  phrase: '口诀',
  other: '其他',
}

/** 把任意字符串助记类型收敛到 core 允许的枚举（中文原样；英文别名映射；未知 → 其他） */
export function normalizeMnemonicType(type: string | undefined): Mnemonic['type'] {
  const value = String(type ?? '').trim()
  if ((MNEMONIC_TYPES as readonly string[]).includes(value)) return value as Mnemonic['type']
  return MNEMONIC_TYPE_ALIASES[value.toLowerCase()] ?? '其他'
}

/** 条目规范化（补 headwordLower、trim 内容、丢弃空内容） */
export function normalizePackItem(item: PackItemV1): PackItemV1 | null {
  const headword = String(item.headword ?? '').trim()
  if (!headword) return null
  const out: PackItemV1 = {
    headword,
    headwordLower: normalizeHeadword(item.headwordLower || headword),
  }
  if (item.meaningIndex != null) out.meaningIndex = item.meaningIndex
  const examples = (item.examples ?? [])
    .map((example) => ({ en: String(example.en ?? '').trim(), cn: String(example.cn ?? '').trim() }))
    .filter((example) => example.en)
  const phrases = (item.phrases ?? [])
    .map((phrase) => {
      const next: PackPhraseV1 = { en: String(phrase.en ?? '').trim(), cn: String(phrase.cn ?? '').trim() }
      if (phrase.meaningIndex != null) next.meaningIndex = phrase.meaningIndex
      return next
    })
    .filter((phrase) => phrase.en)
  const mnemonics = (item.mnemonics ?? [])
    .map((mnemonic) => ({ type: normalizeMnemonicType(mnemonic.type), text: String(mnemonic.text ?? '').trim() }))
    .filter((mnemonic) => mnemonic.text)
  if (examples.length > 0) out.examples = examples
  if (phrases.length > 0) out.phrases = phrases
  if (mnemonics.length > 0) out.mnemonics = mnemonics
  // task-75：本义/引申链（去重 label，保留首个；index 保持条目内编号）
  const coreSenses = (item.coreSenses ?? [])
    .map((sense) => {
      const next: CoreSenseV1 = { index: sense.index, label: String(sense.label ?? '').trim() }
      if (sense.note) next.note = String(sense.note).trim()
      if (sense.origin) next.origin = String(sense.origin).trim()
      if (sense.confidence != null) next.confidence = sense.confidence
      return next
    })
    .filter((sense) => sense.label.length > 0)
  const seenLabels = new Set<string>()
  const dedupedSenses: CoreSenseV1[] = []
  for (const sense of coreSenses) {
    const key = sense.label.toLowerCase()
    if (seenLabels.has(key)) continue
    seenLabels.add(key)
    dedupedSenses.push(sense)
  }
  if (dedupedSenses.length > 0) out.coreSenses = dedupedSenses
  const meaningMap = (item.meaningMap ?? [])
    .map((entry) => {
      const next: MeaningMapV1 = {
        meaningIndex: entry.meaningIndex,
        coreSenseIndex: entry.coreSenseIndex,
      }
      if (entry.note) next.note = String(entry.note).trim()
      // steps：trim + 过滤空 + 单步 ≤120 字 + 最多 8 步（AI 侧更严格；导入时兜底防膨胀）
      const steps = (entry.steps ?? [])
        .map((step) => String(step).trim())
        .filter((step) => step.length > 0 && step.length <= 120)
        .slice(0, 8)
      if (steps.length > 0) next.steps = steps
      return next
    })
    .filter((entry) => entry.meaningIndex >= 1 && entry.coreSenseIndex >= 1)
  if (meaningMap.length > 0) out.meaningMap = meaningMap
  if (!out.examples && !out.phrases && !out.mnemonics && !out.coreSenses && !out.meaningMap) return null
  return out
}

/** 条目是否与 pack kind 匹配（mixed 任意；单类只允许对应内容） */
export function itemMatchesKind(item: PackItemV1, kind: PackKind): boolean {
  if (kind === 'mixed') return true
  if (kind === 'examples') return (item.examples ?? []).length > 0
  if (kind === 'phrases') return (item.phrases ?? []).length > 0
  if (kind === 'mnemonics') return (item.mnemonics ?? []).length > 0
  return (item.coreSenses ?? []).length > 0 || (item.meaningMap ?? []).length > 0
}

// ============ 记录类型（Dexie v3） ============

export interface PackCounts {
  items: number
  pending: number
  approved: number
  applied: number
  rejected: number
  skipped: number
}

export interface PackRecord {
  id: string
  name: string
  kind: PackKind
  formatVersion: number
  checksum: string
  source: PackSource
  provider?: string
  model?: string
  promptVersion?: string
  scope?: unknown
  status: PackStatus
  counts: PackCounts
  createdAt: number
  updatedAt: number
  appliedAt?: number
}

/** 已应用/合并进 Word 的内容（删除包时可精确回滚） */
export interface AppliedContent {
  examples: string[]
  phrases: string[]
  mnemonics: Array<{ type: Mnemonic['type']; text: string }>
}

export interface PackItemRecord {
  id: string
  packId: string
  seq: number
  headword: string
  headwordLower: string
  meaningIndex?: number
  wordId?: string
  meaningId?: string
  deckId?: string
  payload: PackItemV1
  status: PackItemStatus
  skipReason?: SkipReason
  /** 每条内容（examples/phrases/mnemonics）的稳定 hash，用于去重/拒绝记忆 */
  contentHashes: string[]
  appliedContent?: AppliedContent
  appliedAt?: number
  createdAt: number
}

export interface ContentRejectRecord {
  id: string
  kind: ContentKind
  headwordLower: string
  meaningIndex?: number
  hash: string
  rejectedAt: number
}

export interface SkipRecord {
  headwordLower: string
  meaningIndex?: number
  reason: SkipReason
  detail?: string
  itemId?: string
}

export interface ResolvedItem {
  itemId: string
  wordId: string
  deckId: string
  meaningId?: string
  item: PackItemV1
}

export interface PackPreview {
  matched: ResolvedItem[]
  skipped: SkipRecord[]
  counts: { total: number; matched: number; skipped: number }
}

/** 生成/选择目标（§4） */
export interface Target {
  wordId: string
  headword: string
  headwordLower: string
  deckId: string
  /** meaning scope 时给出含义序号（1 起）与 id */
  meaningIndex?: number
  meaningId?: string
  meanings: Array<{ id: string; pos?: string; cn: string }>
  existing: { examples: number; phrases: number; mnemonics: number }
}

export type TargetScope =
  | { kind: 'today'; deckId?: string }
  | { kind: 'deck'; deckId?: string; offset?: number; limit?: number }
  | { kind: 'word'; wordId: string }
  | { kind: 'meaning'; wordId: string; meaningId: string }
  /** 任意词库（task-84；deckId 必填，缺省不允许跨库猜） */
  | { kind: 'range'; deckId: string; prefix: string }
  | { kind: 'prefix'; deckId: string; prefix: string }
  /** 自定义选词（单词 id 列表；旧 'manual' 保留兼容） */
  | { kind: 'words'; wordIds: string[] }
  | { kind: 'manual'; wordIds: string[] }

/** 单次最多返回目标数（task-84） */
export const TARGET_PAGE_MAX = 500

export interface TargetPageOptions {
  offset?: number
  limit?: number
}

/** 分页结果：targets 为当前页；total 为过滤后总数；truncated=后面还有更多 */
export interface TargetPage {
  targets: Target[]
  total: number
  truncated: boolean
}

/** 排除条件（默认全开，§4.2） */
export interface FilterSet {
  /** 已有该类内容 → 跳过（默认 true） */
  excludeExisting?: boolean
  /** 已有 pending/approved 条目 → 跳过（默认 true，避免重复生成） */
  excludePending?: boolean
  /** 用户点过 ❌ 的同类内容 → 跳过（默认 true） */
  excludeRejected?: boolean
  /** 只选「缺该类内容」的目标（默认 true；与 excludeExisting 同义，保留 UI 语义） */
  missingOnly?: boolean
}

/** 构造一条 pack 解析/导入 issue（复用 ImportIssue 结构） */
export function packIssue(
  level: ImportIssue['level'],
  code: ImportIssue['code'],
  message: string,
  extra: { path?: string; row?: number } = {},
): ImportIssue {
  return makeIssue(level, code, message, extra)
}
