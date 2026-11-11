#!/usr/bin/env node
/**
 * 导出待生成词表（JSONL/JSON），供外部工具或子代理批量生成内容（task-83）。
 * 不依赖 App 运行时代码；读取内置 deck 的紧凑列式文件。
 *
 * 用法：
 *   node tools/export-words-for-ai.mjs --deck kaoyan-hongbaoshu-2025 --chapter-contains 必考词 \
 *     --kind semantics --limit 100 --out /tmp/words-bikao-001.jsonl
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeDeckWords } from './lib/deck-words.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const has = (name) => args.includes(name)

const DECK = arg('--deck', 'kaoyan-2027-dagang')
const KIND = arg('--kind', 'semantics')
const CHAPTER = String(arg('--chapter-contains', '')).trim()
const LIMIT = Number(arg('--limit', '0')) || 0
const OFFSET = Number(arg('--offset', '0')) || 0
const OUT = resolve(arg('--out', `/tmp/words-${DECK}.jsonl`))
const FORMAT = arg('--format', OUT.endsWith('.json') ? 'json' : 'jsonl')
const INCLUDE_WORDS = new Set(String(arg('--include-words', '')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
const EXCLUDE_WORDS = new Set(String(arg('--exclude-words', '')).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
// dagang 的 c 用「、」分隔义项；受限商业词表用换行+；；可通过 --split-dunhao/--no-split-dunhao 覆盖
const SPLIT_DUNHAO = has('--split-dunhao') || (DECK.includes('dagang') && !has('--no-split-dunhao'))

const file = join(ROOT, 'src/data/builtin', `${DECK}.deck.json`)
if (!existsSync(file)) { console.error(`词库不存在：${file}`); process.exit(1) }
const json = JSON.parse(readFileSync(file, 'utf8'))
if (!json?.deck?.id) json.deck = { id: DECK }
let words = decodeDeckWords(json, { splitDunhao: SPLIT_DUNHAO })
if (CHAPTER) words = words.filter((w) => String(w.chapter ?? '').includes(CHAPTER))
if (INCLUDE_WORDS.size) words = words.filter((w) => INCLUDE_WORDS.has(w.headwordLower))
if (EXCLUDE_WORDS.size) words = words.filter((w) => !EXCLUDE_WORDS.has(w.headwordLower))
if (OFFSET > 0) words = words.slice(OFFSET)
if (LIMIT > 0) words = words.slice(0, LIMIT)

const tasks = words.map((w, i) => ({
  type: 'task',
  id: `task-${String(i + 1).padStart(4, '0')}`,
  kind: KIND,
  headword: w.headword,
  headwordLower: w.headwordLower,
  meanings: w.meanings.map((m, k) => ({ meaningIndex: k + 1, cn: m.cn })),
}))
mkdirSync(dirname(OUT), { recursive: true })
if (FORMAT === 'json') writeFileSync(OUT, JSON.stringify({ type: 'tasks', kind: KIND, deck: DECK, chapter: CHAPTER || null, total: tasks.length, tasks }, null, 2) + '\n')
else writeFileSync(OUT, tasks.map((t) => JSON.stringify(t)).join('\n') + '\n')
console.log(`[export] deck=${DECK} kind=${KIND} words=${tasks.length} c=${tasks.reduce((n, t) => n + t.meanings.length, 0)} splitDunhao=${SPLIT_DUNHAO}`)
console.log(`[export] 写出 ${OUT}`)
