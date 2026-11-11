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

