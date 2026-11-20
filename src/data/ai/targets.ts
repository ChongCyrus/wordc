/**
 * AI 生成范围与排除（task-70）—— 复用 dev-data 的查询接口。
 *
 * 范围：word（当前词）/ meaning（当前词+含义）/ today（今日计划）/ deck（整库分页）。
 * 排除：已有内容（`onlyMissing` 默认 true，v1 只补缺不覆盖）+ 用户已拒绝的 target（`ai.rejected` meta）。
 */

import { normalizeHeadword } from '../../core'
import type { Word } from '../../core'
import type { ContentKind, GenerateTarget, SingleContentKind } from './types'
import { getWord, getWords, getWordsPage } from '../decks.repo'
import { getDb } from '../db'
import { getTodayPlan } from '../plans.repo'
import { CONTENT_LIMITS } from './prompts'
import { targetKey } from './types'

/** 生成范围（与 SPEC-CONTENT-PACKS §2.1.1 scope 对齐） */
export type GenerateScope =
  | { kind: 'word'; wordId: string }
  | { kind: 'meaning'; wordId: string; meaningIndex: number }
  | { kind: 'today'; deckId?: string | null }
  | { kind: 'deck'; deckId: string; limit?: number }

export interface BuildTargetsOptions {
  /** 只生成某一类时用于 onlyMissing 判断（v1 只补缺） */
  kind?: SingleContentKind | ContentKind
  /** 默认 true：已有内容达到上限的目标跳过（v1 只补缺、不覆盖） */
  onlyMissing?: boolean
  /** 每类内容上限（默认 CONTENT_LIMITS，可被设置覆盖） */
  limits?: Partial<Record<SingleContentKind, number>>
  /** 额外排除的 target key（如已拒绝）；缺省读取 meta: ai.rejected */
  rejectedKeys?: Iterable<string>
  /** 最多返回多少目标（deck/全量分片用） */
  maxTargets?: number
}

/** 内存/测试用：可选择的词（Word 的最小子集 + 已有内容计数） */
export interface TargetSourceWord {
  wordId: string
  headword: string
  headwordLower?: string
  meanings: Array<{ id: string; pos?: string; cn: string }>
  examples?: unknown[]
  phrases?: unknown[]
  mnemonics?: unknown[]
}

function existingCounts(word: TargetSourceWord): GenerateTarget['existing'] {
  return {
    examples: word.examples?.length ?? 0,
    phrases: word.phrases?.length ?? 0,
    mnemonics: word.mnemonics?.length ?? 0,
  }
}

function countKeyOf(kind: SingleContentKind): keyof GenerateTarget['existing'] {
  return kind === 'examples' ? 'examples' : kind === 'phrases' ? 'phrases' : 'mnemonics'
}

/**
 * 纯函数：把候选词过滤成生成目标（无 DB 依赖，单测直接覆盖）。
 * - headwordLower 统一 `normalizeHeadword`；
 * - 排除 rejectedKeys；
 * - onlyMissing：该 kind 已有内容 ≥ limit 时跳过；
 * - meaningIndex 指定时只生成该含义（丢出其它含义的 target）。
 */
export function selectGenerateTargets(
  words: readonly TargetSourceWord[],
  opts: BuildTargetsOptions & { meaningIndex?: number } = {},
): GenerateTarget[] {
  const limitMap: Record<SingleContentKind, number> = {
    examples: opts.limits?.examples ?? CONTENT_LIMITS.examples,
    phrases: opts.limits?.phrases ?? CONTENT_LIMITS.phrases,
    mnemonics: opts.limits?.mnemonics ?? CONTENT_LIMITS.mnemonics,
  }
  const rejected = new Set<string>(opts.rejectedKeys ?? [])
  const kind = opts.kind && opts.kind !== 'mixed' ? opts.kind : undefined
  const onlyMissing = opts.onlyMissing ?? true
  const out: GenerateTarget[] = []
  const max = opts.maxTargets == null ? Infinity : Math.max(0, opts.maxTargets)

  for (const word of words) {
    if (out.length >= max) break
    const headwordLower = word.headwordLower ?? normalizeHeadword(word.headword)
    const existing = existingCounts(word)
    if (kind && onlyMissing && existing[countKeyOf(kind)] >= limitMap[kind]) continue
    const meaningIndex = opts.meaningIndex
    if (meaningIndex != null && (meaningIndex < 1 || meaningIndex > Math.max(1, word.meanings.length))) continue
    const key = targetKey(headwordLower, meaningIndex)
    if (rejected.has(key)) continue
    const target: GenerateTarget = {
      wordId: word.wordId,
      headword: word.headword,
      headwordLower,
      meanings: word.meanings.map((m) => ({ id: m.id, pos: m.pos, cn: m.cn })),
      existing,
    }
    if (meaningIndex != null) target.meaningIndex = meaningIndex
    out.push(target)
  }
  return out
}

// ============ 已拒绝 target（meta: ai.rejected） ============

const REJECTED_META_KEY = 'ai.rejected'
const REJECTED_MAX = 5_000

interface RejectedRecord {
  keys: string[]
  updatedAt: number
}

/** 当前已拒绝的 target key 列表（无记录返回 []） */
export async function getRejectedTargetKeys(): Promise<string[]> {
  try {
    const row = await getDb().meta.get(REJECTED_META_KEY)
    const value = row?.value as RejectedRecord | undefined
    return Array.isArray(value?.keys) ? [...value.keys] : []
  } catch {
    return []
  }
}

/** 记录被用户拒绝的 target（幂等；上限 5000，超出丢最旧） */
export async function addRejectedTargetKeys(keys: readonly string[], now: number = Date.now()): Promise<void> {
  const clean = keys.map((k) => String(k).trim()).filter(Boolean)
  if (clean.length === 0) return
  const db = getDb()
  await db.transaction('rw', db.meta, async () => {
    const row = await db.meta.get(REJECTED_META_KEY)
    const prev = (row?.value as RejectedRecord | undefined)?.keys ?? []
    const merged = [...prev]
    for (const key of clean) if (!merged.includes(key)) merged.push(key)
    const keysNext = merged.slice(Math.max(0, merged.length - REJECTED_MAX))
    await db.meta.put({ key: REJECTED_META_KEY, value: { keys: keysNext, updatedAt: now }, updatedAt: now })
  })
}

/** 清空拒绝记录（设置页「重置排除」用） */
export async function clearRejectedTargetKeys(now: number = Date.now()): Promise<void> {
  await getDb().meta.delete(REJECTED_META_KEY)
  void now
}

// ============ DB 查询（复用 dev-data 接口） ============

function toSourceWord(word: Word): TargetSourceWord {
  return {
    wordId: word.id,
    headword: word.headword,
    headwordLower: word.headwordLower,
    meanings: word.meanings,
    examples: word.examples,
    phrases: word.phrases,
    mnemonics: word.mnemonics,
  }
}

/**
 * 按范围构建生成目标（DB 查询；调用前请确认 db 已初始化）。
 * `opts.rejectedKeys` 不传时自动读取 `meta: ai.rejected`。
 */
export async function buildGenerateTargets(
  scope: GenerateScope,
  opts: BuildTargetsOptions = {},
): Promise<GenerateTarget[]> {
  const rejected = opts.rejectedKeys ?? (await getRejectedTargetKeys())
  const options: BuildTargetsOptions = { ...opts, rejectedKeys: rejected }

  if (scope.kind === 'word' || scope.kind === 'meaning') {
    const word = await getWord(scope.wordId)
    if (!word) return []
    const meaningIndex = scope.kind === 'meaning' ? scope.meaningIndex : undefined
    return selectGenerateTargets([toSourceWord(word)], { ...options, meaningIndex })
  }

  if (scope.kind === 'today') {
    const plan = await getTodayPlan({ deckId: scope.deckId ?? null })
    const uniqueIds = [...new Set(plan.wordIds)]
    const words = await getWords(uniqueIds)
    return selectGenerateTargets(words.map(toSourceWord), options)
  }

  // deck：分页读取（每页 500），直到取满 maxTargets 或读完
  const pageSize = 500
  const maxTargets = opts.maxTargets == null ? Infinity : Math.max(0, opts.maxTargets)
  const collected: TargetSourceWord[] = []
  let offset = 0
  for (;;) {
    const page = await getWordsPage(scope.deckId, { offset, limit: pageSize })
    if (page.words.length === 0) break
    collected.push(...page.words.map(toSourceWord))
    offset += page.words.length
    if (offset >= page.total) break
    if (collected.length >= maxTargets) break
  }
  return selectGenerateTargets(collected, { ...options, maxTargets })
}
