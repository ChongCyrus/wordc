/**
 * 导入 / 导出（SPEC §6，AC5）。
 *
 * 三种文件：
 * - DeckFile v1（`momo-deck`）：纯词库，可公开分享，不含学习状态（§6.1）；
 * - MigrationFile v1（`momo-migration`）：词库 + 学习状态 + 设置 + 版本号 + checksum（§6.2, D22）；
 * - CSV（§6.3）：用户自己的词单（一行一词，多义用 `；` 分隔）。
 *
 * 导入流程统一为：**先校验后写库**；任何 error 级 issue → 整体不写库（ok:false）。
 * 导入结果写 `meta:import:last`，设置页展示（§2.2）。
 */

import { localDateKey, newDeckId } from '../core'
import type {
  Deck,
  DeckFile,
  ImportIssue,
  ImportReport,
  MigrationFile,
  ReviewLog,
  SettingRecord,
  Word,
  WordState,
} from '../core'
import type { DailyPlan } from './plan.types'
import { computeChecksum, migrationChecksumPayload, stableStringify } from './checksum'
import type { ChecksumAlgo } from './checksum'
import { getDb } from './db'
import { csvToWordInputs, parseCsv } from './csv'
import { ensureSingleDefaultDeck } from './decks.repo'
import { makeIssue, parseDeckFile, parseMigrationFile } from './schema'
import { applyImportedSettings, getSettings } from './settings.repo'
import type { RawWordInput } from './word-factory'

export const GENERATOR = 'wordc@0.3.14'
export const APP_VERSION = '0.3.14'

/** 迁移包导出选项 */
export interface ExportOptions {
  /** 是否包含复习日志（默认 true；最多 20000 条） */
  includeReviewLogs?: boolean
  /** 复习日志条数上限（默认 20000，§6.2） */
  maxReviewLogs?: number
}

/** 导入选项（§9.3） */
export interface ImportOptions {
  strategy?: 'replace' | 'merge' | 'keepNewer'
  /** checksum 不符仍导入（UI「仍要导入（风险）」按钮） */
  force?: boolean
}

/**
 * 迁移包 v2（formatVersion 保持 1；只加可选字段）：
 * - `data.plans?`：只带导出当天的今日计划（≤1–2 条，跨设备续学）；
 * - `counts.plans?`：旧文件缺省 0；
 * - `meta.checksumAlgo`：checksum 算法标注（§6.2）。
 */
export type MigrationFileWithMeta = MigrationFile & {
  counts: MigrationFile['counts'] & { plans?: number }
  data: MigrationFile['data'] & { plans?: DailyPlan[] }
  meta?: { checksumAlgo?: ChecksumAlgo }
}

const EMPTY_COUNTS: ImportReport['counts'] = {
  decks: 0,
  words: 0,
  states: 0,
  reviewLogs: 0,
  skipped: 0,
}

function makeReport(
  kind: ImportReport['kind'],
  issues: ImportIssue[],
  counts: Partial<ImportReport['counts']>,
  durationMs: number,
): ImportReport {
  return {
    ok: !issues.some((issue) => issue.level === 'error'),
    kind,
    counts: { ...EMPTY_COUNTS, ...counts },
    issues,
    durationMs,
  }
}

/** 统一读入文本（string 或 File/Blob） */
async function readInput(input: string | File): Promise<string> {
  if (typeof input === 'string') return input
  if (input && typeof (input as File).text === 'function') return (input as File).text()
  throw new Error('无法读取文件内容')
}

async function parseJsonText(text: string): Promise<{ ok: true; value: unknown } | { ok: false; issues: ImportIssue[] }> {
  const trimmed = text.replace(/^\uFEFF/, '').trim()
  if (!trimmed) return { ok: false, issues: [makeIssue('error', 'E_FORMAT', '文件是空的')] }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown }
  } catch (error) {
    return {
      ok: false,
      issues: [
        makeIssue('error', 'E_FORMAT', `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`),
      ],
    }
  }
}

async function writeLastImport(report: ImportReport): Promise<void> {
  try {
    const db = getDb()
    await db.meta.put({
      key: 'import:last',
      value: { at: Date.now(), kind: report.kind, report },
      updatedAt: Date.now(),
    })
  } catch {
    // 记录上次导入失败不该影响主流程
  }
}

/** 分批写词条/状态（手机端 bulkPut 500 条更稳，§6.5） */
const CHUNK = 500
async function bulkPutChunked<T>(table: { bulkPut: (items: T[]) => Promise<unknown> }, items: T[]): Promise<void> {
  for (let i = 0; i < items.length; i += CHUNK) {
    await table.bulkPut(items.slice(i, i + CHUNK))
  }
}

function uniqueDeckName(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})`
    if (!existing.has(candidate)) return candidate
  }
  return `${base} ${Date.now()}`
}

/** 词库文件名（UI 下载用）：非法字符替换为 _ */
export function deckFileName(deck: Pick<Deck, 'name'>): string {
  const safe = deck.name.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 80)
  return `${safe || 'deck'}.deck.json`
}

/** 迁移包文件名（UI 下载用） */
export function migrationFileName(now: number = Date.now()): string {
  return `momo-backup-${localDateKey(now)}.migration.json`
}

// ============ 导出 ============

/** 构造纯词库文件（DeckFile v1） */
export async function buildDeckFile(deckId: string, now: number = Date.now()): Promise<DeckFile> {
  const db = getDb()
  const deck = await db.decks.get(deckId)
  if (!deck) throw new Error('词库不存在')
  const words = await db.words
    .where('[deckId+order]')
    .between([deckId, -Infinity], [deckId, Infinity])
    .toArray()
  const meta: DeckFile['meta'] = { wordCount: words.length }
  if (deck.license) {
    meta.license = deck.license
    if (deck.source === 'builtin') meta.copyrightNotice = deck.license
  }
  return {
    format: 'momo-deck',
    formatVersion: 1,
    exportedAt: now,
    generator: GENERATOR,
    deck: { ...deck, wordCount: words.length, updatedAt: now },
    words,
    meta,
  }
}

/** 导出纯词库（不含学习状态，可公开分享） */
export async function exportDeck(deckId: string): Promise<Blob> {
  const file = await buildDeckFile(deckId)
  return new Blob([stableStringify(file)], { type: 'application/json' })
}

/** 构造可迁移包（含 states/settings，checksum） */
export async function buildMigrationFile(opts: ExportOptions = {}): Promise<MigrationFileWithMeta> {
  const db = getDb()
  const now = Date.now()
  const [decks, words, states, settingRows] = await Promise.all([
    db.decks.toArray(),
    db.words.toArray(),
    db.states.toArray(),
    db.settings.toArray(),
  ])
  let reviewLogs: ReviewLog[] = []
  if (opts.includeReviewLogs !== false) {
    const max = Math.max(0, Math.floor(opts.maxReviewLogs ?? 20000))
    if (max > 0) {
      const tail = await db.reviewLogs.orderBy('reviewedAt').reverse().limit(max).toArray()
      reviewLogs = tail.sort((a, b) => a.reviewedAt - b.reviewedAt)
    }
  }
  // 隐私（D23/task-70）：MaiMemo token 与 AI Key 永不进迁移包
  const settings: SettingRecord[] = settingRows.filter(
    (record) => record.key !== 'data.maimemoToken' && record.key !== 'ai.apiKey',
  )
  // v2：只带导出当天的今日计划（最多 2 条：一天内切换词库的情况）
  const todayKey = localDateKey(now)
  const plans = await db.plans.where('date').equals(todayKey).limit(2).toArray()
  // v3（task-69）：内容包三表随迁移包导出（备份/换机保留 AI 生成内容与拒绝记忆）
  const [contentPacks, packItems, contentRejects] = await Promise.all([
    db.packs.toArray(),
    db.packItems.toArray(),
    db.contentRejects.toArray(),
  ])
  const data: MigrationFileWithMeta['data'] = {
    decks,
    words,
    states,
    reviewLogs,
    settings,
    ...(plans.length > 0 ? { plans } : {}),
    ...(contentPacks.length > 0 ? { contentPacks } : {}),
    ...(packItems.length > 0 ? { packItems } : {}),
    ...(contentRejects.length > 0 ? { contentRejects } : {}),
  }
  const payload = {
    format: 'momo-migration' as const,
    formatVersion: 1 as const,
    dataVersion: 1 as const,
    data,
  }
  const checksum = await computeChecksum(migrationChecksumPayload(payload))
  return {
    format: 'momo-migration',
    formatVersion: 1,
    exportedAt: now,
    generator: GENERATOR,
    appVersion: APP_VERSION,
    dataVersion: 1,
    counts: {
      decks: decks.length,
      words: words.length,
      states: states.length,
      reviewLogs: reviewLogs.length,
      ...(plans.length > 0 ? { plans: plans.length } : {}),
    },
    data,
    checksum: checksum.hex,
    meta: { checksumAlgo: checksum.algo },
  }
}

/** 导出可迁移包（备份/跨设备迁移） */
export async function exportMigration(opts: ExportOptions = {}): Promise<Blob> {
  const file = await buildMigrationFile(opts)
  return new Blob([stableStringify(file)], { type: 'application/json' })
}

// ============ 导入：纯词库 ============

/** 导入 DeckFile（strategy 默认 replace：同 id 清空该库 words/states 再写） */
export async function importDeckFile(
  input: string | File,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const startedAt = Date.now()
  const strategy = opts.strategy ?? 'replace'
  const text = await readInput(input)
  const json = await parseJsonText(text)
  if (!json.ok) {
    const report = makeReport('deck', json.issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }
  const parsed = parseDeckFile(json.value)
  if (!parsed.ok) {
    const report = makeReport('deck', parsed.issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }
  const issues = parsed.issues
  if (issues.some((issue) => issue.level === 'error')) {
    const report = makeReport('deck', issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }

  const db = getDb()
  const { deck, words } = parsed.value
  const now = Date.now()
  const existingDefaultId =
    (await db.decks.toArray()).find((item) => item.isDefault)?.id ?? null
  await db.transaction('rw', db.decks, db.words, db.states, db.settings, async () => {
    const existingDeck = await db.decks.get(deck.id)
    if (strategy === 'replace') {
      await db.words.where('deckId').equals(deck.id).delete()
      await db.states.where('deckId').equals(deck.id).delete()
    }
    const nextDeck: Deck = {
      ...deck,
      createdAt: existingDeck?.createdAt ?? deck.createdAt ?? now,
      updatedAt: now,
    }
    await db.decks.put(nextDeck)
    await bulkPutChunked(db.words, words)
    // 没有任何选中词库时，自动选中导入的词库
    const selected = await db.settings.get('data.selectedDeckId')
    const selectedDeck = selected ? await db.decks.get(selected.value as string) : undefined
    if (!selectedDeck) {
      await db.settings.put({ key: 'data.selectedDeckId', value: deck.id, updatedAt: now })
    }
    // 默认词库全局唯一（QA-01：导入文件不能造出第二个 isDefault）
    await ensureSingleDefaultDeck(existingDefaultId)
  })

  const report = makeReport(
    'deck',
    issues,
    { decks: 1, words: words.length, skipped: issues.filter((i) => i.code === 'W_SKIPPED').length },
    Date.now() - startedAt,
  )
  await writeLastImport(report)
  return report
}

// ============ 导入：CSV ============

/** 导入 CSV 词单（新建词库；同 headword 多行合并） */
export async function importCsv(input: string | File, deckName?: string): Promise<ImportReport> {
  const startedAt = Date.now()
  const db = getDb()
  const now = Date.now()
  const text = await readInput(input)
  const parsed = parseCsv(text)
  const converted = csvToWordInputs(parsed)
  const issues = converted.issues
  if (issues.some((issue) => issue.level === 'error') || converted.words.length === 0) {
    const report = makeReport('csv', issues, { skipped: parsed.rows.length }, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }

  const { buildWord } = await import('./word-factory')
  const existingDecks = await db.decks.toArray()
  const name = uniqueDeckName(
    (deckName ?? '导入的词库').trim() || '导入的词库',
    new Set(existingDecks.map((deck) => deck.name)),
  )
  let deckId = newDeckId(name, now)
  while (await db.decks.get(deckId)) deckId = `${deckId}-${Math.random().toString(36).slice(2, 5)}`
  const words: Word[] = converted.words.map((raw: RawWordInput, index) =>
    buildWord(raw, deckId, { order: index + 1, createdAt: now }),
  )
  const deck: Deck = {
    id: deckId,
    name,
    source: 'imported',
    wordCount: words.length,
    version: 1,
    createdAt: now,
    updatedAt: now,
  }
  await db.transaction('rw', db.decks, db.words, db.settings, async () => {
    await db.decks.put(deck)
    await bulkPutChunked(db.words, words)
    const selected = await db.settings.get('data.selectedDeckId')
    if (!selected) {
      await db.settings.put({ key: 'data.selectedDeckId', value: deckId, updatedAt: now })
    }
  })
  const report = makeReport(
    'csv',
    issues,
    { decks: 1, words: words.length, skipped: parsed.rows.length - converted.words.length },
    Date.now() - startedAt,
  )
  await writeLastImport(report)
  return report
}

// ============ 导入：可迁移包 ============

/** 合并两条学习状态（§6.2 merge：lastReviewedAt 较新者为准，clicks/encounters 取 max） */
function mergeState(local: WordState, imported: WordState): WordState {
  const localAt = local.lastReviewedAt ?? -Infinity
  const importedAt = imported.lastReviewedAt ?? -Infinity
  const base = importedAt > localAt ? imported : local
  const other = base === imported ? local : imported
  const meaningStats: WordState['meaningStats'] = { ...other.meaningStats }
  for (const [meaningId, stat] of Object.entries(base.meaningStats)) {
    const old = meaningStats[meaningId]
    meaningStats[meaningId] = old
      ? {
          clicks: Math.max(old.clicks, stat.clicks),
          encounters: Math.max(old.encounters, stat.encounters),
        }
      : { ...stat }
  }
  return {
    ...base,
    meaningStats,
    updatedAt: Math.max(local.updatedAt ?? 0, imported.updatedAt ?? 0),
  }
}

/** 导入可迁移包（replace / merge / keepNewer） */
export async function importMigration(
  input: string | File,
  opts: ImportOptions = {},
): Promise<ImportReport> {
  const startedAt = Date.now()
  const strategy = opts.strategy ?? 'replace'
  const text = await readInput(input)
  const json = await parseJsonText(text)
  if (!json.ok) {
    const report = makeReport('migration', json.issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }
  const raw = json.value as Record<string, unknown>
  const issues: ImportIssue[] = []

  // 0) format / version 先判（SPEC §6.2 顺序：format/version → checksum → 字段校验）
  if (raw.format !== 'momo-migration') {
    const report = makeReport(
      'migration',
      [makeIssue('error', 'E_FORMAT', '不是可迁移包（format 应为 momo-migration）', { path: 'format' })],
      {},
      Date.now() - startedAt,
    )
    await writeLastImport(report)
    return report
  }
  if (raw.formatVersion !== 1 || raw.dataVersion !== 1) {
    const report = makeReport(
      'migration',
      [makeIssue('error', 'E_VERSION', '可迁移包版本不支持，请升级 App 后重试', { path: 'formatVersion' })],
      {},
      Date.now() - startedAt,
    )
    await writeLastImport(report)
    return report
  }

  // 1) checksum 校验
  const checksumPayload = migrationChecksumPayload({
    format: String(raw.format ?? ''),
    formatVersion: Number(raw.formatVersion ?? 0),
    dataVersion: Number(raw.dataVersion ?? 0),
    data: raw.data,
  })
  const expectedChecksum = typeof raw.checksum === 'string' ? raw.checksum : ''
  const { verifyChecksum } = await import('./checksum')
  const checksumResult = await verifyChecksum(checksumPayload, expectedChecksum)
  if (!checksumResult.ok) {
    if (!opts.force) {
      const report = makeReport(
        'migration',
        [
          makeIssue('error', 'E_CHECKSUM', '校验和不匹配，文件可能被修改过（仍要导入请选择「仍要导入」）', {
            path: 'checksum',
          }),
        ],
        {},
        Date.now() - startedAt,
      )
      await writeLastImport(report)
      return report
    }
    issues.push(
      makeIssue('warning', 'E_CHECKSUM', '校验和不匹配，已按「强制导入」继续（数据可能不完整）', {
        path: 'checksum',
      }),
    )
  } else if (checksumResult.matchedAlgo === 'fnv1a64') {
    issues.push(
      makeIssue('warning', 'W_SKIPPED', '该备份文件使用降级校验算法（FNV-1a 64），已通过校验', {
        path: 'checksum',
      }),
    )
  }

  // 2) 字段校验 + 规范化
  const parsed = parseMigrationFile(raw)
  if (!parsed.ok) {
    const report = makeReport('migration', [...issues, ...parsed.issues], {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }
  const file = parsed.value
  issues.push(...file.issues)
  if (issues.some((issue) => issue.level === 'error')) {
    const report = makeReport('migration', issues, {}, Date.now() - startedAt)
    await writeLastImport(report)
    return report
  }

  const db = getDb()
  const now = Date.now()
  const deckIds = file.decks.map((deck) => deck.id)
  const importedStates = file.states
  const existingDefaultId =
    (await db.decks.toArray()).find((deck) => deck.isDefault)?.id ?? null

  await db.transaction(
    'rw',
    [db.decks, db.words, db.states, db.reviewLogs, db.settings, db.meta, db.plans, db.packs, db.packItems, db.contentRejects],
    async () => {
      if (strategy === 'replace') {
        // 同 deckId 先清空该库的 words/states（§6.2）
        for (const deckId of deckIds) {
          await db.words.where('deckId').equals(deckId).delete()
          await db.states.where('deckId').equals(deckId).delete()
        }
        await bulkPutChunked(db.decks, file.decks)
        await bulkPutChunked(db.words, file.words)
        await bulkPutChunked(db.states, importedStates)
        // 复习日志：追加（去掉自增 id，避免主键冲突）
        const logs = file.reviewLogs.map((log) => {
          const copy: ReviewLog = { ...log }
          delete copy.id
          return copy
        })
        await bulkPutChunked(
          {
            async bulkPut(items: ReviewLog[]) {
              await db.reviewLogs.bulkAdd(items)
            },
          },
          logs,
        )
        // 设置：整体覆盖，但保留本机 token（隐私，D23）
        const tokenRow = await db.settings.get('data.maimemoToken')
        await db.settings.clear()
        if (tokenRow) await db.settings.put(tokenRow)
        await applyImportedSettings(file.settings)
      } else if (strategy === 'merge') {
        await bulkPutChunked(db.decks, file.decks)
        await bulkPutChunked(db.words, file.words)
        const existing = await db.states.bulkGet(importedStates.map((state) => state.wordId))
        const merged: WordState[] = importedStates.map((state, index) => {
          const local = existing[index]
          return local ? mergeState(local, state) : state
        })
        await bulkPutChunked(db.states, merged)
        // 合并模式不导入复习日志（避免重复计数）；设置只补缺省项
        const localSettings = await db.settings.toArray()
        const localKeys = new Set(localSettings.map((record) => record.key))
        const missing = file.settings.filter((record) => !localKeys.has(record.key))
        await applyImportedSettings(missing)
        issues.push(
          makeIssue('warning', 'W_SKIPPED', '合并模式未导入复习日志（避免重复计数），学习状态已按时间合并', {
            path: 'data.reviewLogs',
          }),
        )
      } else {
        // keepNewer：仅导入包里的 state 更新时才覆盖本地 state
        await bulkPutChunked(db.decks, file.decks)
        await bulkPutChunked(db.words, file.words)
        const existing = await db.states.bulkGet(importedStates.map((state) => state.wordId))
        const kept: WordState[] = []
        let overwritten = 0
        importedStates.forEach((state, index) => {
          const local = existing[index]
          if (!local) {
            kept.push(state)
            return
          }
          const localAt = local.lastReviewedAt ?? -Infinity
          const importedAt = state.lastReviewedAt ?? -Infinity
          if (importedAt > localAt) {
            overwritten += 1
            kept.push(mergeState(local, state))
          }
        })
        await bulkPutChunked(db.states, kept)
        const localSettings = await db.settings.toArray()
        const localKeys = new Set(localSettings.map((record) => record.key))
        await applyImportedSettings(file.settings.filter((record) => !localKeys.has(record.key)))
        issues.push(
          makeIssue(
            'warning',
            'W_SKIPPED',
            `keepNewer：仅覆盖了 ${overwritten} 条较新的学习状态，其余保留本机`,
            { path: 'data.states' },
          ),
        )
      }

      // v2：迁移包里的今日 plan（只恢复同一天；旧包/跨天忽略）
      const filePlans = parsed.value.plans ?? []
      if (filePlans.length > 0) {
        if (strategy === 'replace') {
          const today = localDateKey(now)
          const accepted = filePlans.filter((plan) => plan.date === today)
          for (const plan of accepted) await db.plans.put(plan)
          const ignored = filePlans.length - accepted.length
          if (ignored > 0) {
            issues.push(
              makeIssue(
                'warning',
                'W_SKIPPED',
                `有 ${ignored} 条非今日的学习计划未恢复（跨天计划无意义，仅保留本机历史）`,
                { path: 'data.plans' },
              ),
            )
          }
        } else if (filePlans.length > 0) {
          issues.push(
            makeIssue(
              'warning',
              'W_SKIPPED',
              '合并/保留较新模式下未导入包内今日计划（队列与设备上下文相关，保留本机）',
              { path: 'data.plans' },
            ),
          )
        }
      }
      // v3（task-69）：内容包三表（备份/换机保留 AI 生成内容与拒绝记忆）
      const filePacks = parsed.value.contentPacks ?? []
      const filePackItems = parsed.value.packItems ?? []
      const fileRejects = parsed.value.contentRejects ?? []
      if (strategy === 'replace') {
        await db.packs.clear()
        await db.packItems.clear()
        await db.contentRejects.clear()
        if (filePacks.length > 0) await bulkPutChunked(db.packs, filePacks)
        if (filePackItems.length > 0) await bulkPutChunked(db.packItems, filePackItems)
        if (fileRejects.length > 0) await bulkPutChunked(db.contentRejects, fileRejects)
      } else {
        // merge / keepNewer：只补本机没有的 pack / packItem / 拒绝记录（避免覆盖本机审核状态）
        const existingPackIds = new Set((await db.packs.toArray()).map((pack) => pack.id))
        const existingItemIds = new Set((await db.packItems.toArray()).map((item) => item.id))
        const existingRejectIds = new Set((await db.contentRejects.toArray()).map((row) => row.id))
        const newPacks = filePacks.filter((pack) => !existingPackIds.has(pack.id))
        const newItems = filePackItems.filter((item) => !existingItemIds.has(item.id))
        const newRejects = fileRejects.filter((row) => !existingRejectIds.has(row.id))
        if (newPacks.length > 0) await bulkPutChunked(db.packs, newPacks)
        if (newItems.length > 0) await bulkPutChunked(db.packItems, newItems)
        if (newRejects.length > 0) await bulkPutChunked(db.contentRejects, newRejects)
        if (filePacks.length > 0) {
          issues.push(
            makeIssue(
              'warning',
              'W_SKIPPED',
              `合并/保留较新模式：只补入 ${newPacks.length} 个本机没有的内容包，本机审核状态保持不变`,
              { path: 'data.contentPacks' },
            ),
          )
        }
      }

      // 默认词库全局唯一（QA-01）：已有默认词库优先，其次包内第一个默认，否则第一个词库
      await ensureSingleDefaultDeck(existingDefaultId)
      // 选中词库兜底：当前选中的词库不在导入包里就切到默认/第一个
      const selected = await db.settings.get('data.selectedDeckId')
      const selectedId = selected?.value as string | undefined
      const decksNow = await db.decks.toArray()
      if (!selectedId || !decksNow.some((deck) => deck.id === selectedId)) {
        if (decksNow.length > 0) {
          const fallback = decksNow.find((deck) => deck.isDefault) ?? decksNow[0]!
          await db.settings.put({ key: 'data.selectedDeckId', value: fallback.id, updatedAt: now })
        }
      }
    },
  )

  const report = makeReport(
    'migration',
    issues,
    {
      decks: file.decks.length,
      words: file.words.length,
      states: file.states.length,
      reviewLogs: strategy === 'replace' ? file.reviewLogs.length : 0,
      skipped: issues.filter((issue) => issue.code === 'W_SKIPPED').length,
    },
    Date.now() - startedAt,
  )
  await writeLastImport(report)
  return report
}

// ============ 清空数据 ============

/**
 * 清空全部数据（危险操作，UI 需二次确认）。
 * - 清 decks/words/states/reviewLogs/settings/meta；
 * - `keepToken=true` 时保留 `data.maimemoToken`；`keepAiKey=true` 时保留 `ai.apiKey`（默认一起清，D23/task-70）；
 * - v3：同时清空内容包三表；清空后内置词库需要重新 `ensureBuiltinDecks()`。
 */
export async function clearAllData(
  opts: { keepToken?: boolean; keepAiKey?: boolean } = {},
): Promise<void> {
  const db = getDb()
  const tokenRow = opts.keepToken ? await db.settings.get('data.maimemoToken') : undefined
  const aiKeyRow = opts.keepAiKey ? await db.settings.get('ai.apiKey') : undefined
  await db.transaction(
    'rw',
    [db.decks, db.words, db.states, db.reviewLogs, db.settings, db.meta, db.plans, db.packs, db.packItems, db.contentRejects],
    async () => {
      await db.packs.clear()
      await db.packItems.clear()
      await db.contentRejects.clear()
      await db.plans.clear()
      await db.decks.clear()
      await db.words.clear()
      await db.states.clear()
      await db.reviewLogs.clear()
      await db.settings.clear()
      await db.meta.clear()
      if (tokenRow) await db.settings.put(tokenRow)
      if (aiKeyRow) await db.settings.put(aiKeyRow)
    },
  )
}

// ============ 杂项 ============

/** 读取上次导入报告（设置页展示，§2.2 key `import:last`） */
export async function getLastImportReport(): Promise<ImportReport | null> {
  const db = getDb()
  const row = await db.meta.get('import:last')
  const value = row?.value as { report?: ImportReport } | undefined
  return value?.report ?? null
}

/** 当前设置（导出给 UI 的便捷再导出，避免 UI 直接 import settings.repo） */
export { getSettings }
