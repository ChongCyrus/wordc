#!/usr/bin/env node
/**
 * 0.17：构建内置 seed 内容库 public/seed/content.db。
 *
 * 目标：新装首启不再跑长导入，原生 contentSeed 一次事务灌入 content_kv。
 * 数据源全部在仓库：
 * - data/packs/dagang/semantics-full-5528-v4.pack.json（pack + pack-item）
 * - data/generated/root-etymology.bundle.json（word-overlay.rootEtymology）
 * - data/generated/dagang-derivation-bundle-v1.json（word-overlay.derivationMap）
 * - data/generated/core-sense-mnemonics.json（word-overlay.senseMnemonics）
 * - src/data/builtin/kaoyan-2027-dagang.deck.json（只保留可解析 wordId）
 *
 * 用法：node tools/build-content-seed.mjs [--out public/seed/content.db]
 */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
const OUT = path.resolve(ROOT, outArg >= 0 ? args[outArg + 1] : 'public/seed/content.db')
const DECK_PATH = path.join(ROOT, 'src/data/builtin/kaoyan-2027-dagang.deck.json')
const PACK_PATH = path.join(ROOT, 'data/packs/dagang/semantics-full-5528-v4.pack.json')
const ROOT_BUNDLE_PATH = path.join(ROOT, 'data/generated/root-etymology.bundle.json')
const DERIVATION_PATH = path.join(ROOT, 'data/generated/dagang-derivation-bundle-v1.json')
const MNEMONICS_PATH = path.join(ROOT, 'data/generated/core-sense-mnemonics.json')
const PACK_ID = 'dagang-semantics-full-5528-seed'
const BUILTIN_ID = 'dagang-semantics-full'
const DECK_ID = 'kaoyan-2027-dagang'
const REVISION = 1

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const lower = (value) => String(value ?? '').trim().toLowerCase()

const deck = read(DECK_PATH)
const pack = read(PACK_PATH)
const rootBundle = read(ROOT_BUNDLE_PATH)
const derivation = read(DERIVATION_PATH)
const mnemonics = read(MNEMONICS_PATH)

const wordIds = new Map()
for (const row of deck.words ?? []) {
  const term = Array.isArray(row) ? row[0] : row?.term
  const id = `${DECK_ID}:${lower(term)}`
  if (term) wordIds.set(lower(term), id)
}
if (wordIds.size === 0) throw new Error('内置 deck 未解析到任何词')

const rows = new Map() // key -> {key, kind, json, updated_at, revision, deleted}
const addRow = (key, kind, value, updatedAt) => {
  rows.set(key, { key, kind, json: JSON.stringify(value), updated_at: Number(updatedAt) || Date.now(), revision: REVISION, deleted: 0 })
}

const packCreatedAt = Number(pack.createdAt) || Date.now()
const packItems = []
let skippedItems = 0
for (const item of pack.items ?? []) {
  const headwordLower = lower(item.headwordLower || item.headword)
  const wordId = wordIds.get(headwordLower)
  if (!wordId) { skippedItems += 1; continue }
  const seq = packItems.length + 1
  const id = `${PACK_ID}:${seq}`
  const record = {
    id,
    packId: PACK_ID,
    seq,
    headword: String(item.headword ?? headwordLower),
    headwordLower,
    wordId,
    deckId: DECK_ID,
    payload: {
      headword: String(item.headword ?? headwordLower),
      headwordLower,
      coreSenses: item.coreSenses ?? [],
      meaningMap: item.meaningMap ?? [],
    },
    status: 'applied',
    contentHashes: [],
    createdAt: packCreatedAt,
    appliedAt: packCreatedAt,
  }
  packItems.push(record)
  addRow(`pack-item:${id}`, 'pack-item', record, packCreatedAt)
}

const packRecord = {
  id: PACK_ID,
  name: pack.meta?.name ?? '商业词表本义链-全量5528词',
  kind: 'semantics',
  formatVersion: 1,
  checksum: String(pack.checksum ?? ''),
  source: 'import',
  provider: pack.meta?.provider,
  promptVersion: pack.meta?.promptVersion,
  deckId: DECK_ID,
  builtinId: BUILTIN_ID,
  status: 'applied',
  counts: { items: packItems.length, pending: 0, approved: packItems.length, applied: packItems.length, rejected: 0, skipped: skippedItems },
  createdAt: packCreatedAt,
  updatedAt: packCreatedAt,
  appliedAt: packCreatedAt,
}
addRow(`pack:${PACK_ID}`, 'pack', packRecord, packCreatedAt)

// overlay 合并：rootEtymology + derivationMap + senseMnemonics（同 key 一行）
const overlays = new Map()
const ensureOverlay = (wordId) => {
  if (!wordIds.has(wordId.split(':').slice(1).join(':').toLowerCase()) && ![...wordIds.values()].includes(wordId)) return null
  if (!overlays.has(wordId)) overlays.set(wordId, {})
  return overlays.get(wordId)
}
for (const item of rootBundle.items ?? []) {
  const wordId = String(item.wordId ?? '')
  if (!wordIds.has(lower(item.headword)) || !wordId.endsWith(`:${lower(item.headword)}`)) continue
  const overlay = ensureOverlay(wordId)
  if (overlay && item.rootEtymology) overlay.rootEtymology = item.rootEtymology
}
for (const item of derivation.items ?? []) {
  const headwordLower = lower(item.headword)
  const wordId = wordIds.get(headwordLower)
  if (!wordId) continue
  const overlay = ensureOverlay(wordId)
  if (!overlay) continue
  overlay.derivationMap = {
    rootLabel: item.rootLabel,
    text: item.text,
    mermaid: item.mermaid,
    lines: item.lines ?? [],
    source: 'ai',
    updatedAt: Number(derivation.exportedAt) || Date.now(),
  }
}
const mnemonicByWord = new Map()
for (const sense of mnemonics.senses ?? []) {
  const wordId = String(sense.wordId ?? '')
  if (!wordId) continue
  const list = mnemonicByWord.get(wordId) ?? []
  const mnemonic = sense.mnemonic && typeof sense.mnemonic === 'object' ? sense.mnemonic : {}
  list.push({
    coreSenseIndex: Number(sense.coreSenseIndex) || 1,
    label: String(sense.label ?? ''),
    text: String(mnemonic.text ?? ''),
    source: mnemonic.source === 'manual' ? 'manual' : 'ai',
    updatedAt: Number(mnemonic.updatedAt) || Number(mnemonics.exportedAt) || Date.now(),
  })
  mnemonicByWord.set(wordId, list)
}
for (const [wordId, list] of mnemonicByWord) {
  const overlay = ensureOverlay(wordId)
  if (!overlay) continue
  overlay.senseMnemonics = list.sort((a, b) => a.coreSenseIndex - b.coreSenseIndex)
}
for (const [wordId, overlay] of overlays) {
  if (Object.keys(overlay).length === 0) continue
  const updatedAt = Math.max(Number(overlay.rootEtymology?.updatedAt) || 0, Number(overlay.derivationMap?.updatedAt) || 0, ...(overlay.senseMnemonics ?? []).map((m) => Number(m.updatedAt) || 0), Number(rootBundle.createdAt) || 0)
  addRow(`word-overlay:${wordId}`, 'word-overlay', overlay, updatedAt || Date.now())
}

fs.mkdirSync(path.dirname(OUT), { recursive: true })
if (fs.existsSync(OUT)) fs.rmSync(OUT)
const db = new DatabaseSync(OUT)
try {
  db.exec(`PRAGMA journal_mode=DELETE;`)
  db.exec(`CREATE TABLE content_kv (
    key TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    json TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0
  );`)
  db.exec('CREATE INDEX idx_content_kv_kind_rev ON content_kv(kind, revision);')
  db.exec('CREATE INDEX idx_content_kv_rev ON content_kv(revision);')
  db.exec('CREATE INDEX idx_content_kv_updated ON content_kv(updated_at);')
  const insert = db.prepare('INSERT INTO content_kv(key,kind,json,updated_at,revision,deleted) VALUES(?,?,?,?,?,?)')
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const row of rows.values()) insert.run(row.key, row.kind, row.json, row.updated_at, row.revision, row.deleted)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
} finally {
  db.close()
}

const byKind = {}
for (const row of rows.values()) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1
const size = fs.statSync(OUT).size
console.log(JSON.stringify({
  out: path.relative(ROOT, OUT),
  sizeBytes: size,
  totalRows: rows.size,
  byKind,
  packItems: packItems.length,
  skippedItems,
  packId: PACK_ID,
  overlayWords: byKind['word-overlay'] ?? 0,
}, null, 2))
