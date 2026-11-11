#!/usr/bin/env node
/**
 * 从「用户自己的导出文件」生成可导入的 deck JSON（task-58）。
 *
 * 用途：公开版只内置可合法分发的「2027 考研大纲」词库；受限商业词表等版权受限词表
 * 不随仓分发。用户可把自己账号里导出的单词表（JSON/CSV/TXT）转成自定义词库，
 * 然后通过 App 的「导入词库」功能导入。
 *
 * 用法：
 *   node tools/make-deck-from-export.mjs --in my-words.json --out my-deck.json --name "我的词库"
 *   node tools/make-deck-from-export.mjs --in my-words.csv  --out my-deck.json --name "我的词库"
 *
 * 输入格式（自动识别）：
 *   1) 本仓库 DeckFile / MigrationFile：直接透传（只补 id/order 等字段）
 *   2) JSON 数组或 {words:[...]}：每项可含 headword/word/term/spelling、meaning/meanings/translations/translation
 *   3) CSV（首行表头）：列名同上（大小写不敏感）
 *   4) TXT：每行 `headword<TAB>释义` 或 `headword 释义`
 *
 * 输出：momo-deck formatVersion 1 的 DeckFile（可直接被 App「导入词库」解析）。
 * 注意：**本脚本不包含、也不读取任何受限词表**；只处理用户提供的文件。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'

function parseArgs(argv) {
  const out = { input: '', output: '', name: '', id: '' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--in' || arg === '-i') out.input = argv[++i]
    else if (arg === '--out' || arg === '-o') out.output = argv[++i]
    else if (arg === '--name' || arg === '-n') out.name = argv[++i]
    else if (arg === '--id') out.id = argv[++i]
    else if (arg === '--help' || arg === '-h') {
      console.log('用法: node tools/make-deck-from-export.mjs --in <文件> --out <deck.json> [--name 词库名] [--id deck-id]')
      process.exit(0)
    }
  }
  if (!out.input || !out.output) {
    console.error('缺少 --in / --out，--help 查看用法')
    process.exit(1)
  }
  return out
}

/** 生成稳定 deck id（纯 ASCII slug；不足/重复时加时间戳） */
function slugify(text) {
  const slug = String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return slug || `custom-${Date.now().toString(36)}`
}

/** 归一化 headword（与 App 的 wordId 规则一致：小写、去首尾空白） */
function normalizeHeadword(raw) {
  return String(raw ?? '').trim().toLowerCase()
}

/** 从任意行对象提取 headword 与释义文本 */
function pickRow(obj) {
  if (!obj || typeof obj !== 'object') return null
  const lower = Object.fromEntries(Object.entries(obj).map(([k, v]) => [k.toLowerCase(), v]))
  const headword =
    lower.headword ?? lower.word ?? lower.term ?? lower.spelling ?? lower.name ?? lower.english ?? ''
  let meaning = lower.meaning ?? lower.meanings ?? lower.translation ?? lower.translations ?? lower.cn ?? lower.chinese
  if (Array.isArray(meaning)) {
    // meanings 既可能是字符串数组，也可能是 {pos, cn} 对象数组
    meaning = meaning
      .map((item) => (typeof item === 'string' ? item : item?.cn ?? item?.meaning ?? ''))
      .filter(Boolean)
      .join('\n')
  }
  if (meaning && typeof meaning === 'object') meaning = meaning.cn ?? meaning.meaning ?? JSON.stringify(meaning)
  const text = String(meaning ?? '').trim()
  return normalizeHeadword(headword) ? { headword: String(headword).trim(), meaning: text } : null
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim())
  if (lines.length === 0) return []
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map((line) => {
    const cells = []
    let current = ''
    let quoted = false
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { current += '"'; i += 1 } else quoted = !quoted
      } else if (ch === ',' && !quoted) { cells.push(current); current = '' } else current += ch
    }
    cells.push(current)
    const obj = {}
    headers.forEach((header, index) => { obj[header] = (cells[index] ?? '').trim() })
    return obj
  })
}

function parseTxt(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [headword, ...rest] = line.split(/\\t| {2,}|\\s/).filter(Boolean)
      return { headword, meaning: rest.join(' ') }
    })
}

/** 读用户文件 → [{headword, meaning}] */
function readUserWords(file) {
  const text = readFileSync(file, 'utf8')
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed)
    // 1) 本仓库导出文件：DeckFile / MigrationFile / 迁移包 data.words
    if (parsed?.format === 'momo-deck' && Array.isArray(parsed.words)) return parsed.words
    if (parsed?.format && parsed?.data?.words && Array.isArray(parsed.data.words)) return parsed.data.words
    const rows = Array.isArray(parsed) ? parsed : parsed.words ?? parsed.data ?? parsed.records ?? []
    return rows.map(pickRow).filter(Boolean)
  }
  if (file.toLowerCase().endsWith('.csv') || /^[^\n]*,[^\n]*\n/.test(trimmed)) {
    return parseCsv(text).map(pickRow).filter(Boolean)
  }
  return parseTxt(text).map(pickRow).filter(Boolean)
}

const args = parseArgs(process.argv.slice(2))
const inputPath = resolve(process.cwd(), args.input)
if (!existsSync(inputPath)) {
  console.error(`输入文件不存在：${inputPath}`)
  process.exit(1)
}
const rawWords = readUserWords(inputPath)
if (rawWords.length === 0) {
  console.error('未从输入文件解析出任何单词（支持 JSON 数组/CSV/TSV/TXT）')
  process.exit(1)
}

const name = args.name || basename(inputPath).replace(/\\.[^.]+$/, '')
const deckId = args.id || slugify(name)
const now = Date.now()
const seen = new Set()
const words = []
for (const row of rawWords) {
  const normalized = pickRow(row) ?? row
  const headword = normalized.headword ?? row.headword ?? row.word ?? row.term
  const meaning = normalized.meaning ?? row.meaning ?? ''
  const lower = normalizeHeadword(headword)
  if (!lower || seen.has(lower)) continue // 同词去重（大小写变体合并）
  seen.add(lower)
  words.push({
    id: `${deckId}:${lower}`,
    headword: String(headword).trim(),
    headwordLower: lower,
    order: words.length + 1,
    meanings: String(meaning)
      .split(/\r?\n|；|;/)
      .map((cn) => cn.trim())
      .filter(Boolean)
      .map((cn) => ({ cn })),
    examples: [],
    phrases: [],
    tags: ['custom'],
  })
}
for (const word of words) {
  if (word.meanings.length === 0) word.meanings = [{ cn: word.headword }]
}

const deckFile = {
  format: 'momo-deck',
  formatVersion: 1,
  exportedAt: now,
  generator: 'make-deck-from-export@1',
  deck: {
    id: deckId,
    name,
    source: 'imported',
    wordCount: words.length,
    version: 1,
    createdAt: now,
    updatedAt: now,
  },
  words,
}
const outPath = resolve(process.cwd(), args.output)
writeFileSync(outPath, JSON.stringify(deckFile, null, 2) + '\n')
console.log(`✓ 已生成 ${outPath}：${words.length} 词（deckId=${deckId}）`)
console.log('  下一步：App → 词库 → 导入词库 → 选择该 JSON 文件')
