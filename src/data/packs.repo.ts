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
  deckId?: string
  resolveAllDecks?: boolean
}

async function resolveItem(
  item: PackItemV1,
  index: number,
  opts: ResolveOptions,
): Promise<{ ok: true; resolved: ResolvedItem } | { ok: false; skip: SkipRecord }> {
  const db = getDb()
  const lower = normalizeHeadword(item.headwordLower || item.headword)
  const settings = await getSettings()
  const deckId = opts.deckId ?? settings['data.selectedDeckId']
  const candidates = await db.words.where('headwordLower').equals(lower).toArray()
  const inDeck = opts.resolveAllDecks ? candidates : candidates.filter((word) => word.deckId === deckId)
  const word = inDeck[0] ?? (opts.resolveAllDecks ? candidates[0] : undefined)
  if (!word) {
    return {
      ok: false,
      skip: { headwordLower: lower, meaningIndex: item.meaningIndex, reason: 'unknown-word', detail: item.headword },
    }
  }
  if (item.meaningIndex != null) {
    if (!word.meanings[item.meaningIndex - 1]) {
      return {
        ok: false,
        skip: {
          headwordLower: lower,
          meaningIndex: item.meaningIndex,
          reason: 'unknown-meaning',
          detail: `${word.headword} 只有 ${word.meanings.length} 个含义`,
        },
      }
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

/** 预览：只解析目标（不写库），返回 matched/skipped 报告 */
export async function previewPack(
  file: PackFileV1,
  opts: ResolveOptions = {},
): Promise<PackPreview> {
  const matched: ResolvedItem[] = []
  const skipped: SkipRecord[] = []
  for (const [index, item] of file.items.entries()) {
    const result = await resolveItem(item, index, opts)
    if (result.ok) matched.push(result.resolved)
    else skipped.push(result.skip)
  }
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
  const preview = await previewPack(file, opts)
  const existingItems = await db.packItems
    .where('status')
    .anyOf(['pending', 'approved', 'applied'])
    .toArray()
  const existingHashes = new Set(existingItems.flatMap((item) => item.contentHashes))
  const skipped: SkipRecord[] = [...preview.skipped]
  const matched: ResolvedItem[] = []
  const now = Date.now()
  const packId = newPackId(now)
  const itemRecords: PackItemRecord[] = []
  let seq = 0

  for (const resolved of preview.matched) {
    const hashes = itemContentHashes(resolved.item)
    const rejectedHashes = await rejectedHashesFor(resolved.item.headwordLower || normalizeHeadword(resolved.item.headword))
    // 只有「全部内容都已存在」才算重复整条跳过；部分重复允许（apply 时逐条只补缺/去重）
    if (hashes.length > 0 && hashes.every((hash) => existingHashes.has(hash))) {
      skipped.push({
        headwordLower: normalizeHeadword(resolved.item.headwordLower || resolved.item.headword),
        meaningIndex: resolved.item.meaningIndex,
        reason: 'duplicate',
        detail: '已存在相同内容（pending/approved/applied）',
      })
      continue
    }
    if (hashes.length > 0 && hashes.every((hash) => rejectedHashes.has(hash))) {
      skipped.push({
        headwordLower: normalizeHeadword(resolved.item.headwordLower || resolved.item.headword),
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
      headwordLower: normalizeHeadword(resolved.item.headwordLower || resolved.item.headword),
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

  if (itemRecords.length === 0) {
    // 全部被跳过（未知词/重复/已拒绝）→ 不建空包，只返回预览报告
    return {
      ok: true,
      preview: { matched, skipped, counts: { total: file.items.length, matched: 0, skipped: skipped.length } },
      issues: parsed.issues,
    }
  }
  const counts = emptyCounts()
  counts.items = itemRecords.length
  counts.pending = itemRecords.length
  counts.skipped = skipped.length
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
    status: itemRecords.length > 0 ? 'reviewing' : 'empty',
    counts,
    createdAt: now,
    updatedAt: now,
  }
  await db.transaction('rw', [db.packs, db.packItems], async () => {
    await db.packs.put(pack)
    if (itemRecords.length > 0) await db.packItems.bulkPut(itemRecords)
  })
  return {
    ok: true,
    packId,
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
  await db.transaction('rw', [db.packItems, db.packs], async () => {
    for (const id of itemIds) {
      const item = await db.packItems.get(id)
      if (!item || item.packId !== packId || (item.status !== 'pending' && item.status !== 'rejected')) continue
      await db.packItems.update(id, { status: 'approved' })
      changed += 1
    }
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
export async function applyApproved(packId: string): Promise<ApplyResult> {
  const db = getDb()
  const now = Date.now()
  return db.transaction(
    'rw',
    [db.words, db.packItems, db.packs, db.contentRejects],
    async () => {
      const items = await db.packItems.where('[packId+status]').equals([packId, 'approved']).toArray()
      let applied = 0
      let skipped = 0
      const skippedDetails: SkipRecord[] = []
      for (const item of items) {
        if (!item.wordId) {
          await db.packItems.update(item.id, { status: 'skipped', skipReason: 'unknown-word' })
          skipped += 1
          skippedDetails.push({ headwordLower: item.headwordLower, meaningIndex: item.meaningIndex, reason: 'unknown-word', itemId: item.id })
          continue
        }
        const word = await db.words.get(item.wordId)
        if (!word) {
          await db.packItems.update(item.id, { status: 'skipped', skipReason: 'unknown-word' })
          skipped += 1
          skippedDetails.push({ headwordLower: item.headwordLower, meaningIndex: item.meaningIndex, reason: 'unknown-word', itemId: item.id })
          continue
        }
        const rejected = await rejectedHashesFor(item.headwordLower)
        const payload = item.payload
        const wordContent = {
          examples: payload.examples,
          phrases: payload.phrases,
          mnemonics: payload.mnemonics,
        }
        const hasWordContent = Boolean(
          (wordContent.examples?.length ?? 0) > 0 ||
            (wordContent.phrases?.length ?? 0) > 0 ||
            (wordContent.mnemonics?.length ?? 0) > 0,
        )
        const hasSemantics = Boolean((payload.coreSenses?.length ?? 0) > 0 || (payload.meaningMap?.length ?? 0) > 0)
        // v3 语义条目（task-75）：校验映射后直接标记 applied（不写 Word；effective 查询时合并展示）
        let semanticsOk = false
        if (hasSemantics) {
          const check = validateSemanticsItem(word, payload)
          if (!check.ok) {
            await db.packItems.update(item.id, { status: 'skipped', skipReason: check.reason })
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
        const result = hasWordContent
          ? mergeItemIntoWord(word, payload, rejected, item.meaningIndex)
          : { word, changed: false, added: { examples: [], phrases: [], mnemonics: [] }, skipped: [] }
        // 内容级跳过（已有/上限/拒绝/越界）也进应用报告（UI 显示「跳过 Y 条」）
        for (const skip of result.skipped) {
          skippedDetails.push({
            headwordLower: item.headwordLower,
            meaningIndex: item.meaningIndex,
            reason: skip.reason,
            detail: skip.value,
            itemId: item.id,
          })
        }
        if (result.changed) await db.words.put(result.word)
        if (result.changed || semanticsOk) {
          await db.packItems.update(item.id, {
            status: 'applied',
            appliedAt: now,
            appliedContent: result.added,
          })
          applied += 1
        } else {
          const reason: MergeSkip['reason'] = result.skipped[0]?.reason ?? 'duplicate'
          await db.packItems.update(item.id, { status: 'skipped', skipReason: reason })
          skipped += 1
          skippedDetails.push({ headwordLower: item.headwordLower, meaningIndex: item.meaningIndex, reason, itemId: item.id })
        }
      }
      const pack = await refreshPack(packId, now)
      return { applied, skipped, packStatus: pack?.status ?? 'empty', skippedDetails }
    },
  )
}

/** 重新统计 pack 状态/计数（在事务内调用） */
async function refreshPack(packId: string, now: number): Promise<PackRecord | undefined> {
  const db = getDb()
  const pack = await db.packs.get(packId)
  if (!pack) return undefined
  const items = await db.packItems.where('packId').equals(packId).toArray()
  const counts = emptyCounts()
  counts.items = items.length
  for (const item of items) counts[item.status] += 1
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
export async function deletePack(packId: string, opts: { removeAppliedContent?: boolean } = {}): Promise<void> {
  const db = getDb()
  await db.transaction('rw', [db.packs, db.packItems, db.words], async () => {
    const items = await db.packItems.where('packId').equals(packId).toArray()
    if (opts.removeAppliedContent) {
      const applied = items.filter((item) => item.status === 'applied' && item.appliedContent && item.wordId)
      // 其它已应用条目引用的内容不删（多包可能贡献同一内容）
      const allApplied = (await db.packItems.where('status').equals('applied').toArray()).filter(
        (item) => item.packId !== packId,
      )
      const keep = new Set(allApplied.flatMap((item) => item.contentHashes))
      for (const item of applied) {
        const word = await db.words.get(item.wordId!)
        if (!word) continue
        const removed = item.appliedContent!
        const next = {
          ...word,
          examples: word.examples.filter((example) => {
            const hash = contentHash('examples', word.headwordLower, undefined, example.en)
            return !removed.examples.some((en) => normalizeEn(en) === normalizeEn(example.en)) || keep.has(hash)
          }),
          phrases: word.phrases.filter((phrase) => {
            const idx = phrase.meaningId ? Number(phrase.meaningId.split('#M')[1]) : undefined
            const hash = contentHash('phrases', word.headwordLower, idx, phrase.en)
            return !removed.phrases.some((en) => normalizeEn(en) === normalizeEn(phrase.en)) || keep.has(hash)
          }),
          mnemonics: word.mnemonics.filter((mnemonic) => {
            const key = mnemonicKey({ type: mnemonic.type, text: mnemonic.text })
            const hash = contentHash('mnemonics', word.headwordLower, undefined, key)
            return !removed.mnemonics.some((m) => mnemonicKey(m) === key) || keep.has(hash)
          }),
        }
        await db.words.put(next)
      }
    }
    await db.packItems.where('packId').equals(packId).delete()
    await db.packs.delete(packId)
  })
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
  if (scope.kind === 'word') {
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

  const excludeExisting = filters.excludeExisting ?? true
  const excludePending = filters.excludePending ?? true
  const excludeRejected = filters.excludeRejected ?? true
  const missingOnly = filters.missingOnly ?? true

  const targets: Target[] = []
  for (const word of candidates) {
    // task-84：本义链只对多含义词生成（单含义词可自映射，不生成）
    if (kind === 'semantics' && word.meanings.length < 2) continue
    const index = meaningFilter?.wordId === word.id ? meaningFilter.meaningIndex : undefined
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
    if (meaningFilter && index != null && meaningId) {
      target.meaningIndex = index
      target.meaningId = meaningId
    }
    targets.push(target)
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
