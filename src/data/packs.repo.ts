/**
 * 内容包数据层（SPEC-CONTENT-PACKS / ARCH-CONTENT-PACKS §3，task-69 M1：纯 pack，无 AI）。
 *
 * 职责：
 * - `momo-pack` v1 解析/校验（zod + checksum）；
 * - 导入预览 → 建 pack（pending）→ ✓/❌ 审核 → 事务应用（只补缺/去重/上限/拒绝记忆）→ 可导出；
 * - 范围选择 + 排除条件（today/deck/word/meaning/manual）供 UI 与 AI 生成复用；
 * - builtin 重种后 `reapplyAppliedPacks()` 重放已应用内容；
 * - Dexie v3 三张表：packs / packItems / contentRejects。
 *
 * 不写 `words` 以外的产品表；应用始终合并进 `Word.examples/phrases/mnemonics`（唯一落库点）。
 */

import type { Word } from '../core'
import { localDateKey, meaningIdOf, normalizeHeadword } from '../core'
import { BRAND } from '../app/brand'
import { computeChecksum, verifyChecksum } from './checksum'
import { getDb } from './db'
import { getSettings } from './settings.repo'
import { mergeItemIntoWord } from './packs/merge'
import type { MergeSkip } from './packs/merge'
import {
  LIMITS,
  PACK_FORMAT,
  PACK_FORMAT_VERSION,
  contentHash,
  itemMatchesKind,
  mnemonicKey,
  normalizeEn,
  normalizePackItem,
  packChecksumPayload,
  packIssue,
} from './packs/schema'
import type {
  ContentKind,
  ContentRejectRecord,
  CoreSenseV1,
  MeaningMapV1,
  FilterSet,
  PackCounts,
  PackFileV1,
  PackItemRecord,
  PackItemV1,
  PackKind,
  PackPreview,
  PackRecord,
  PackSource,
  ResolvedItem,
  SkipRecord,
  Target,
  TargetPage,
  TargetPageOptions,
  TargetScope,
} from './packs/schema'
import { TARGET_PAGE_MAX } from './packs/schema'
import type { ImportIssue } from '../core'
import type { ParseResult } from './schema'

const PACK_GENERATOR = 'wordc@0.3.3'

// ============ 小工具 ============

function newPackId(now = Date.now()): string {
  return `pk_${now}_${Math.random().toString(36).slice(2, 8)}`
}

async function readInput(input: string | Blob): Promise<string> {
  return typeof input === 'string' ? input : await input.text()
}

function emptyCounts(): PackCounts {
  return { items: 0, pending: 0, approved: 0, applied: 0, rejected: 0, skipped: 0 }
}

/** 条目内每条内容的 hash（examples/phrases/mnemonics 全部） */
function itemContentHashes(item: PackItemV1): string[] {
  const lower = normalizeHeadword(item.headwordLower || item.headword)
  const hashes: string[] = []
  for (const example of item.examples ?? []) {
    hashes.push(contentHash('examples', lower, item.meaningIndex, example.en))
  }
  for (const phrase of item.phrases ?? []) {
    hashes.push(contentHash('phrases', lower, phrase.meaningIndex ?? item.meaningIndex, phrase.en))
  }
  for (const mnemonic of item.mnemonics ?? []) {
    hashes.push(contentHash('mnemonics', lower, undefined, mnemonicKey(mnemonic)))
  }
  for (const sense of item.coreSenses ?? []) {
    hashes.push(contentHash('semantics', lower, undefined, `sense:${sense.label.toLowerCase()}`))
  }
  for (const mapping of item.meaningMap ?? []) {
    hashes.push(
      contentHash(
        'semantics',
        lower,
        mapping.meaningIndex,
        `map:${mapping.meaningIndex}:${mapping.coreSenseIndex}:${(mapping.steps ?? []).join('>')}`,
      ),
    )
  }
  return hashes
}

/** 条目内每条内容（kind + hash + 值），用于写拒绝记忆 */
function itemContents(item: PackItemV1): Array<{ kind: ContentKind; hash: string; value: string }> {
  const lower = normalizeHeadword(item.headwordLower || item.headword)
  const out: Array<{ kind: ContentKind; hash: string; value: string }> = []
  for (const example of item.examples ?? []) {
    out.push({ kind: 'examples', hash: contentHash('examples', lower, item.meaningIndex, example.en), value: example.en })
  }
  for (const phrase of item.phrases ?? []) {
    out.push({
      kind: 'phrases',
      hash: contentHash('phrases', lower, phrase.meaningIndex ?? item.meaningIndex, phrase.en),
      value: phrase.en,
    })
  }
  for (const mnemonic of item.mnemonics ?? []) {
    out.push({ kind: 'mnemonics', hash: contentHash('mnemonics', lower, undefined, mnemonicKey(mnemonic)), value: mnemonicKey(mnemonic) })
  }
  for (const sense of item.coreSenses ?? []) {
    out.push({
      kind: 'semantics',
      hash: contentHash('semantics', lower, undefined, `sense:${sense.label.toLowerCase()}`),
      value: `sense:${sense.label}`,
    })
  }
  for (const mapping of item.meaningMap ?? []) {
    out.push({
      kind: 'semantics',
      hash: contentHash('semantics', lower, mapping.meaningIndex, `map:${mapping.meaningIndex}:${mapping.coreSenseIndex}`),
      value: `map:${mapping.meaningIndex}->${mapping.coreSenseIndex}`,
    })
  }
  return out
}

async function rejectedHashesFor(headwordLower: string): Promise<Set<string>> {
  const db = getDb()
  const rows = await db.contentRejects.where('headwordLower').equals(headwordLower).toArray()
  return new Set(rows.map((row) => row.hash))
}

// ============ 解析 / 校验 ============

/** 解析 + 校验 momo-pack v1（zod + checksum + 条目规范化）。失败不写库。 */
export async function parsePackFile(input: string | Blob): Promise<ParseResult<PackFileV1>> {
  let raw: unknown
  try {
    raw = JSON.parse(await readInput(input))
  } catch {
    return { ok: false, issues: [packIssue('error', 'E_FORMAT', '不是有效的 JSON 文件')] }
  }
  if (!raw || typeof raw !== 'object' || (raw as { format?: unknown }).format !== PACK_FORMAT) {
    return {
      ok: false,
      issues: [packIssue('error', 'E_FORMAT', `不是内容包文件（format 应为 ${PACK_FORMAT}）`, { path: 'format' })],
    }
  }
  if ((raw as { formatVersion?: unknown }).formatVersion !== PACK_FORMAT_VERSION) {
    return {
      ok: false,
      issues: [
        packIssue('error', 'E_VERSION', `内容包版本不支持：${String((raw as { formatVersion?: unknown }).formatVersion)}`, {
          path: 'formatVersion',
        }),
      ],
    }
  }
  const { packFileSchema } = await import('./packs/schema')
  const parsed = packFileSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) =>
        packIssue('error', 'E_FIELD', issue.message, { path: issue.path.join('.') }),
      ),
    }
  }
  const file = parsed.data as PackFileV1
  // checksum 基于**文件原文条目**（不依赖 normalize 后新增的 headwordLower 等派生字段）
  const verified = await verifyChecksum(packChecksumPayload(file), file.checksum)
  if (!verified.ok) {
    return {
      ok: false,
      issues: [packIssue('error', 'E_CHECKSUM', '内容包校验和不匹配（文件可能被修改，已拒绝导入）', { path: 'checksum' })],
    }
  }
  const items: PackItemV1[] = []
  const issues: ImportIssue[] = []
  file.items.forEach((item, index) => {
    const normalized = normalizePackItem(item)
    if (!normalized) {
      issues.push(packIssue('warning', 'W_SKIPPED', '条目没有任何可用内容，已跳过', { path: `items[${index}]` }))
      return
    }
    if (!itemMatchesKind(normalized, file.kind)) {
      issues.push(
        packIssue('warning', 'W_SKIPPED', `条目内容与 pack kind=${file.kind} 不匹配，已跳过`, { path: `items[${index}]` }),
      )
      return
    }
    items.push(normalized)
  })
  if (items.length === 0) {
    return { ok: false, issues: [...issues, packIssue('error', 'E_FORMAT', '内容包没有可用条目')] }
  }
  return { ok: true, value: { ...file, items }, issues }
}

// ============ 目标解析（headwordLower + meaningIndex → word/meaning） ============

interface ResolveOptions {
  /** UI 指定的当前词库（fallback） */
  deckId?: string
  /** task-90：pack.meta.deckId —— 有则**优先只在该 deck 解析**，找不到且 resolveAllDecks 才回退 */
  packDeckId?: string
  resolveAllDecks?: boolean
  /** 导入进度（解析/写入分批）；供 UI 进度条 */
  onProgress?: (progress: { phase: 'resolve' | 'write'; done: number; total: number }) => void
}

type WordIndex = Map<string, Word[]>

/** 批量预取：headwordLower 去重后 anyOf 分批（每批 500），避免逐 item 查询 */
const RESOLVE_BATCH = 500

async function loadWordIndex(
  lowers: string[],
  deckId?: string,
  fallbackAllDecks = false,
): Promise<WordIndex> {
  const db = getDb()
  const index: WordIndex = new Map()
  const unique = [...new Set(lowers)]
  const wanted = new Set(unique)
  if (deckId) {
    // 单 deck pack（内置 seed 的常态）：一次 deckId 索引查询，fake-indexeddb/浏览器都快
    const rows = await db.words.where('deckId').equals(deckId).toArray()
    for (const word of rows) {
      if (!wanted.has(word.headwordLower)) continue
      const list = index.get(word.headwordLower) ?? []
      list.push(word)
      index.set(word.headwordLower, list)
    }
    // pack.deckId 不存在/词不在该 deck 时，resolveAllDecks 才回退到任意 deck（CI/旧 pack 修复场景）
    if (!fallbackAllDecks) return index
    const missing = unique.filter((lower) => !index.has(lower))
    if (missing.length === 0) return index
    for (let offset = 0; offset < missing.length; offset += RESOLVE_BATCH) {
      const batch = missing.slice(offset, offset + RESOLVE_BATCH)
      const fallbackRows = await db.words.where('headwordLower').anyOf(batch).toArray()
      for (const word of fallbackRows) {
        const list = index.get(word.headwordLower) ?? []
        list.push(word)
        index.set(word.headwordLower, list)
      }
    }
    return index
  }
  for (let offset = 0; offset < unique.length; offset += RESOLVE_BATCH) {
    const batch = unique.slice(offset, offset + RESOLVE_BATCH)
    const rows = await db.words.where('headwordLower').anyOf(batch).toArray()
    for (const word of rows) {
      const list = index.get(word.headwordLower) ?? []
      list.push(word)
      index.set(word.headwordLower, list)
    }
  }
  return index
}

/** 批量预取拒绝记忆：headwordLower → hash 集合（同样 anyOf 分批） */
async function loadRejectIndex(): Promise<Map<string, Set<string>>> {
  const db = getDb()
  const index = new Map<string, Set<string>>()
  // 拒绝表通常很小：整表读一次，避免 anyOf 大数组在 fake-indexeddb 下慢
  const rows = await db.contentRejects.toArray()
  for (const row of rows) {
    const set = index.get(row.headwordLower) ?? new Set<string>()
    set.add(row.hash)
    index.set(row.headwordLower, set)
  }
  return index
}

/** 纯解析（使用预取索引，零 DB 查询） */
function resolveWithIndexes(
  item: PackItemV1,
  index: number,
  opts: ResolveOptions,
  wordIndex: WordIndex,
  selectedDeckId: string,
): { ok: true; resolved: ResolvedItem } | { ok: false; skip: SkipRecord } {
  const lower = normalizeHeadword(item.headwordLower || item.headword)
  const candidates = wordIndex.get(lower) ?? []
  const deckId = opts.deckId ?? selectedDeckId
  const meaningFits = (candidate: Word): boolean =>
    item.meaningIndex == null || Boolean(candidate.meanings[item.meaningIndex - 1])
  let word: Word | undefined
  if (opts.packDeckId) {
    // task-90：pack 明确声明目标词库 → 优先只在该 deck 找（同 deck 内优先能匹配 meaningIndex 的）
    const inPackDeck = candidates.filter((candidate) => candidate.deckId === opts.packDeckId)
    word = inPackDeck.find(meaningFits) ?? inPackDeck[0]
    if (!word && opts.resolveAllDecks) {
      word = candidates.find(meaningFits) ?? candidates[0]
    }
  } else {
    const inDeck = opts.resolveAllDecks ? candidates : candidates.filter((candidate) => candidate.deckId === deckId)
    word = inDeck.find(meaningFits) ?? inDeck[0] ?? (opts.resolveAllDecks ? (candidates.find(meaningFits) ?? candidates[0]) : undefined)
  }
  if (!word) {
    return {
      ok: false,
      skip: {
        headwordLower: lower,
        meaningIndex: item.meaningIndex,
        reason: 'unknown-word',
        detail: item.headword,
        item,
      },
    }
  }
  if (item.meaningIndex != null && !word.meanings[item.meaningIndex - 1]) {
    return {
      ok: false,
      skip: {
        headwordLower: lower,
        meaningIndex: item.meaningIndex,
        reason: 'unknown-meaning',
        detail: `${word.headword} 只有 ${word.meanings.length} 个含义`,
        item,
      },
    }
  }
  return {
    ok: true,
    resolved: {
      itemId: `pending:${index}`,
      wordId: word.id,
      deckId: word.deckId,
      meaningId: item.meaningIndex != null ? meaningIdOf(word.id, item.meaningIndex) : undefined,
      item,
    },
  }
}

/** 单条解析（reapplyPack 等小批量场景；逐条查询） */
async function resolveItem(
  item: PackItemV1,
  index: number,
  opts: ResolveOptions,
): Promise<{ ok: true; resolved: ResolvedItem } | { ok: false; skip: SkipRecord }> {
  const lower = normalizeHeadword(item.headwordLower || item.headword)
  const settings = await getSettings()
  const wordIndex = await loadWordIndex([lower])
  return resolveWithIndexes(item, index, opts, wordIndex, settings['data.selectedDeckId'])
}

/** 预览：只解析目标（不写库），返回 matched/skipped 报告 */
export async function previewPack(
  file: PackFileV1,
  opts: ResolveOptions = {},
): Promise<PackPreview> {
  const matched: ResolvedItem[] = []
  const skipped: SkipRecord[] = []
  const resolveOpts: ResolveOptions = { ...opts, ...(file.meta?.deckId ? { packDeckId: file.meta.deckId } : {}) }
  const lowers = file.items.map((item) => normalizeHeadword(item.headwordLower || item.headword))
  // 一次性批量预取（500/批），不再逐 item 查 words
  const [wordIndex, settings] = await Promise.all([
    loadWordIndex(lowers, resolveOpts.packDeckId ?? opts.deckId, Boolean(opts.resolveAllDecks)),
    getSettings(),
  ])
  const selectedDeckId = settings['data.selectedDeckId']
  file.items.forEach((item, index) => {
    const result = resolveWithIndexes(item, index, resolveOpts, wordIndex, selectedDeckId)
    if (result.ok) matched.push(result.resolved)
    else skipped.push(result.skip)
  })
  return {
    matched,
    skipped,
    counts: { total: file.items.length, matched: matched.length, skipped: skipped.length },
  }
}

// ============ 导入 / 审核 / 应用 ============

export interface ImportPackResult {
  ok: boolean
  packId?: string
  /** task-90：文件校验和/目标 deck（用于「已存在时找到旧 pack 做 reapply」） */
  checksum?: string
  deckId?: string
  /** task-92：命中已有同 checksum 的 pack（未重复导入），可直接补审/重应用 */
  reused?: boolean
  preview: PackPreview
  issues: ImportIssue[]
}

/**
 * 导入内容包：解析 → 校验 → 目标解析 → 建 pack（pending 条目）+ 跳过记录。
 * 幂等：已存在相同内容 hash 的条目（pending/approved/applied）→ skipped:duplicate；被 ❌ 的 → skipped:rejected。
 */
export async function importPack(input: string | Blob, opts: ResolveOptions = {}): Promise<ImportPackResult> {
  const parsed = await parsePackFile(input)
  if (!parsed.ok) {
    return { ok: false, preview: { matched: [], skipped: [], counts: { total: 0, matched: 0, skipped: 0 } }, issues: parsed.issues }
  }
  const file = parsed.value
  const db = getDb()
  // task-92：同 checksum 的 pack 已存在 → 不再重复导入（避免 force seed/重复点击产生重复 pack）。
  // 若文件新增了 meta.deckId（修复包），顺手更新到已有 pack 记录上，随后由 reapplyPack 修复 skipped。
  const existingPack = (await db.packs.toArray()).find((pack) => pack.checksum === file.checksum)
  if (existingPack) {
    const nextDeckId = file.meta?.deckId ?? existingPack.deckId
    if (nextDeckId && nextDeckId !== existingPack.deckId) {
      await db.packs.update(existingPack.id, { deckId: nextDeckId, updatedAt: Date.now() })
    }
    return {
      ok: true,
      packId: existingPack.id,
      checksum: file.checksum,
      ...(nextDeckId ? { deckId: nextDeckId } : {}),
      reused: true,
      preview: {
        matched: [],
        skipped: [],
        counts: { total: file.items.length, matched: 0, skipped: file.items.length },
      },
      issues: [
        ...parsed.issues,
        {
          level: 'warning',
          code: 'E_DUP',
          message: '该内容包已存在（未重复导入）；如需修复旧条目请使用「重新应用」',
          path: 'checksum',
        },
      ],
    }
  }
  // 批量预取：words（按 headwordLower 去重 anyOf 500/批）+ 拒绝记忆一次预取；不再逐 item 查询
  const lowers = file.items.map((item) => normalizeHeadword(item.headwordLower || item.headword))
  const resolveOpts: ResolveOptions = { ...opts, ...(file.meta?.deckId ? { packDeckId: file.meta.deckId } : {}) }
  opts.onProgress?.({ phase: 'resolve', done: 0, total: file.items.length })
  const [wordIndex, rejectIndex, settings] = await Promise.all([
    loadWordIndex(lowers, resolveOpts.packDeckId ?? opts.deckId, Boolean(opts.resolveAllDecks)),
    loadRejectIndex(),
    getSettings(),
  ])
  const selectedDeckId = settings['data.selectedDeckId']
  const resolvedList: Array<{ index: number; result: ReturnType<typeof resolveWithIndexes> }> = []
  file.items.forEach((item, index) => {
    resolvedList.push({ index, result: resolveWithIndexes(item, index, resolveOpts, wordIndex, selectedDeckId) })
  })
  opts.onProgress?.({ phase: 'resolve', done: file.items.length, total: file.items.length })
  const skipped: SkipRecord[] = resolvedList.filter((entry) => !entry.result.ok).map((entry) => (entry.result as { ok: false; skip: SkipRecord }).skip)
  // 已有条目 hash（含 skipped，保证幂等；重复导入不会产生新包）
  const existingItems = await db.packItems.toArray()
  const existingHashes = new Set(existingItems.flatMap((item) => item.contentHashes))
  const matched: ResolvedItem[] = []
  const now = Date.now()
  const packId = newPackId(now)
  const itemRecords: PackItemRecord[] = []
  let seq = 0

  for (const entry of resolvedList) {
    if (!entry.result.ok) continue
    const resolved = entry.result.resolved
    const lower = normalizeHeadword(resolved.item.headwordLower || resolved.item.headword)
    const hashes = itemContentHashes(resolved.item)
    const rejectedHashes = rejectIndex.get(lower) ?? new Set<string>()
    // 只有「全部内容都已存在」才算重复整条跳过；部分重复允许（apply 时逐条只补缺/去重）
    if (hashes.length > 0 && hashes.every((hash) => existingHashes.has(hash))) {
      skipped.push({
        headwordLower: lower,
        meaningIndex: resolved.item.meaningIndex,
        reason: 'duplicate',
        detail: '已存在相同内容',
      })
      continue
    }
    if (hashes.length > 0 && hashes.every((hash) => rejectedHashes.has(hash))) {
      skipped.push({
        headwordLower: lower,
        meaningIndex: resolved.item.meaningIndex,
        reason: 'rejected',
        detail: '该内容已被标记为拒绝',
      })
      continue
    }
    seq += 1
    itemRecords.push({
      id: `${packId}:${seq}`,
      packId,
      seq,
      headword: resolved.item.headword,
      headwordLower: lower,
      ...(resolved.item.meaningIndex != null ? { meaningIndex: resolved.item.meaningIndex } : {}),
      wordId: resolved.wordId,
      ...(resolved.meaningId ? { meaningId: resolved.meaningId } : {}),
      deckId: resolved.deckId,
      payload: resolved.item,
      status: 'pending',
      contentHashes: hashes,
      createdAt: now,
    })
    matched.push(resolved)
  }
  // task-90：unknown-* 的条目也要落库为 skipped（供 reapplyPack 修复后重试；UI 也能看到跳过原因）
  for (const skip of skipped) {
    if (!skip.item) continue
    if (skip.reason !== 'unknown-word' && skip.reason !== 'unknown-meaning') continue
    seq += 1
    itemRecords.push({
      id: `${packId}:${seq}`,
      packId,
      seq,
      headword: skip.item.headword,
      headwordLower: skip.item.headwordLower || normalizeHeadword(skip.item.headword),
      ...(skip.item.meaningIndex != null ? { meaningIndex: skip.item.meaningIndex } : {}),
      payload: skip.item,
      status: 'skipped',
      skipReason: skip.reason,
      contentHashes: itemContentHashes(skip.item),
      createdAt: now,
    })
  }

  if (itemRecords.length === 0) {
    return {
      ok: true,
      checksum: file.checksum,
      ...(file.meta?.deckId ? { deckId: file.meta.deckId } : {}),
      reused: false,
      preview: { matched, skipped, counts: { total: file.items.length, matched: 0, skipped: skipped.length } },
      issues: parsed.issues,
    }
  }
  const counts = emptyCounts()
  counts.items = itemRecords.length
  for (const record of itemRecords) counts[record.status] += 1
  const pack: PackRecord = {
    id: packId,
    name: file.meta?.name ?? `内容包 ${new Date(now).toLocaleString('zh-CN')}`,
    kind: file.kind,
    formatVersion: file.formatVersion,
    checksum: file.checksum,
    source: (file.meta?.source as PackRecord['source']) ?? 'import',
    ...(file.meta?.provider ? { provider: file.meta.provider } : {}),
    ...(file.meta?.model ? { model: file.meta.model } : {}),
    ...(file.meta?.promptVersion ? { promptVersion: file.meta.promptVersion } : {}),
    ...(file.meta?.scope !== undefined ? { scope: file.meta.scope } : {}),
    ...(file.meta?.deckId ? { deckId: file.meta.deckId } : {}),
    status: itemRecords.length > 0 ? 'reviewing' : 'empty',
    counts,
    createdAt: now,
    updatedAt: now,
  }
  opts.onProgress?.({ phase: 'write', done: 0, total: itemRecords.length })
  const ITEM_BATCH = 500
  await db.transaction('rw', [db.packs, db.packItems], async () => {
    await db.packs.put(pack)
    for (let offset = 0; offset < itemRecords.length; offset += ITEM_BATCH) {
      await db.packItems.bulkPut(itemRecords.slice(offset, offset + ITEM_BATCH))
      opts.onProgress?.({ phase: 'write', done: Math.min(offset + ITEM_BATCH, itemRecords.length), total: itemRecords.length })
    }
  })
  return {
    ok: true,
    packId,
    checksum: file.checksum,
    ...(file.meta?.deckId ? { deckId: file.meta.deckId } : {}),
    reused: false,
    preview: { matched, skipped, counts: { total: file.items.length, matched: matched.length, skipped: skipped.length } },
    issues: parsed.issues,
  }
}

/** 导入 UI 入口别名 */
export const importContentPack = importPack

/** 批量 ✓（pending → approved，可撤销未落库） */
export async function approveItems(packId: string, itemIds: string[]): Promise<number> {
  const db = getDb()
  const now = Date.now()
  let changed = 0
  const BATCH = 500
  await db.transaction('rw', [db.packItems, db.packs], async () => {
    // 批量读 + 批量写（28k 条 seed 时避免 2×N 次单条 IDB 往返）
    const rows = await db.packItems.bulkGet(itemIds)
    const updates: PackItemRecord[] = []
    for (const item of rows) {
      if (!item || item.packId !== packId) continue
      if (item.status !== 'pending' && item.status !== 'rejected') continue
      updates.push({ ...item, status: 'approved' })
    }
    for (let i = 0; i < updates.length; i += BATCH) {
      await db.packItems.bulkPut(updates.slice(i, i + BATCH))
    }
    changed = updates.length
    await refreshPack(packId, now)
  })
  return changed
}

/** 批量 ❌（pending/approved → rejected；同时写拒绝记忆） */
export async function rejectItems(packId: string, itemIds: string[]): Promise<number> {
  const db = getDb()
  const now = Date.now()
  let changed = 0
  await db.transaction('rw', [db.packItems, db.packs, db.contentRejects], async () => {
    for (const id of itemIds) {
      const item = await db.packItems.get(id)
      if (!item || item.packId !== packId || item.status === 'applied' || item.status === 'skipped') continue
      await db.packItems.update(id, { status: 'rejected' })
      for (const content of itemContents(item.payload)) {
        const reject: ContentRejectRecord = {
          id: `${content.kind}:${item.headwordLower}:${item.meaningIndex ?? 0}:${content.hash}`,
          kind: content.kind,
          headwordLower: item.headwordLower,
          ...(item.meaningIndex != null ? { meaningIndex: item.meaningIndex } : {}),
          hash: content.hash,
          rejectedAt: now,
        }
        await db.contentRejects.put(reject)
      }
      changed += 1
    }
    await refreshPack(packId, now)
  })
  return changed
}

/** 校验语义条目：coreSenses 索引唯一、meaningMap 指向有效含义与本 item 的本义 */
function validateSemanticsItem(
  word: Word,
  item: PackItemV1,
): { ok: true } | { ok: false; reason: 'unknown-meaning' | 'invalid'; detail?: string } {
  const senses = item.coreSenses ?? []
  const mappings = item.meaningMap ?? []
  if (senses.length === 0 && mappings.length === 0) return { ok: false, reason: 'invalid', detail: '无语义内容' }
  if (mappings.length > 0 && senses.length === 0) {
    return { ok: false, reason: 'invalid', detail: 'meaningMap 存在但没有 coreSenses' }
  }
  const senseIndices = new Set<number>()
  for (const sense of senses) {
    if (senseIndices.has(sense.index)) return { ok: false, reason: 'invalid', detail: `重复 coreSense.index=${sense.index}` }
    senseIndices.add(sense.index)
  }
  for (const mapping of mappings) {
    if (!word.meanings[mapping.meaningIndex - 1]) {
      return { ok: false, reason: 'unknown-meaning', detail: `meaningIndex=${mapping.meaningIndex} 越界` }
    }
    if (!senseIndices.has(mapping.coreSenseIndex)) {
      return { ok: false, reason: 'invalid', detail: `coreSenseIndex=${mapping.coreSenseIndex} 不存在` }
    }
  }
  return { ok: true }
}

export interface ApplyResult {
  applied: number
  skipped: number
  packStatus: PackRecord['status']
  skippedDetails: SkipRecord[]
}

/** 应用某 pack 的全部 approved 条目（单事务；幂等：已存在内容不重复追加） */
export async function applyApproved(
  packId: string,
  opts: {
    retrySkipped?: boolean
    /** 每批进度（merge 后/写完后；供 UI 进度条）；默认 500 条/批 */
    onProgress?: (progress: { phase: 'apply'; done: number; total: number }) => void
    batchSize?: number
  } = {},
): Promise<ApplyResult> {
  const db = getDb()
  const now = Date.now()
  const items = opts.retrySkipped
    ? (await db.packItems.where('packId').equals(packId).toArray()).filter(
        (item) =>
          item.status === 'approved' ||
          (item.status === 'skipped' &&
            (item.skipReason === 'unknown-word' || item.skipReason === 'unknown-meaning')),
      )
    : await db.packItems.where('[packId+status]').equals([packId, 'approved']).toArray()
  const rejectIndex = await loadRejectIndex()
  const BATCH = Math.max(100, Math.min(500, Math.floor(opts.batchSize ?? 500)))
  let applied = 0
  let skipped = 0
  const skippedDetails: SkipRecord[] = []
  const total = items.length
  opts.onProgress?.({ phase: 'apply', done: 0, total })
  // task-96：按 BATCH 拆事务（不再单个巨型事务）；每批 commit 后可进下一批/让出主线程。
  // 幂等：mergeItemIntoWord 去重；中途失败已提交的批次不会重复追加内容。
  for (let offset = 0; offset < items.length; offset += BATCH) {
    const batch = items.slice(offset, offset + BATCH)
    await db.transaction('rw', [db.words, db.packItems], async () => {
      const wordIds = [...new Set(batch.map((item) => item.wordId).filter((id): id is string => Boolean(id)))]
      const wordRows = wordIds.length > 0 ? await db.words.bulkGet(wordIds) : []
      const words = new Map<string, Word>()
      wordRows.forEach((word, index) => {
        if (word) words.set(wordIds[index]!, word)
      })
      const updatedWords = new Map<string, Word>()
      const updatedItems: PackItemRecord[] = []
      for (const item of batch) {
        let word = item.wordId ? (updatedWords.get(item.wordId) ?? words.get(item.wordId)) : undefined
        if (!word || !item.wordId) {
          updatedItems.push({ ...item, status: 'skipped', skipReason: 'unknown-word' })
          skipped += 1
          skippedDetails.push({ headwordLower: item.headwordLower, meaningIndex: item.meaningIndex, reason: 'unknown-word', itemId: item.id })
          continue
        }
        const payload = item.payload
        const hasWordContent = Boolean(
          (payload.examples?.length ?? 0) > 0 ||
            (payload.phrases?.length ?? 0) > 0 ||
            (payload.mnemonics?.length ?? 0) > 0,
        )
        const hasSemantics = Boolean((payload.coreSenses?.length ?? 0) > 0 || (payload.meaningMap?.length ?? 0) > 0)
        let semanticsOk = false
        if (hasSemantics) {
          const check = validateSemanticsItem(word, payload)
          if (!check.ok) {
            updatedItems.push({ ...item, status: 'skipped', skipReason: check.reason })
            skipped += 1
            skippedDetails.push({
              headwordLower: item.headwordLower,
              meaningIndex: item.meaningIndex,
              reason: check.reason,
              detail: check.detail,
              itemId: item.id,
            })
            continue
          }
          semanticsOk = true
        }
        const rejected = rejectIndex.get(item.headwordLower) ?? new Set<string>()
        const result = hasWordContent
          ? mergeItemIntoWord(word, payload, rejected, item.meaningIndex)
          : { word, changed: false, added: { examples: [], phrases: [], mnemonics: [] }, skipped: [] }
        for (const skip of result.skipped) {
          skippedDetails.push({
            headwordLower: item.headwordLower,
            meaningIndex: item.meaningIndex,
            reason: skip.reason,
            detail: skip.value,
            itemId: item.id,
          })
        }
        if (result.changed) {
          updatedWords.set(item.wordId, result.word)
          word = result.word
        }
        if (result.changed || semanticsOk) {
          updatedItems.push({
            ...item,
            status: 'applied',
            appliedAt: now,
            appliedContent: result.added,
          })
          applied += 1
        } else {
          const reason: MergeSkip['reason'] = result.skipped[0]?.reason ?? 'duplicate'
          updatedItems.push({ ...item, status: 'skipped', skipReason: reason })
          skipped += 1
          skippedDetails.push({ headwordLower: item.headwordLower, meaningIndex: item.meaningIndex, reason, itemId: item.id })
        }
      }
      const WRITE_BATCH = 500
      const wordValues = [...updatedWords.values()]
      for (let i = 0; i < wordValues.length; i += WRITE_BATCH) {
        await db.words.bulkPut(wordValues.slice(i, i + WRITE_BATCH))
      }
      for (let i = 0; i < updatedItems.length; i += WRITE_BATCH) {
        await db.packItems.bulkPut(updatedItems.slice(i, i + WRITE_BATCH))
      }
    })
    opts.onProgress?.({ phase: 'apply', done: Math.min(offset + batch.length, total), total })
  }
  const pack = await refreshPack(packId, now)
  return { applied, skipped, packStatus: pack?.status ?? 'empty', skippedDetails }
}

/**
 * task-90：修复 deck 解析后**重新应用旧 pack**（把 `skipped:unknown-word/unknown-meaning` 重置为 approved 并重试）。
 * - 可按 opts.deckId 覆盖 pack.deckId（旧 pack 没有 meta.deckId 时，UI 可让用户指定词库）；
 * - 重新解析 headwordLower → 正确 deck 的 wordId/meaningId，再走 apply 事务；幂等。
 */
export interface ReapplyProgress {
  phase: 'resolve' | 'apply'
  done: number
  total: number
  retried: number
}

export interface ReapplyOptions {
  deckId?: string
  /** 每批处理条数（默认 200；大批量时避免单事务过久） */
  batchSize?: number
  /** 进度回调（每批/应用完成后；供 UI 进度条） */
  onProgress?: (progress: ReapplyProgress) => void
}

/**
 * task-90/92：修复 deck 解析后**重新应用旧 pack**。
 * - **只处理 `status==='skipped'` 且 skipReason 为 unknown-word/unknown-meaning** 的条目；
 * - 分批事务（默认 200/批）+ 进度回调；不会触碰已 applied/pending 条目；
 * - 全部解析完后统一 apply（幂等）。
 */
async function reapplyOnePack(
  packId: string,
  opts: ReapplyOptions,
): Promise<ApplyResult & { retried: number }> {
  const db = getDb()
  const pack = await db.packs.get(packId)
  if (!pack) throw new Error(`内容包不存在：${packId}`)
  const targetDeckId = opts.deckId ?? pack.deckId
  const batchSize = Math.max(10, Math.min(1000, Math.floor(opts.batchSize ?? 200)))
  // 只查 skipped（[packId+status] 索引）；不加载 applied/pending
  const skipped = (await db.packItems.where('[packId+status]').equals([packId, 'skipped']).toArray()).filter(
    (item) => item.skipReason === 'unknown-word' || item.skipReason === 'unknown-meaning',
  )
  const total = skipped.length
  let retried = 0
  opts.onProgress?.({ phase: 'resolve', done: 0, total, retried })

  for (let offset = 0; offset < skipped.length; offset += batchSize) {
    const batch = skipped.slice(offset, offset + batchSize)
    await db.transaction('rw', [db.packItems, db.words, db.settings], async () => {
      const updates: PackItemRecord[] = []
      for (const item of batch) {
        const resolved = await resolveItem(item.payload, item.seq, {
          resolveAllDecks: true,
          ...(targetDeckId ? { packDeckId: targetDeckId } : {}),
        })
        if (!resolved.ok) continue
        updates.push({
          ...item,
          status: 'approved',
          wordId: resolved.resolved.wordId,
          ...(resolved.resolved.meaningId ? { meaningId: resolved.resolved.meaningId } : {}),
          deckId: resolved.resolved.deckId,
          skipReason: undefined,
        })
        retried += 1
      }
      if (updates.length > 0) await db.packItems.bulkPut(updates)
    })
    opts.onProgress?.({ phase: 'resolve', done: Math.min(offset + batchSize, total), total, retried })
  }

  const applied = await applyApproved(packId, { retrySkipped: true })
  opts.onProgress?.({ phase: 'apply', done: total, total, retried })
  return { ...applied, retried }
}

/**
 * task-90/92/104：重新应用旧 pack（修复 skipped）。
 * - 只处理 skipped(unknown-word/unknown-meaning)，分批事务 + 进度；
 * - **task-104**：同 checksum 的重复包一并处理（避免点了其中一行、列表其它行 counts 仍旧）；
 * - 返回的是「点击的 pack」结果；`siblings` 表示另外处理的重复包数量。
 */
export async function reapplyPack(
  packId: string,
  opts: ReapplyOptions = {},
): Promise<ApplyResult & { retried: number; siblings: number }> {
  const db = getDb()
  const pack = await db.packs.get(packId)
  if (!pack) throw new Error(`内容包不存在：${packId}`)
  const group = (await db.packs.toArray()).filter((candidate) => candidate.checksum === pack.checksum)
  const siblings = group.filter((candidate) => candidate.id !== packId)
  // 先处理重复包（用同一 deckId 覆盖），再处理点击的包并返回其结果
  for (const sibling of siblings) {
    await reapplyOnePack(sibling.id, {
      ...opts,
      ...(opts.deckId ? {} : sibling.deckId ? { deckId: sibling.deckId } : {}),
    })
  }
  const result = await reapplyOnePack(packId, opts)
  return { ...result, siblings: siblings.length }
}

/** task-92：清理重复内容包（按 checksum 分组；保留「已应用最多 → 最早创建」的一份） */
/** task-99/0.3.15：需要迁移到 v4 的旧 semantics pack（promptVersion 非 v4） */
export async function listLegacySemanticsPacks(): Promise<PackRecord[]> {
  const packs = await listPacks()
  return packs.filter((pack) => pack.kind === 'semantics' && pack.promptVersion !== 'v4.0-semantics-grouped')
}

/**
 * task-99/0.3.15：seed/升级时**自动清理被 v4 覆盖的旧 semantics pack**。
 * 规则：存在 v4 semantics pack（promptVersion='v4.0-semantics-grouped'）的 deckId，
 * 其旧 semantics pack（promptVersion≠v4）会被删除（旧链不再参与 effective 合并）。
 * 只删 pack 记录/items，不写 Word；其它 deck 的旧包保留，供 UI「替换为 v4 数据」手动处理。
 */
export async function pruneLegacySemanticsPacks(opts: {
  /** 限定只处理这些 deckId（默认：所有已有 v4 semantics pack 的 deck） */
  deckIds?: string[]
} = {}): Promise<{ removed: string[]; kept: string[] }> {
  const packs = await listPacks()
  const v4Decks = new Set(
    packs
      .filter((pack) => pack.kind === 'semantics' && pack.promptVersion === 'v4.0-semantics-grouped')
      .map((pack) => pack.deckId)
      .filter((deckId): deckId is string => Boolean(deckId)),
  )
  const targets = new Set(opts.deckIds ?? [...v4Decks])
  const removable = packs.filter(
    (pack) =>
      pack.kind === 'semantics' &&
      pack.promptVersion !== 'v4.0-semantics-grouped' &&
      pack.deckId != null &&
      (opts.deckIds ? targets.has(pack.deckId) : v4Decks.has(pack.deckId)),
  )
  const removed = removable.map((pack) => pack.id)
  if (removed.length > 0) await deletePacks(removed)
  return { removed, kept: packs.filter((pack) => !removed.includes(pack.id)).map((pack) => pack.id) }
}

export interface ReplacePackResult {
  oldPackId: string
  newPackId: string
  /** 新包应用条数 */
  applied: number
  /** 新包跳过条数 */
  skipped: number
  /** 旧 pack 是否已删除 */
  removedOld: boolean
}

/**
 * task-99/0.3.15：用新 pack（v4）**替换**旧 pack（同词库旧 v3 本义链）。
 * 顺序保证安全：先导入新包 → 补审 → apply → 成功后才删除旧包；任一步失败旧包保留。
 * 旧 semantics pack 不写 Word（effective 合并展示），删除旧包即移除旧链数据。
 */
export async function replacePackContent(
  oldPackId: string,
  input: string | Blob,
  opts: { resolveAllDecks?: boolean; onProgress?: ResolveOptions['onProgress'] } = {},
): Promise<ReplacePackResult> {
  const db = getDb()
  const oldPack = await db.packs.get(oldPackId)
  if (!oldPack) throw new Error(`旧内容包不存在：${oldPackId}`)
  const imported = await importPack(input, {
    resolveAllDecks: opts.resolveAllDecks ?? true,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  })
  if (!imported.ok || !imported.packId) {
    throw new Error(imported.issues[0]?.message ?? '新内容包导入失败')
  }
  if (imported.packId === oldPackId) {
    throw new Error('新内容包与旧包相同（checksum 一致），无需替换；可直接「重新应用」')
  }
  const newPackId = imported.packId
  const items = await listPackItems(newPackId)
  const pendingIds = items.filter((item) => item.status === 'pending').map((item) => item.id)
  if (pendingIds.length > 0) await approveItems(newPackId, pendingIds)
  const applied = await applyApproved(newPackId)
  if (newPackId !== oldPackId) await deletePack(oldPackId)
  return { oldPackId, newPackId, applied: applied.applied, skipped: applied.skipped, removedOld: true }
}

export interface DedupePacksResult {
  removed: number
  kept: number
  packs: Array<{ checksum: string; keptPackId: string; removedPackIds: string[] }>
}

export async function dedupePacks(): Promise<DedupePacksResult> {
  const db = getDb()
  const packs = await db.packs.toArray()
  const groups = new Map<string, PackRecord[]>()
  for (const pack of packs) {
    const list = groups.get(pack.checksum) ?? []
    list.push(pack)
    groups.set(pack.checksum, list)
  }
  const result: DedupePacksResult = { removed: 0, kept: 0, packs: [] }
  const removableIds: string[] = []
  for (const [checksum, group] of groups) {
    if (group.length <= 1) continue
    const stats = await Promise.all(
      group.map(async (pack) => ({
        pack,
        applied: await db.packItems.where('[packId+status]').equals([pack.id, 'applied']).count(),
      })),
    )
    stats.sort((a, b) => {
      if (b.applied !== a.applied) return b.applied - a.applied
      if (a.pack.createdAt !== b.pack.createdAt) return a.pack.createdAt - b.pack.createdAt
      return a.pack.id < b.pack.id ? -1 : 1
    })
    const keptPack = stats[0]!.pack
    const removedPacks = stats.slice(1).map((stat) => stat.pack)
    removableIds.push(...removedPacks.map((pack) => pack.id))
    result.packs.push({ checksum, keptPackId: keptPack.id, removedPackIds: removedPacks.map((pack) => pack.id) })
  }
  // task-94：一次性批量删除（单事务，不再每个重复包各开事务）
  if (removableIds.length > 0) result.removed = (await deletePacks(removableIds)).removed
  result.kept = packs.length - result.removed
  return result
}

/** 重新统计 pack 状态/计数（在事务内调用） */
async function refreshPack(packId: string, now: number): Promise<PackRecord | undefined> {
  const db = getDb()
  const pack = await db.packs.get(packId)
  if (!pack) return undefined
  // task-92 性能：按状态索引 count()，不读取该包全部 items（28k 包也不占内存）
  const counts = emptyCounts()
  for (const status of ['pending', 'approved', 'applied', 'rejected', 'skipped'] as const) {
    counts[status] = await db.packItems.where('[packId+status]').equals([packId, status]).count()
  }
  counts.items = counts.pending + counts.approved + counts.applied + counts.rejected + counts.skipped
  const remaining = counts.pending + counts.approved
  let status: PackRecord['status'] = 'reviewing'
  if (counts.applied > 0 && remaining === 0) status = 'applied'
  else if (counts.applied > 0 || counts.rejected > 0) status = 'partial'
  else if (counts.items === 0) status = 'empty'
  const next: PackRecord = {
    ...pack,
    counts,
    status,
    updatedAt: now,
    ...(status === 'applied' ? { appliedAt: pack.appliedAt ?? now } : {}),
  }
  await db.packs.put(next)
  return next
}

// ============ 导出 / 列表 / 删除 ============

/** 导出 pack（默认已应用条目；includePending=true 含 pending/approved） */
export async function exportPack(packId: string, opts: { includePending?: boolean } = {}): Promise<Blob> {
  const db = getDb()
  const pack = await db.packs.get(packId)
  if (!pack) throw new Error(`内容包不存在：${packId}`)
  const statuses = opts.includePending ? ['applied', 'approved', 'pending'] : ['applied']
  const records = (await db.packItems.where('packId').equals(packId).toArray())
    .filter((item) => statuses.includes(item.status))
    .sort((a, b) => a.seq - b.seq)
  const items: PackItemV1[] = records.map((record) => record.payload)
  const base = {
    format: PACK_FORMAT as typeof PACK_FORMAT,
    formatVersion: PACK_FORMAT_VERSION as typeof PACK_FORMAT_VERSION,
    kind: pack.kind as PackKind,
    createdAt: pack.createdAt,
    generator: PACK_GENERATOR,
    items,
    meta: {
      name: pack.name,
      source: 'export' as const,
      ...(pack.provider ? { provider: pack.provider } : {}),
      ...(pack.model ? { model: pack.model } : {}),
      ...(pack.promptVersion ? { promptVersion: pack.promptVersion } : {}),
      createdBy: BRAND.name,
    },
  }
  const checksum = await computeChecksum(packChecksumPayload(base))
  const file: PackFileV1 = {
    ...base,
    checksum: checksum.hex,
    meta: { ...base.meta, checksumAlgo: checksum.algo },
  }
  return new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
}

export async function listPacks(): Promise<PackRecord[]> {
  const db = getDb()
  return (await db.packs.orderBy('createdAt').reverse().toArray()) as PackRecord[]
}

export async function getPack(packId: string): Promise<PackRecord | null> {
  return (await getDb().packs.get(packId)) ?? null
}

export async function listPackItems(packId: string): Promise<PackItemRecord[]> {
  return (await getDb().packItems.where('packId').equals(packId).toArray()).sort((a, b) => a.seq - b.seq)
}

export interface PackStats {
  packs: number
  items: PackCounts
  rejects: number
}

export async function getPackStats(): Promise<PackStats> {
  const db = getDb()
  const [packs, items, rejects] = await Promise.all([
    db.packs.count(),
    db.packItems.toArray(),
    db.contentRejects.count(),
  ])
  const counts = emptyCounts()
  counts.items = items.length
  for (const item of items) counts[item.status] += 1
  return { packs, items: counts, rejects }
}

/** 删除 pack（默认保留已落库内容；removeAppliedContent=true 时按 appliedContent 精确移除） */
/**
 * task-94：批量删除内容包。
 * - 默认（removeAppliedContent=false）**不读取 packItems**：直接按 packId 索引删除 + 删 pack 记录；
 * - removeAppliedContent=true 时只读 applied 条目，按批（默认 300 条）更新 Word（多包引用同一内容则保留）；
 * - 不影响其它包/未由该包落库的词库内容。
 */
export async function deletePacks(
  packIds: string[],
  opts: { removeAppliedContent?: boolean } = {},
): Promise<{ removed: number }> {
  const db = getDb()
  const ids = [...new Set(packIds)]
  if (ids.length === 0) return { removed: 0 }

  if (!opts.removeAppliedContent) {
    // 快路径：无需 toArray 全部条目（大包也不会占内存）
    await db.transaction('rw', [db.packs, db.packItems], async () => {
      for (const id of ids) {
        await db.packItems.where('packId').equals(id).delete()
        await db.packs.delete(id)
      }
    })
    return { removed: ids.length }
  }

  return db.transaction('rw', [db.packs, db.packItems, db.words], async () => {
    const idSet = new Set(ids)
    // 仅此路径需要读取 applied 条目（仍只读 applied，不读 pending/skipped 全量）
    const allApplied = await db.packItems.where('status').equals('applied').toArray()
    const keepHashes = new Set(
      allApplied.filter((item) => !idSet.has(item.packId)).flatMap((item) => item.contentHashes),
    )
    const CHUNK = 300
    for (const id of ids) {
      const applied = allApplied.filter(
        (item) => item.packId === id && item.wordId && item.appliedContent,
      )
      const pendingWords = new Map<string, Word>()
      for (let offset = 0; offset < applied.length; offset += CHUNK) {
        const chunk = applied.slice(offset, offset + CHUNK)
        for (const item of chunk) {
          const word = pendingWords.get(item.wordId!) ?? (await db.words.get(item.wordId!))
          if (!word) continue
          const removed = item.appliedContent!
          pendingWords.set(item.wordId!, {
            ...word,
            examples: word.examples.filter((example) => {
              const hash = contentHash('examples', word.headwordLower, undefined, example.en)
              return !removed.examples.some((en) => normalizeEn(en) === normalizeEn(example.en)) || keepHashes.has(hash)
            }),
            phrases: word.phrases.filter((phrase) => {
              const idx = phrase.meaningId ? Number(phrase.meaningId.split('#M')[1]) : undefined
              const hash = contentHash('phrases', word.headwordLower, idx, phrase.en)
              return !removed.phrases.some((en) => normalizeEn(en) === normalizeEn(phrase.en)) || keepHashes.has(hash)
            }),
            mnemonics: word.mnemonics.filter((mnemonic) => {
              const key = mnemonicKey({ type: mnemonic.type, text: mnemonic.text })
              const hash = contentHash('mnemonics', word.headwordLower, undefined, key)
              return !removed.mnemonics.some((m) => mnemonicKey(m) === key) || keepHashes.has(hash)
            }),
          })
        }
      }
      if (pendingWords.size > 0) await db.words.bulkPut([...pendingWords.values()])
      await db.packItems.where('packId').equals(id).delete()
      await db.packs.delete(id)
    }
    return { removed: ids.length }
  })
}

/** 删除单个内容包（默认保留已落库内容；removeAppliedContent=true 时按 appliedContent 精确移除） */
export async function deletePack(packId: string, opts: { removeAppliedContent?: boolean } = {}): Promise<void> {
  await deletePacks([packId], opts)
}

// ============ 有效内容查询 ============

/** 有效本义条目（带来源 pack.source，UI 可据此标「AI 推演，仅供参考」） */
export type EffectiveCoreSense = CoreSenseV1 & { source?: PackSource }
/** 有效含义映射（带来源；steps=本义→引申链，可直接渲染） */
export type EffectiveMeaningMap = MeaningMapV1 & { source?: PackSource }

export interface EffectiveMeaningSemantics {
  meaningIndex: number
  coreSenseIndex?: number
  coreSense?: EffectiveCoreSense
  note?: string
  /** 多步本义链（顺序即展示顺序）；无则 UI 回退 label+note */
  steps?: string[]
}

export interface EffectiveContent {
  wordId: string
  meaningId?: string
  examples: Array<{ en: string; cn: string }>
  phrases: Array<{ en: string; cn: string }>
  mnemonics: Array<{ type: string; text: string }>
  /** task-75：合并后的本义（coreSenses，index 已重编号 1..N；label 去重、首个生效；source=来源 pack 类型） */
  coreSenses: EffectiveCoreSense[]
  /** task-75：合并后的含义→本义映射（meaningIndex→coreSenseIndex 指向上面数组；只补缺、已有保留） */
  meaningMap: EffectiveMeaningMap[]
  /** 指定 meaningId 时的当前含义映射（无映射/无 coreSenses 时为 undefined，UI 回退不展示） */
  meaning?: EffectiveMeaningSemantics
}

/**
 * 某词（可选某含义）的有效内容 = 当前 Word 内容 + 已应用 packItems 合并（只读）。
 * 正常 apply 后内容已在 Word 中；这里再合并 applied 条目，保证重种/部分失败时也不丢展示。
 */
export async function getEffectiveContent(wordId: string, meaningId?: string): Promise<EffectiveContent | null> {
  const db = getDb()
  const word = await db.words.get(wordId)
  if (!word) return null
  const applied = await db.packItems.where('wordId').equals(wordId).toArray()
  let merged: Word = word
  for (const item of applied.filter((record) => record.status === 'applied')) {
    merged = mergeItemIntoWord(merged, item.payload, new Set(), item.meaningIndex).word
  }
  const meaningIndex = meaningId ? Number(meaningId.split('#M')[1]) : undefined
  // task-75：合并语义（applied 条目按 appliedAt 顺序；coreSenses 去重 label，meaningMap 只补缺）
  const appliedInOrder = applied
    .filter((record) => record.status === 'applied')
    .sort(
      (a, b) =>
        (a.appliedAt ?? a.createdAt) - (b.appliedAt ?? b.createdAt) ||
        a.packId.localeCompare(b.packId) ||
        a.seq - b.seq,
    )
  const appliedPackIds = [...new Set(appliedInOrder.map((record) => record.packId))]
  const packRows = appliedPackIds.length > 0 ? await db.packs.bulkGet(appliedPackIds) : []
  const packSourceOf = new Map<string, PackSource>()
  packRows.forEach((pack, index) => {
    if (pack) packSourceOf.set(appliedPackIds[index]!, pack.source)
  })
  const coreSenses: EffectiveCoreSense[] = []
  const labelToMergedIndex = new Map<string, number>()
  const meaningMapByIndex = new Map<
    number,
    { coreSenseIndex: number; note?: string; source?: PackSource; steps?: string[] }
  >()
  const sourceOf = packSourceOf
  for (const record of appliedInOrder) {
    const payload = record.payload
    const localToMerged = new Map<number, number>()
    for (const sense of payload.coreSenses ?? []) {
      const labelKey = sense.label.trim().toLowerCase()
      const existing = labelToMergedIndex.get(labelKey)
      if (existing != null) {
        localToMerged.set(sense.index, existing)
        continue
      }
      const mergedIndex = coreSenses.length + 1
      const merged: EffectiveCoreSense = { index: mergedIndex, label: sense.label.trim() }
      if (sense.note) merged.note = sense.note
      if (sense.origin) merged.origin = sense.origin
      if (sense.confidence) merged.confidence = sense.confidence
      const packSource = sourceOf.get(record.packId)
      if (packSource) merged.source = packSource
      coreSenses.push(merged)
      labelToMergedIndex.set(labelKey, mergedIndex)
      localToMerged.set(sense.index, mergedIndex)
    }
    for (const mapping of payload.meaningMap ?? []) {
      const steps = (mapping.steps ?? []).map((step) => step.trim()).filter(Boolean)
      const existing = meaningMapByIndex.get(mapping.meaningIndex)
      if (existing) {
        // 只补缺：已有映射保留；若已有缺 steps 而新条目带 steps，则补齐链（不覆盖 coreSenseIndex）
        if (!existing.steps && steps.length > 0) existing.steps = steps
        continue
      }
      if (coreSenses.length === 0) continue
      const mapped = localToMerged.get(mapping.coreSenseIndex)
      if (mapped == null) continue
      const packSource = sourceOf.get(record.packId)
      const entry: { coreSenseIndex: number; note?: string; source?: PackSource; steps?: string[] } = {
        coreSenseIndex: mapped,
        ...(mapping.note ? { note: mapping.note } : {}),
        ...(packSource ? { source: packSource } : {}),
        ...(steps.length > 0 ? { steps } : {}),
      }
      meaningMapByIndex.set(mapping.meaningIndex, entry)
    }
  }
  const mergedMeaningMap: EffectiveMeaningMap[] = [...meaningMapByIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, value]) => ({
      meaningIndex: index,
      coreSenseIndex: value.coreSenseIndex,
      ...(value.note ? { note: value.note } : {}),
      ...(value.source ? { source: value.source } : {}),
      ...(value.steps && value.steps.length > 0 ? { steps: value.steps } : {}),
    }))
  const currentMapping = meaningIndex != null ? meaningMapByIndex.get(meaningIndex) : undefined
  const currentCoreSense = currentMapping ? coreSenses[currentMapping.coreSenseIndex - 1] : undefined
  const meaningSemantics: EffectiveMeaningSemantics | undefined =
    meaningIndex != null && currentMapping
      ? {
          meaningIndex,
          coreSenseIndex: currentMapping.coreSenseIndex,
          ...(currentCoreSense ? { coreSense: currentCoreSense } : {}),
          ...(currentMapping.note ? { note: currentMapping.note } : {}),
          ...(currentMapping.steps && currentMapping.steps.length > 0 ? { steps: currentMapping.steps } : {}),
        }
      : undefined
  const examples =
    meaningIndex != null && merged.meanings[meaningIndex - 1]?.examples
      ? merged.meanings[meaningIndex - 1]!.examples!.map((example) => ({ en: example.en, cn: example.cn ?? '' }))
      : merged.examples.map((example) => ({ en: example.en, cn: example.cn ?? '' }))
  const phrases =
    meaningId != null
      ? merged.phrases.filter((phrase) => phrase.meaningId === meaningId).map((phrase) => ({ en: phrase.en, cn: phrase.cn }))
      : merged.phrases.map((phrase) => ({ en: phrase.en, cn: phrase.cn }))
  return {
    wordId,
    ...(meaningId ? { meaningId } : {}),
    examples,
    phrases,
    mnemonics: merged.mnemonics.map((mnemonic) => ({ type: mnemonic.type, text: mnemonic.text })),
    coreSenses,
    meaningMap: mergedMeaningMap,
    ...(meaningSemantics ? { meaning: meaningSemantics } : {}),
  }
}

// ============ 范围选择 + 排除（§4） ============

async function hasPendingItem(wordId: string, kind: ContentKind, meaningIndex?: number): Promise<boolean> {
  const db = getDb()
  const items = await db.packItems.where('wordId').equals(wordId).toArray()
  return items.some((item) => {
    if (item.status !== 'pending' && item.status !== 'approved') return false
    if (meaningIndex != null && item.meaningIndex != null && item.meaningIndex !== meaningIndex) return false
    if (kind === 'examples') return (item.payload.examples ?? []).length > 0
    if (kind === 'phrases') return (item.payload.phrases ?? []).length > 0
    if (kind === 'mnemonics') return (item.payload.mnemonics ?? []).length > 0
    return (item.payload.coreSenses ?? []).length > 0 || (item.payload.meaningMap ?? []).length > 0
  })
}

async function isRejected(word: Word, kind: ContentKind, meaningIndex?: number): Promise<boolean> {
  const db = getDb()
  const rows = await db.contentRejects.where('headwordLower').equals(word.headwordLower).toArray()
  return rows.some((row) => {
    if (row.kind !== kind) return false
    if (meaningIndex != null && row.meaningIndex != null && row.meaningIndex !== meaningIndex) return false
    return true
  })
}

function existingCount(word: Word, kind: ContentKind, meaningIndex?: number, meaningId?: string): number {
  if (kind === 'semantics') return 0 // 语义存在与否由 applied packItems 异步判断（见 selectTargets）
  if (kind === 'examples') {
    if (meaningIndex != null) return word.meanings[meaningIndex - 1]?.examples?.length ?? 0
    return word.examples.length
  }
  if (kind === 'phrases') {
    if (meaningId != null) return word.phrases.filter((phrase) => phrase.meaningId === meaningId).length
    return word.phrases.length
  }
  return word.mnemonics.length
}

/** 按 scope 取候选词（不应用排除/分页） */
async function collectScopeWords(
  scope: TargetScope,
  deckId: string,
): Promise<{ words: Word[]; meaningFilter?: { wordId: string; meaningIndex: number; meaningId: string } }> {
  const db = getDb()
  if (scope.kind === 'today') {
    const plan = await db.plans.get(`${localDateKey(Date.now())}:${scope.deckId ?? deckId}`)
    const ids = plan ? [...new Set(plan.wordIds)] : []
    const words = ids.length > 0 ? (await db.words.bulkGet(ids)).filter((word): word is Word => Boolean(word)) : []
    return { words }
  }
  if (scope.kind === 'deck') {
    const targetDeck = scope.deckId ?? deckId
    const words = await db.words
      .where('[deckId+order]')
      .between([targetDeck, -Infinity], [targetDeck, Infinity])
      .toArray()
    return { words }
  }
  if (scope.kind === 'word' || scope.kind === 'meanings') {
    const word = await db.words.get(scope.wordId)
    return { words: word ? [word] : [] }
  }
  if (scope.kind === 'meaning') {
    const word = await db.words.get(scope.wordId)
    if (!word) return { words: [] }
    const index = Number(scope.meaningId.split('#M')[1])
    const meaningFilter =
      Number.isInteger(index) && index >= 1
        ? { wordId: scope.wordId, meaningIndex: index, meaningId: scope.meaningId }
        : undefined
    return { words: [word], meaningFilter }
  }
  if (scope.kind === 'prefix' || scope.kind === 'range') {
    // 按 headwordLower 索引前缀取（索引顺序即字母序）；只取指定 deck
    const prefix = String(scope.prefix ?? '').toLowerCase()
    const words = await db.words
      .where('headwordLower')
      .startsWith(prefix)
      .filter((word) => word.deckId === scope.deckId)
      .toArray()
    words.sort((a, b) => (a.headwordLower < b.headwordLower ? -1 : a.headwordLower > b.headwordLower ? 1 : 0))
    return { words }
  }
  // words / manual
  const ids = [...new Set(scope.wordIds)]
  const words = ids.length > 0 ? (await db.words.bulkGet(ids)).filter((word): word is Word => Boolean(word)) : []
  return { words }
}

/**
 * 按范围取候选词 → 应用排除条件 → 返回**分页**目标（task-84）。
 * - scope：today / deck（任意 deckId）/ word / meaning / words(自定义) / prefix / range(按 headwordLower 字母序)；
 * - kind='semantics'：只返回 ≥2 个含义的词；onlyMissing/excludeExisting = 该词无已应用 coreSenses/meaningMap；
 * - 单次最多 `TARGET_PAGE_MAX`(500) 个；返回 `{targets,total,truncated}`。
 */
export async function selectTargetPage(
  scope: TargetScope,
  kind: ContentKind,
  filters: FilterSet = {},
  page: TargetPageOptions = {},
): Promise<TargetPage> {
  const db = getDb()
  const settings = await getSettings()
  const deckId = settings['data.selectedDeckId']
  const { words: candidates, meaningFilter } = await collectScopeWords(scope, deckId)

  const mode = filters.mode ?? 'missing'
  const forceGenerate = mode !== 'missing'
  const excludeExisting = forceGenerate ? false : (filters.excludeExisting ?? true)
  const excludePending = forceGenerate ? false : (filters.excludePending ?? true)
  const excludeRejected = mode === 'replace' ? false : (filters.excludeRejected ?? true)
  const missingOnly = forceGenerate ? false : (filters.missingOnly ?? true)

  const targets: Target[] = []
  const scopeMeaningIndexes = scope.kind === 'meanings' ? [...new Set(scope.meaningIndexes)] : null
  for (const word of candidates) {
    // task-84：本义链只对多含义词生成（单含义词可自映射，不生成）
    if (kind === 'semantics' && word.meanings.length < 2) continue
    const fallbackIndex = meaningFilter?.wordId === word.id ? meaningFilter.meaningIndex : undefined
    const indexes = kind === 'semantics'
      ? [undefined]
      : scopeMeaningIndexes ?? (fallbackIndex != null ? [fallbackIndex] : [undefined])
    for (const index of indexes) {
      if (index != null && (index < 1 || index > word.meanings.length)) continue
      const meaningId = index != null ? meaningIdOf(word.id, index) : undefined
      let existing = existingCount(word, kind, index, meaningId)
      if (kind === 'semantics') {
        const items = await db.packItems.where('wordId').equals(word.id).toArray()
        const hasSemantics = items.some(
          (item) =>
            item.status === 'applied' &&
            ((item.payload.coreSenses ?? []).length > 0 || (item.payload.meaningMap ?? []).length > 0),
        )
        existing = hasSemantics ? 1 : 0
      }
      if ((excludeExisting && existing > 0) || (missingOnly && existing > 0)) continue
      if (excludePending && (await hasPendingItem(word.id, kind, index))) continue
      if (excludeRejected && (await isRejected(word, kind, index))) continue
      const target: Target = {
        wordId: word.id,
        headword: word.headword,
        headwordLower: word.headwordLower,
        deckId: word.deckId,
        meanings: word.meanings.map((meaning) => ({
          id: meaning.id,
          ...(meaning.pos ? { pos: meaning.pos } : {}),
          cn: meaning.cn,
        })),
        existing: {
          examples: existingCount(word, 'examples', index, meaningId),
          phrases: existingCount(word, 'phrases', index, meaningId),
          mnemonics: existingCount(word, 'mnemonics', index, meaningId),
        },
      }
      if (index != null && meaningId) {
        target.meaningIndex = index
        target.meaningId = meaningId
      }
      targets.push(target)
    }
  }
  const total = targets.length
  const offset = Math.max(0, Math.floor(page.offset ?? 0))
  const limit = Math.max(1, Math.min(TARGET_PAGE_MAX, Math.floor(page.limit ?? TARGET_PAGE_MAX)))
  const sliced = targets.slice(offset, offset + limit)
  return { targets: sliced, total, truncated: offset + sliced.length < total }
}

/** 兼容旧调用：返回目标数组（deck scope 的 offset/limit 继续生效；单页最多 500） */
export async function selectTargets(
  scope: TargetScope,
  kind: ContentKind,
  filters: FilterSet = {},
): Promise<Target[]> {
  const pageOptions: TargetPageOptions =
    scope.kind === 'deck'
      ? { offset: scope.offset ?? 0, limit: scope.limit ?? TARGET_PAGE_MAX }
      : { offset: 0, limit: TARGET_PAGE_MAX }
  return (await selectTargetPage(scope, kind, filters, pageOptions)).targets
}

/** AI 生成入口（分页版）：仅返回「缺该类内容且未被拒绝/已有待审」的目标 */
export async function pendingGenerationTargetsPage(
  scope: TargetScope,
  kind: ContentKind,
  filters: FilterSet = {},
  page: TargetPageOptions = {},
): Promise<TargetPage> {
  return selectTargetPage(scope, kind, { excludeExisting: true, missingOnly: true, ...filters }, page)
}

/** AI 生成入口（兼容旧数组返回）；deck scope 的 offset/limit 继续生效 */
export async function pendingGenerationTargets(
  scope: TargetScope,
  kind: ContentKind,
  filters: FilterSet = {},
): Promise<Target[]> {
  const pageOptions: TargetPageOptions =
    scope.kind === 'deck'
      ? { offset: scope.offset ?? 0, limit: scope.limit ?? TARGET_PAGE_MAX }
      : { offset: 0, limit: TARGET_PAGE_MAX }
  return (await pendingGenerationTargetsPage(scope, kind, filters, pageOptions)).targets
}

// ============ 拒绝记忆 / 重放 ============

/**
 * 直接拒绝一条「AI 生成但未入库」的内容（task-71 UI 用）：只写拒绝记忆，不建 pack。
 * 返回写入的拒绝记录数（该条目包含的内容条数）。
 */
export async function rejectGeneratedItem(item: PackItemV1): Promise<number> {
  const db = getDb()
  const normalized = normalizePackItem(item)
  if (!normalized) return 0
  const lower = normalizeHeadword(normalized.headwordLower || normalized.headword)
  const now = Date.now()
  const rows = itemContents(normalized).map<ContentRejectRecord>((content) => ({
    id: `${content.kind}:${lower}:${normalized.meaningIndex ?? 0}:${content.hash}`,
    kind: content.kind,
    headwordLower: lower,
    ...(normalized.meaningIndex != null ? { meaningIndex: normalized.meaningIndex } : {}),
    hash: content.hash,
    rejectedAt: now,
  }))
  if (rows.length > 0) await db.contentRejects.bulkPut(rows)
  return rows.length
}


export async function clearRejects(kind?: ContentKind): Promise<number> {
  const db = getDb()
  const rows = kind
    ? await db.contentRejects.where('kind').equals(kind).toArray()
    : await db.contentRejects.toArray()
  await db.contentRejects.bulkDelete(rows.map((row) => row.id))
  return rows.length
}

/**
 * builtin 重种后重放已应用内容（按 applied 条目重新「只补缺」，幂等）。
 * 由 `ensureBuiltinDecks()` 在真正写入词表后调用；单个条目失败不阻塞。
 */
export async function reapplyAppliedPacks(): Promise<{ packs: number; items: number }> {
  const db = getDb()
  const applied = await db.packItems.where('status').equals('applied').toArray()
  const packIds = new Set<string>()
  let items = 0
  await db.transaction('rw', [db.words, db.packItems, db.contentRejects], async () => {
    for (const item of applied) {
      if (!item.wordId) continue
      const word = await db.words.get(item.wordId)
      if (!word) continue // 用户删除了该词 → 不复活
      const rejected = await rejectedHashesFor(item.headwordLower)
      const result = mergeItemIntoWord(word, item.payload, rejected, item.meaningIndex)
      if (!result.changed) continue
      await db.words.put(result.word)
      await db.packItems.update(item.id, { appliedAt: Date.now(), appliedContent: result.added })
      packIds.add(item.packId)
      items += 1
    }
  })
  return { packs: packIds.size, items }
}

export { LIMITS }

/**
 * task-107：生成模式「覆盖」应用前清理目标词已应用的同类内容。
 * - examples/phrases/mnemonics：清空 Word 对应列（含义级 examples 一并清）；
 * - semantics：删除目标词的语义 packItems（v4 迁移后旧链不再参与 effective）。
 */
export async function clearContentForReplace(
  wordIds: string[],
  kinds: Array<'examples' | 'phrases' | 'mnemonics' | 'semantics'>,
): Promise<{ words: number; semanticsItems: number }> {
  const db = getDb()
  const ids = [...new Set(wordIds)].filter(Boolean)
  if (ids.length === 0 || kinds.length === 0) return { words: 0, semanticsItems: 0 }
  let semanticsItems = 0
  let words = 0
  await db.transaction('rw', [db.words, db.packItems], async () => {
    if (kinds.some((kind) => kind !== 'semantics')) {
      const rows = await db.words.bulkGet(ids)
      const updated: Word[] = []
      for (const word of rows) {
        if (!word) continue
        let changed = false
        if (kinds.includes('examples')) {
          if (word.examples.length > 0) { word.examples = []; changed = true }
          for (const meaning of word.meanings) {
            if (meaning.examples?.length) { meaning.examples = []; changed = true }
          }
        }
        if (kinds.includes('phrases') && word.phrases.length > 0) { word.phrases = []; changed = true }
        if (kinds.includes('mnemonics') && word.mnemonics.length > 0) { word.mnemonics = []; changed = true }
        if (changed) { updated.push(word); words += 1 }
      }
      if (updated.length > 0) await db.words.bulkPut(updated)
    }
    if (kinds.includes('semantics')) {
      for (const wordId of ids) {
        const items = await db.packItems.where('wordId').equals(wordId).toArray()
        const removable = items.filter(
          (item) => (item.payload.coreSenses ?? []).length > 0 || (item.payload.meaningMap ?? []).length > 0,
        )
        if (removable.length > 0) {
          await db.packItems.bulkDelete(removable.map((item) => item.id))
          semanticsItems += removable.length
        }
      }
    }
  })
  return { words, semanticsItems }
}
