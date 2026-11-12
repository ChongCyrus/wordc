/**
 * 本义 / 引申链（semantics）校验与聚合（task-76）—— **纯模块，无浏览器/Dexie/window 依赖**。
 *
 * 供 App（generate.ts）与 Node CLI（arch task-78）共用。
 * **自包含**：运行时只 import `zod`（唯一第三方依赖）；不 import 任何相对路径模块，
 * 因此 Node 24 的 type-stripping 可直接 `import('./src/data/ai/semantics.ts')`（CLI 无需构建）。
 * - v3.4：模型对每个 c 输出 coreSenseLabel → `aggregateSemanticsLabels` 按 label 聚合出
 *   现有 momo-pack 结构（coreSenses + meaningMap）；
 * - 兼容：旧 v3.3 coreSenses 格式用 `validateSemanticsItems`。
 * - ⚠️ 下方 `normalizeHeadword`/`targetKey` 是 `src/core/ids.ts` 的**逐字等价实现**（为保持自包含）；
 *   若 core 规则变更需同步本文件（tests/data/ai/semantics.test.ts 有归一/聚合行为断言）。
 */

import { z } from 'zod'
import type { CoreSense, MeaningMapEntry, PackItemV1 } from './types'

// ============ 自包含的 core id 工具（与 src/core/ids.ts 逐字等价） ============

/** 同 `src/core/ids.ts::normalizeHeadword`：trim → 合并连续空白 → 小写 */
function normalizeHeadword(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 同 `src/core/types.ts::targetKey`：词级 = headwordLower；含义级 = headwordLower#index */
function targetKey(headwordLower: string, meaningIndex?: number): string {
  return meaningIndex == null ? headwordLower : `${headwordLower}#${meaningIndex}`
}

// ============ semantics（本义/引申链，task-76）schema 与校验 ============

export const coreSenseSchema = z.object({
  index: z.number().int().min(1).max(99),
  label: z.string().min(1).max(40),
  note: z.string().max(200).optional(),
  origin: z.string().max(120).optional(),
  // 宽容：缺失/非法 confidence 归一为 low（不因模型漏字段直接失败）
  confidence: z.enum(['high', 'medium', 'low']).optional().catch(undefined),
})

export const meaningMapEntrySchema = z.object({
  meaningIndex: z.number().int().min(1).max(99),
  coreSenseIndex: z.number().int().min(1).max(99),
  note: z.string().max(200).optional(),
  /** 可选：多步本义链（顺序即展示顺序；task-75 新增） */
  steps: z.array(z.string().max(120)).max(8).optional(),
})

export const semanticsItemSchema = z.object({
  headword: z.string().min(1).max(120),
  headwordLower: z.string().min(1).max(120).optional(),
  coreSenses: z.array(coreSenseSchema).min(1).max(3),
  meaningMap: z.array(meaningMapEntrySchema).min(1).max(50),
})

export const semanticsResponseSchema = z.object({
  items: z.array(semanticsItemSchema).max(200),
})

const CONFIDENCE_VALUES: readonly string[] = ['high', 'medium', 'low']
function normalizeConfidence(value: unknown): 'high' | 'medium' | 'low' {
  return typeof value === 'string' && CONFIDENCE_VALUES.includes(value)
    ? (value as 'high' | 'medium' | 'low')
    : 'low'
}

/**
 * `validateSemanticsItems` 可接受的最小目标形状（**CLI 可直接用**，不必构造 GenerateTarget 的 wordId/existing）。
 */
export interface SemanticsValidateTarget {
  headword: string
  headwordLower?: string
  meaningIndex?: number
  meanings: Array<{ id?: string; pos?: string; cn: string }>
}

export interface SemanticsValidationResult {
  byKey: Map<string, PackItemV1>
  error?: string
}

/**
 * 语义结构响应校验 + 归一（纯函数，供 generate 与单测）：
 * - coreSenses：1–3；label 去重合并（重复 label 指向首个）；confidence 缺失→low（note 标记）；
 * - meaningMap：必须覆盖该词全部 meaningIndex（1..N）且不重复；coreSenseIndex 必须存在；
 * - 输出 item.coreSenses / item.meaningMap（momo-pack 可选字段）。
 */
export function validateSemanticsItems(input: {
  json: unknown
  targets: readonly SemanticsValidateTarget[]
}): SemanticsValidationResult {
  const parsed = semanticsResponseSchema.safeParse(input.json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      byKey: new Map(),
      error: `schema 校验失败：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    }
  }
  const targetsByLower = new Map<string, SemanticsValidateTarget>()
  for (const t of input.targets) {
    const lower = t.headwordLower ?? normalizeHeadword(t.headword)
    targetsByLower.set(lower, t)
  }
  const byKey = new Map<string, PackItemV1>()

  for (const raw of parsed.data.items) {
    const lower = normalizeHeadword(raw.headwordLower ?? raw.headword)
    const target = targetsByLower.get(lower)
    if (!target) continue
    const meaningCount = Math.max(1, target.meanings.length)

    // 1) coreSenses 去重（by label，忽略大小写/空白）并 reindex
    const kept: Array<{ oldIndex: number; sense: CoreSense }> = []
    const labelToNew = new Map<string, number>()
    const oldToNew = new Map<number, number>()
    const oldToKeptOld = new Map<number, number>()
    for (const rawSense of raw.coreSenses) {
      const label = rawSense.label.trim()
      const key = label.toLowerCase()
      const existingNew = labelToNew.get(key)
      if (existingNew != null) {
        oldToKeptOld.set(rawSense.index, existingNew) // 记为已存在的新 index
        continue
      }
      const next: CoreSense = {
        index: 0,
        label,
        confidence: normalizeConfidence(rawSense.confidence),
      }
      const missingConfidence = rawSense.confidence == null || !CONFIDENCE_VALUES.includes(rawSense.confidence)
      const noteParts: string[] = []
      if (rawSense.note?.trim()) noteParts.push(rawSense.note.trim())
      if (missingConfidence) noteParts.push('（confidence 缺失，按 low 处理）')
      if (noteParts.length) next.note = noteParts.join(' ')
      if (rawSense.origin?.trim()) next.origin = rawSense.origin.trim()
      kept.push({ oldIndex: rawSense.index, sense: next })
      labelToNew.set(key, kept.length) // 临时：新 index = 位置
      oldToKeptOld.set(rawSense.index, kept.length)
    }
    const coreSenses: CoreSense[] = kept.map((entry, i) => ({ ...entry.sense, index: i + 1 }))
    for (const [oldIndex, newIndex] of oldToKeptOld) oldToNew.set(oldIndex, newIndex)

    // 2) meaningMap：覆盖全部含义、去重、索引有效
    const seenMeaning = new Set<number>()
    const meaningMap: MeaningMapEntry[] = []
    for (const rawEntry of raw.meaningMap) {
      const meaningIndex = rawEntry.meaningIndex
      if (meaningIndex < 1 || meaningIndex > meaningCount || seenMeaning.has(meaningIndex)) continue
      const mapped = oldToNew.get(rawEntry.coreSenseIndex)
      if (mapped == null) continue // coreSenseIndex 不存在 → 丢弃该条（映射会算缺失）
      seenMeaning.add(meaningIndex)
      const entry: MeaningMapEntry = { meaningIndex, coreSenseIndex: mapped }
      if (rawEntry.note?.trim()) entry.note = rawEntry.note.trim()
      const steps = (rawEntry.steps ?? []).map((step) => step.trim()).filter(Boolean).slice(0, 6)
      if (steps.length > 0) entry.steps = steps
      meaningMap.push(entry)
    }
    const missing: number[] = []
    for (let i = 1; i <= meaningCount; i += 1) if (!seenMeaning.has(i)) missing.push(i)
    if (missing.length > 0) {
      return {
        byKey: new Map(),
        error: `headword=${target.headword}: meaningMap 缺少含义映射 ${missing.join(',')}（必须覆盖 1..${meaningCount}）`,
      }
    }
    meaningMap.sort((a, b) => a.meaningIndex - b.meaningIndex)

    byKey.set(targetKey(lower, target.meaningIndex), {
      headword: target.headword,
      headwordLower: lower,
      ...(target.meaningIndex != null ? { meaningIndex: target.meaningIndex } : {}),
      coreSenses,
      meaningMap,
    })
  }
  return { byKey }
}

// ============ semantics v3.4：per-c coreSenseLabel → 程序聚合（task-76 修订） ============

/** v3.4 模型原始输出：每个含义一条 coreSenseLabel */
export const semanticsMeaningEntrySchema = z.object({
  meaningIndex: z.number().int().min(1).max(99),
  /** 2–6 字中文规范化本义标签（模型可能带空白/全角；程序归一后聚合） */
  coreSenseLabel: z.string().max(40).optional(),
  /** ≤40 字本义解释（label 缺失时回退为 label） */
  coreSenseNote: z.string().max(200).optional(),
  /** ≤20 字词源/词根本义 */
  origin: z.string().max(80).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional().catch(undefined),
  /** 可选 2–4 步本义链 */
  steps: z.array(z.string().max(120)).max(8).optional(),
})

export const semanticsMeaningItemSchema = z.object({
  headword: z.string().min(1).max(120),
  headwordLower: z.string().min(1).max(120).optional(),
  meanings: z.array(semanticsMeaningEntrySchema).min(1).max(50),
})

export const semanticsMeaningsResponseSchema = z.object({
  items: z.array(semanticsMeaningItemSchema).max(200),
})

export type SemanticsMeaningEntry = z.infer<typeof semanticsMeaningEntrySchema>
export type SemanticsMeaningItem = z.infer<typeof semanticsMeaningItemSchema>

/** label 归一：NFKC（全角→半角）、去首尾/内部空白、小写（用于判断是否同一本义） */
export function normalizeCoreSenseLabel(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .trim()
    .toLowerCase()
}

const CONFIDENCE_RANK: Record<'high' | 'medium' | 'low', number> = { high: 3, medium: 2, low: 1 }
function weakestConfidence(list: Array<'high' | 'medium' | 'low'>): 'high' | 'medium' | 'low' {
  if (list.length === 0) return 'low'
  return list.reduce((acc, cur) => (CONFIDENCE_RANK[cur] < CONFIDENCE_RANK[acc] ? cur : acc), 'high')
}

export interface SemanticsAggregateResult {
  byKey: Map<string, PackItemV1>
  error?: string
}

/**
 * v3.4 聚合：按 `coreSenseLabel`（归一后）去重出 coreSenses，并把每个 c 映射到 coreSenseIndex。
 * - 同一 label（忽略大小写/空白/全半角差异）→ 同一本义；不同 label → 不同本义；
 * - label 缺失 → 回退 coreSenseNote；两者都缺失 → label='未标注'、confidence=low；
 * - confidence 取该本义下**最弱**（保守）；steps 带入 meaningMap[].steps。
 * 输出仍是现有 momo-pack 结构（coreSenses + meaningMap），CLI/合并/UI 无需改。
 */
export function aggregateSemanticsLabels(input: {
  json: unknown
  targets: readonly SemanticsValidateTarget[]
}): SemanticsAggregateResult {
  const parsed = semanticsMeaningsResponseSchema.safeParse(input.json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      byKey: new Map(),
      error: `schema 校验失败：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim(),
    }
  }
  const targetsByLower = new Map<string, SemanticsValidateTarget>()
  for (const t of input.targets) {
    const lower = t.headwordLower ?? normalizeHeadword(t.headword)
    targetsByLower.set(lower, t)
  }
  const byKey = new Map<string, PackItemV1>()

  for (const rawItem of parsed.data.items) {
    const lower = normalizeHeadword(rawItem.headwordLower ?? rawItem.headword)
    const target = targetsByLower.get(lower)
    if (!target) continue
    const meaningCount = Math.max(1, target.meanings.length)

    // 1) 覆盖检查：每个 meaningIndex 必须恰好一次（重复保留第一条）
    const seen = new Set<number>()
    const entries: Array<{ meaningIndex: number; entry: (typeof rawItem.meanings)[number] }> = []
    for (const entry of rawItem.meanings) {
      const idx = entry.meaningIndex
      if (idx < 1 || idx > meaningCount || seen.has(idx)) continue
      seen.add(idx)
      entries.push({ meaningIndex: idx, entry })
    }
    const missing: number[] = []
    for (let i = 1; i <= meaningCount; i += 1) if (!seen.has(i)) missing.push(i)
    if (missing.length > 0) {
      return {
        byKey: new Map(),
        error: `headword=${target.headword}: meanings 缺少含义 ${missing.join(',')}（必须覆盖 1..${meaningCount}）`,
      }
    }
    entries.sort((a, b) => a.meaningIndex - b.meaningIndex)

    // 2) 按归一 label 聚合本义（保持首次出现顺序）
    interface Group {
      displayLabel: string
      note?: string
      origin?: string
      confidences: Array<'high' | 'medium' | 'low'>
      index: number
    }
    const groups = new Map<string, Group>()
    const meaningMap: MeaningMapEntry[] = []
    for (const { meaningIndex, entry } of entries) {
      const rawLabel = (entry.coreSenseLabel ?? '').trim()
      const rawNote = (entry.coreSenseNote ?? '').trim()
      const displayLabel = (rawLabel || rawNote || '未标注').normalize('NFKC').trim()
      const key = normalizeCoreSenseLabel(displayLabel) || '未标注'
      // label 与 note 都缺失的条目标记为 low（未标注本义，不可信）
      const confidence = (!rawLabel && !rawNote
        ? 'low'
        : normalizeConfidence(entry.confidence)) as 'high' | 'medium' | 'low'
      let group = groups.get(key)
      if (!group) {
        group = {
          displayLabel,
          ...(rawNote ? { note: rawNote } : {}),
          ...(entry.origin?.trim() ? { origin: entry.origin.trim() } : {}),
          confidences: [],
          index: groups.size + 1,
        }
        groups.set(key, group)
      }
      group.confidences.push(confidence)
      const steps = (entry.steps ?? []).map((step) => step.trim()).filter(Boolean).slice(0, 6)
      const mapping: MeaningMapEntry = { meaningIndex, coreSenseIndex: group.index }
      // per-c 说明：与 coreSense.note 不同时保留，避免 UI 重复展示
      if (rawNote && rawNote !== group.note) mapping.note = rawNote
      if (steps.length > 0) mapping.steps = steps
      meaningMap.push(mapping)
    }

    const coreSenses: CoreSense[] = [...groups.values()].map((group) => ({
      index: group.index,
      label: group.displayLabel,
      ...(group.note ? { note: group.note } : {}),
      ...(group.origin ? { origin: group.origin } : {}),
      confidence: weakestConfidence(group.confidences),
    }))

    byKey.set(targetKey(lower, target.meaningIndex), {
      headword: target.headword,
      headwordLower: lower,
      ...(target.meaningIndex != null ? { meaningIndex: target.meaningIndex } : {}),
      coreSenses,
      meaningMap,
    })
  }
  return { byKey }
}

/** 单含义词：不调模型，返回自身映射（task-76） */
export function selfMeaningSemanticsItem(target: SemanticsValidateTarget): PackItemV1 {
  const first = target.meanings[0]?.cn?.trim() ?? target.headword
  const label = first.length > 8 ? first.slice(0, 8) : first
  return {
    headword: target.headword,
    headwordLower: target.headwordLower ?? normalizeHeadword(target.headword),
    ...(target.meaningIndex != null ? { meaningIndex: target.meaningIndex } : {}),
    coreSenses: [{ index: 1, label, note: '单义项，无需推演', confidence: 'low' }],
    meaningMap: target.meanings.map((_, i) => ({
      meaningIndex: i + 1,
      coreSenseIndex: 1,
      note: '唯一义项',
    })),
  }
}


// ============ v4：grouped semantics 校验器（task-96 规格，task-97 实现） ============

/** v4 label 硬性格式：2–6 个纯汉字 */
export const V4_LABEL_RE = /^[\u4e00-\u9fff]{2,6}$/
/** v4 label 黑名单（出现即不合格） */
export const V4_LABEL_BLACKLIST: readonly string[] = [
  '是否', '看', '检查', '判断', '确认', '核对', '推导',
  '源自', '源古', '来自', '出自', '词源', '词根',
  '希腊', '拉丁', '英语', '法语', '德语', '古英语',
  '→', '->', '第一步', '第二步',
  '可能', '大概', '也许', '疑似',
]
/** v4 steps 黑名单 */
export const V4_STEP_BLACKLIST: readonly string[] = [
  '是否', '看', '检查', '判断', '确认', '核对', '来源',
  '源自', '来自', '出自', '词源', '词根', '希腊', '拉丁', '英语', '法语', '德语', '→', '->', '推导',
]
const V4_DOUBLE_DE = /的[^的]{0,6}的/
const V4_PUNCT = /[，。；：、！？"'“”‘’（）()\[\]【】<>《》\d]/
const V4_ORIGIN_OK = /(=|＝|即|意为|意思是|指)/
const V4_ORIGIN_BAD_PREFIX = /^(源自|来自|出自)/
const V4_CONFIDENCE: readonly string[] = ['high', 'medium', 'low']

/** v4 模型原始条目（宽容 schema：先接住，再由校验器修/判） */
export const semanticsV4ItemSchema = z.object({
  headword: z.string().min(1).max(120),
  headwordLower: z.string().max(120).optional(),
  coreSenses: z
    .array(
      z.object({
        index: z.number().int().min(1).max(99),
        label: z.string().max(120).default(''),
        gloss: z.string().max(200).optional(),
        note: z.string().max(200).optional(),
        origin: z.string().max(120).optional(),
        confidence: z.string().max(20).optional(),
      }),
    )
    .min(1)
    .max(8),
  meaningMap: z.array(
    z.object({
      meaningIndex: z.number().int().min(1).max(200),
      coreSenseIndex: z.number().int().min(1).max(99),
      steps: z.array(z.string().max(200)).max(12).optional(),
    }),
  ),
})
export const semanticsV4ResponseSchema = z.object({ items: z.array(semanticsV4ItemSchema).max(500) })

export interface SemanticsV4ItemResult {
  headword: string
  ok: boolean
  errors: string[]
  warnings: string[]
  item?: PackItemV1
}

export interface SemanticsV4ValidationResult {
  byKey: Map<string, PackItemV1>
  items: SemanticsV4ItemResult[]
  errors: string[]
  warnings: string[]
}

/** label 归一（§2.4）：NFKC 全角→半角、去空白、去结尾「的」；不做小写（中文 label） */
export function normalizeV4Label(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .trim()
    .replace(/的$/, '')
}

function editDistanceAtMost1(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false
  if (a === b) return true
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1) // 替换
  if (a.length > b.length) return a.slice(i + 1) === b.slice(i) // 删除
  return a.slice(i) === b.slice(i + 1) // 插入
}

function weakestConfidenceOf(list: string[]): 'high' | 'medium' | 'low' {
  const valid = list.filter((item): item is 'high' | 'medium' | 'low' => V4_CONFIDENCE.includes(item))
  if (valid.length !== list.length) valid.push('low')
  if (valid.length === 0) return 'low'
  return valid.reduce((acc, cur) => (CONFIDENCE_RANK[cur] < CONFIDENCE_RANK[acc] ? cur : acc), 'high')
}

/** 校验/修复单个 v4 条目 */
function validateV4ItemAgainstTarget(
  raw: z.infer<typeof semanticsV4ItemSchema>,
  target: SemanticsValidateTarget,
): SemanticsV4ItemResult {
  const errors: string[] = []
  const warnings: string[] = []
  const M = Math.max(1, target.meanings.length)

  // 1) trim + 按 index 排序/重排（不连续/重复 → 按数组顺序修复）
  const senses = raw.coreSenses.map((sense) => ({
    index: sense.index,
    label: (sense.label ?? '').trim(),
    gloss: (sense.gloss ?? sense.note ?? '').trim(),
    origin: (sense.origin ?? '').trim(),
    confidenceRaw: (sense.confidence ?? '').trim(),
  }))
  const indexSorted = senses.slice().sort((a, b) => a.index - b.index)
  const originalIndices = indexSorted.map((sense) => sense.index)
  const uniqueIndices = new Set(originalIndices)
  if (uniqueIndices.size !== originalIndices.length) {
    warnings.push('E_SENSE_INDEX_FIXED:duplicate-index')
  }
  const reordered = indexSorted.map((sense, i) => ({ ...sense, oldIndex: sense.index, index: i + 1 }))
  if (reordered.length > 4) errors.push('E_SENSE_COUNT:>4')
  if (reordered.length === 0) errors.push('E_SENSE_COUNT:0')

  // 2) label/gloss/origin/confidence 逐项校验
  for (const sense of reordered) {
    const label = sense.label
    if (!V4_LABEL_RE.test(label)) errors.push(`E_LABEL_FORMAT:${label || '(空)'}`)
    else if (V4_PUNCT.test(label)) errors.push(`E_LABEL_PUNCT:${label}`)
    else if (V4_LABEL_BLACKLIST.some((word) => label.includes(word))) errors.push(`E_LABEL_BANNED:${label}`)
    else if (V4_DOUBLE_DE.test(label)) errors.push(`E_LABEL_DE:${label}`)
    if (!sense.gloss) warnings.push(`E_GLOSS_MISSING:${label || '(空)'}`)
    else if (sense.gloss.length > 40) errors.push(`E_GLOSS_LEN:${label}`)
    if (sense.origin) {
      if (sense.origin.length > 20) errors.push(`E_ORIGIN_LEN:${label}`)
      else if (V4_ORIGIN_BAD_PREFIX.test(sense.origin) || !V4_ORIGIN_OK.test(sense.origin)) {
        errors.push(`E_ORIGIN_NO_EXPLAIN:${label}`)
      }
    }
    if (sense.confidenceRaw && !V4_CONFIDENCE.includes(sense.confidenceRaw)) {
      warnings.push(`E_CONFIDENCE_FIXED:${label}`)
    }
  }

  // 3) label 近义合并（§2.4 规则 1–3；规则 4 编辑距离 ≤1 仅 warning）
  const parent = reordered.map((_, i) => i)
  const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x]!)))
  const union = (a: number, b: number) => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb)
  }
  const normalized = reordered.map((sense) => normalizeV4Label(sense.label))
  for (let i = 0; i < reordered.length; i += 1) {
    for (let j = i + 1; j < reordered.length; j += 1) {
      const a = normalized[i]!
      const b = normalized[j]!
      if (!a || !b) continue
      if (a === b) {
        union(i, j)
        warnings.push(`E_LABEL_DUP_MERGED:${reordered[i]!.label}/${reordered[j]!.label}`)
      } else if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) {
        union(i, j)
        warnings.push(`E_LABEL_SIMILAR_MERGED:${reordered[i]!.label}/${reordered[j]!.label}`)
      } else if (editDistanceAtMost1(a, b)) {
        warnings.push(`E_LABEL_SIMILAR:${reordered[i]!.label}/${reordered[j]!.label}`)
      }
    }
  }
  // 分组（按最小原始 index 顺序）；label 取最短成员（包含关系合并为较短者）
  const groupMap = new Map<number, typeof reordered>()
  for (const sense of reordered) {
    const root = find(reordered.indexOf(sense))
    const list = groupMap.get(root) ?? []
    list.push(sense)
    groupMap.set(root, list)
  }
  const groups = [...groupMap.values()]
    .map((members) => {
      const sortedByLen = members.slice().sort((a, b) => a.label.length - b.label.length || a.index - b.index)
      const chosen = sortedByLen[0]!
      const gloss = chosen.gloss || members.find((sense) => sense.gloss)?.gloss || ''
      const origin = chosen.origin || members.find((sense) => sense.origin)?.origin || ''
      return {
        label: chosen.label,
        gloss,
        origin,
        confidence: weakestConfidenceOf(members.map((sense) => sense.confidenceRaw)),
        minIndex: Math.min(...members.map((sense) => sense.index)),
        oldIndices: members.map((sense) => sense.oldIndex),
      }
    })
    .sort((a, b) => a.minIndex - b.minIndex)
  const oldIndexToGroup = new Map<number, number>()
  groups.forEach((group, index) => {
    for (const oldIndex of group.oldIndices) oldIndexToGroup.set(oldIndex, index + 1)
  })

  // 4) meaningMap 校验（范围/重复/coreSenseIndex 有效；无效引用丢弃后触发缺失）
  const seenMeanings = new Set<number>()
  const mapped: Array<{ meaningIndex: number; coreSenseIndex: number; steps?: string[] }> = []
  for (const entry of raw.meaningMap) {
    if (entry.meaningIndex < 1 || entry.meaningIndex > M) {
      errors.push(`E_MAP_RANGE:${entry.meaningIndex}`)
      continue
    }
    if (seenMeanings.has(entry.meaningIndex)) {
      errors.push(`E_MAP_DUP:${entry.meaningIndex}`)
      continue
    }
    const groupIndex = oldIndexToGroup.get(entry.coreSenseIndex)
    if (!groupIndex) {
      errors.push(`E_MAP_INDEX:${entry.meaningIndex}`)
      continue
    }
    seenMeanings.add(entry.meaningIndex)
    const validSteps: string[] = []
    if (entry.steps && entry.steps.length > 0) {
      const trimmed = entry.steps.map((step) => step.trim()).filter(Boolean)
      const stepsOk =
        trimmed.length >= 2 &&
        trimmed.length <= 4 &&
        trimmed.every((step) => step.length >= 2 && step.length <= 20 && !V4_STEP_BLACKLIST.some((word) => step.includes(word)))
      if (stepsOk) validSteps.push(...trimmed)
      else warnings.push(`E_STEPS_DROPPED:${entry.meaningIndex}`)
    }
    mapped.push({
      meaningIndex: entry.meaningIndex,
      coreSenseIndex: groupIndex,
      ...(validSteps.length > 0 ? { steps: validSteps } : {}),
    })
  }
  for (let i = 1; i <= M; i += 1) {
    if (!seenMeanings.has(i)) errors.push(`E_MAP_MISSING:${i}`)
  }

  // 5) 孤儿本义：删除未被引用的 coreSenses，重排 + 重映射
  const usedGroups = new Set(mapped.map((entry) => entry.coreSenseIndex))
  const keptGroups = groups.filter((_, index) => usedGroups.has(index + 1))
  if (keptGroups.length !== groups.length) {
    warnings.push('E_SENSE_UNUSED_FIXED')
    const groupNewIndex = new Map<number, number>()
    groups.forEach((_, index) => {
      const old = index + 1
      if (usedGroups.has(old)) groupNewIndex.set(old, keptGroups.findIndex((group) => group === groups[index]) + 1)
    })
    for (const entry of mapped) {
      entry.coreSenseIndex = groupNewIndex.get(entry.coreSenseIndex) ?? entry.coreSenseIndex
    }
  }
  if (keptGroups.length === 0) errors.push('E_SENSE_COUNT:0')

  const headword = raw.headword.trim()
  const lower = normalizeHeadword(raw.headwordLower ?? raw.headword)
  if (errors.length > 0) return { headword, ok: false, errors, warnings }

  const coreSenses: CoreSense[] = keptGroups.map((group, index) => ({
    index: index + 1,
    label: group.label,
    ...(group.gloss ? { note: group.gloss } : {}),
    ...(group.origin ? { origin: group.origin } : {}),
    confidence: group.confidence,
  }))
  const meaningMap: MeaningMapEntry[] = mapped
    .sort((a, b) => a.meaningIndex - b.meaningIndex)
    .map((entry) => ({
      meaningIndex: entry.meaningIndex,
      coreSenseIndex: entry.coreSenseIndex,
      ...(entry.steps ? { steps: entry.steps } : {}),
    }))
  const item: PackItemV1 = {
    headword: target.headword,
    headwordLower: lower,
    ...(target.meaningIndex != null ? { meaningIndex: target.meaningIndex } : {}),
    coreSenses,
    meaningMap,
  }
  return { headword, ok: true, errors, warnings, item }
}

/**
 * v4 grouped semantics 校验 + 自动修复（纯函数；App/CLI 共用）。
 *
 * 输入：模型 JSON（`{items:[{headword,coreSenses,meaningMap}]}`）+ 目标词含义列表；
 * 输出：通过校验的 `PackItemV1`（gloss→coreSense.note）+ 每个词的 errors/warnings。
 * 自动修复顺序见 docs/SEMANTICS-FORMAT.md §5.4；结构不变量/质量硬错误不通过 → 触发 repair 重试。
 */
export function validateSemanticsV4Items(input: {
  json: unknown
  targets: readonly SemanticsValidateTarget[]
}): SemanticsV4ValidationResult {
  const byKey = new Map<string, PackItemV1>()
  const items: SemanticsV4ItemResult[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const parsed = semanticsV4ResponseSchema.safeParse(input.json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const message = `schema 校验失败：${issue?.path.join('.') ?? ''} ${issue?.message ?? ''}`.trim()
    return { byKey, items, errors: [message], warnings }
  }
  const targetsByLower = new Map<string, SemanticsValidateTarget>()
  for (const target of input.targets) {
    targetsByLower.set(target.headwordLower ?? normalizeHeadword(target.headword), target)
  }
  for (const raw of parsed.data.items) {
    const lower = normalizeHeadword(raw.headwordLower ?? raw.headword)
    const target = targetsByLower.get(lower)
    if (!target) {
      warnings.push(`E_UNKNOWN_HEADWORD:${raw.headword}`)
      continue
    }
    const result = validateV4ItemAgainstTarget(raw, target)
    items.push(result)
    errors.push(...result.errors.map((error) => `${lower}:${error}`))
    warnings.push(...result.warnings.map((warning) => `${lower}:${warning}`))
    if (result.ok && result.item) byKey.set(targetKey(lower, target.meaningIndex), result.item)
  }
  return { byKey, items, errors, warnings }
}
