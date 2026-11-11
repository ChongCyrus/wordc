#!/usr/bin/env node
/**
 * 把外部/子代理生成的 JSONL/JSON/CSV 归一成 momo-pack v1（task-83）。
 *
 * 支持：
 * - 语义：每行 {headword, meanings:[{meaningIndex,cn,coreSenseLabel,confidence,steps?}]}
 *   或已聚合的 {headword, coreSenses:[...], meaningMap:[...]}
 * - 内容：{headword, meaningIndex?, kind?:'examples'|'phrases'|'mnemonics',
 *          examples:[{en,cn}], phrases:[{en,cn}], mnemonics:[{type,text}]}
 * - 字段别名：word/headword、meaning/meaningIndex、examples/examples 等
 * 去重/上限：examples 8、phrases 8、mnemonics 4（含义级 examples 4 由 App 合并时再限）
 *
 * 用法：node tools/normalize-external-pack.mjs --kind semantics --out /tmp/x.pack.json \
 *   /tmp/part-001.jsonl /tmp/part-002.jsonl
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { aggregateSemanticsLabels, validateSemanticsItems } from '../src/data/ai/semantics.ts'

const LIMITS = { examples: 8, phrases: 8, mnemonics: 4 }
const MNEMONIC_TYPES = new Set(['root', 'assoc', 'story', '联想', '词根', '谐音', '词源', '串记', '口诀', '其他'])

export function stableStringify(v) {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
  }
  return 'null'
}
export const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim())
  if (lines.length < 2) return []
  const split = (line) => line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''))
  const header = split(lines[0]).map((h) => h.toLowerCase())
  return lines.slice(1).map((line, i) => {
    const values = split(line)
    const row = {}
    header.forEach((h, idx) => { row[h] = values[idx] ?? '' })
    return { row, line: i + 2 }
  })
}

export function parseInputFile(file) {
  if (!existsSync(file)) throw new Error(`文件不存在：${file}`)
  const text = readFileSync(file, 'utf8')
  const lower = file.toLowerCase()
  if (lower.endsWith('.csv')) return { entries: parseCsv(text).map((x) => ({ ...x.row, __line: x.line })), file }
  if (lower.endsWith('.json')) {
    const data = JSON.parse(text)
    const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
    return { entries: arr.map((x, i) => ({ ...x, __line: i + 1 })), file }
  }
  // JSONL
  const entries = []
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return
    try { entries.push({ ...JSON.parse(line), __line: i + 1 }) } catch (e) { entries.push({ __error: e.message, __line: i + 1 }) }
  })
  return { entries, file }
}

function pick(obj, ...names) {
  for (const n of names) if (obj[n] !== undefined && obj[n] !== null && obj[n] !== '') return obj[n]
  return undefined
}

function normalizeContentEntry(raw, fallbackKind) {
  const headword = String(pick(raw, 'headword', 'word', 'term') ?? '').trim()
  if (!headword) return { error: '缺少 headword' }
  const lower = String(pick(raw, 'headwordLower', 'wordLower') ?? headword).toLowerCase()
  const mi = Number(pick(raw, 'meaningIndex', 'meaning', 'meaningIndex1', 'c') ?? 0)
  const kind = String(pick(raw, 'kind', 'type') ?? fallbackKind ?? '').replace(/^content:/, '')
  const item = { headword, headwordLower: lower }
  if (Number.isInteger(mi) && mi > 0) item.meaningIndex = mi
  const ex = pick(raw, 'examples', 'example', 'examplesList')
  const ph = pick(raw, 'phrases', 'phrase', 'phrasesList')
  const mn = pick(raw, 'mnemonics', 'mnemonic', 'mnemonicsList')
  const pushEx = (arr) => Array.isArray(arr) ? arr : arr ? [arr] : []
  if (kind === 'examples' || ex) {
    item.examples = pushEx(ex).map((e) => typeof e === 'string' ? { en: e, cn: String(raw.cn ?? '') } : { en: String(e.en ?? e.english ?? e.example ?? ''), cn: String(e.cn ?? e.chinese ?? e.translation ?? '') })
      .filter((e) => e.en && e.cn).slice(0, LIMITS.examples)
  }
  if (kind === 'phrases' || ph) {
    item.phrases = pushEx(ph).map((p) => ({ en: String(p.en ?? p.english ?? p.phrase ?? ''), cn: String(p.cn ?? p.chinese ?? p.translation ?? ''), ...(Number.isInteger(Number(p.meaningIndex)) ? { meaningIndex: Number(p.meaningIndex) } : {}) }))
      .filter((p) => p.en && p.cn).slice(0, LIMITS.phrases)
  }
  if (kind === 'mnemonics' || mn) {
    item.mnemonics = pushEx(mn).map((m) => ({ type: MNEMONIC_TYPES.has(String(m.type)) ? String(m.type) : 'assoc', text: String(m.text ?? m.content ?? m.value ?? '') }))
      .filter((m) => m.text).slice(0, LIMITS.mnemonics)
  }
  if (!item.examples && !item.phrases && !item.mnemonics) return { error: '无 examples/phrases/mnemonics 内容' }
  return { item }
}

export function normalizeEntries(inputs, opts = {}) {
  const errors = []
  const skipped = []
  const semantics = new Map()
  const semGroups = new Map() // headwordLower -> {headword, meanings: Map(meaningIndex->meaning)}
  const content = new Map()
  for (const { entries, file } of inputs) {
    for (const raw of entries) {
      const where = `${file}:${raw.__line}`
      if (raw.__error) { errors.push({ where, message: `JSON 解析失败：${raw.__error}` }); continue }
      const headword = String(pick(raw, 'headword', 'word', 'term') ?? '').trim()
      if (!headword) { errors.push({ where, message: '缺少 headword' }); continue }
      const lower = String(pick(raw, 'headwordLower', 'wordLower') ?? headword).toLowerCase()
      // 语义：per-c labels 或已聚合的 coreSenses/meaningMap
      if (Array.isArray(raw.meanings) && raw.meanings.some((m) => pick(m, 'coreSenseLabel', 'label', 'coreSense') !== undefined)) {
        // 归组：兼容「每词一行」与「flat per-c 多行」；同 headword 的 meanings 合并
        const group = semGroups.get(lower) ?? { headword, headwordLower: lower, meanings: new Map() }
        for (let i = 0; i < raw.meanings.length; i += 1) {
          const m = raw.meanings[i]
          const mi = Number(m.meaningIndex ?? m.meaning ?? i + 1)
          if (!Number.isInteger(mi) || mi < 1) continue
          group.meanings.set(mi, { ...m, meaningIndex: mi, cn: String(pick(m, 'cn', 'meaning', 'zh') ?? '') })
        }
        semGroups.set(lower, group)
        continue
      }
      if (Array.isArray(raw.coreSenses) && Array.isArray(raw.meaningMap)) {
        const count = raw.meaningMap.length
        const target = { headword, headwordLower: lower, meanings: Array.from({ length: count }, (_, i) => ({ meaningIndex: i + 1, cn: '' })) }
        const res = validateSemanticsItems({ json: { items: [raw] }, targets: [target] })
        if (res.error) { errors.push({ where, message: res.error }); continue }
        for (const it of res.byKey.values()) semantics.set(it.headwordLower, it)
        continue
      }
      // 内容
      const res = normalizeContentEntry(raw, opts.kind)
      if (res.error) { errors.push({ where, message: res.error }); continue }
      const item = res.item
      const key = `${item.headwordLower}#${item.meaningIndex ?? 0}`
      const cur = content.get(key) ?? { headword: item.headword, headwordLower: item.headwordLower, ...(item.meaningIndex ? { meaningIndex: item.meaningIndex } : {}) }
      for (const k of ['examples', 'phrases', 'mnemonics']) {
        if (!item[k]) continue
        cur[k] = [...(cur[k] ?? []), ...item[k]]
      }
      content.set(key, cur)
    }
  }
  // 语义归组后聚合（同 headword 的所有 c 一次进 aggregate，保证覆盖/同 label 一致）
  for (const group of semGroups.values()) {
    const meanings = [...group.meanings.values()].sort((a, b) => a.meaningIndex - b.meaningIndex)
    const raw = { headword: group.headword, meanings }
    const target = { headword: group.headword, headwordLower: group.headwordLower, meanings: meanings.map((m) => ({ meaningIndex: m.meaningIndex, cn: m.cn })) }
    const agg = aggregateSemanticsLabels({ json: { items: [raw] }, targets: [target] })
    if (agg.error) { errors.push({ where: `${group.headwordLower} (grouped)`, message: agg.error }); continue }
    for (const it of agg.byKey.values()) semantics.set(it.headwordLower, it)
  }
  // 去重/上限（按 en/text 规范化）
  for (const it of [...semantics.values(), ...content.values()]) {
    for (const k of ['examples', 'phrases']) {
      if (!it[k]) continue
      const seen = new Set()
      it[k] = it[k].filter((e) => { const key = e.en.trim().toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true }).slice(0, LIMITS[k])
    }
    if (it.mnemonics) {
      const seen = new Set()
      it.mnemonics = it.mnemonics.filter((m) => { const key = `${m.type}:${m.text}`; if (seen.has(key)) return false; seen.add(key); return true }).slice(0, LIMITS.mnemonics)
    }
  }
  const items = [...semantics.values(), ...content.values()]
  const kinds = new Set(items.flatMap((it) => ['examples', 'phrases', 'mnemonics'].filter((k) => it[k]?.length)))
  if (semantics.size > 0) kinds.add('semantics')
  const kind = semantics.size === items.length ? 'semantics' : kinds.size === 1 ? [...kinds][0] : 'mixed'
  return { items, kind, errors, skipped }
}

export function buildPackFromEntries(inputs, opts = {}) {
  const { items, kind, errors, skipped } = normalizeEntries(inputs, opts)
  if (items.length === 0) return { ok: false, errors, skipped, pack: null }
  const checksum = sha256(stableStringify({ format: 'momo-pack', formatVersion: 1, kind, items }))
  const pack = {
    format: 'momo-pack', formatVersion: 1, kind, createdAt: Date.now(),
    generator: 'wordc-external-normalize@0.3.5',
    meta: {
      name: opts.name ?? '外部生成内容包', source: 'import', provider: opts.provider ?? 'external',
      ...(opts.model ? { model: opts.model } : {}), ...(opts.promptVersion ? { promptVersion: opts.promptVersion } : {}),
      createdBy: 'WordC', checksumAlgo: 'sha256',
      stats: { words: new Set(items.map((i) => i.headwordLower)).size, items: items.length, errors: errors.length, skipped: skipped.length },
    },
    items, checksum,
  }
  return { ok: true, pack, errors, skipped }
}

async function main() {
  const args = process.argv.slice(2)
  const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
  const out = resolve(arg('--out', '/tmp/external.pack.json'))
  const inArg = String(arg('--in', '')).split(',').map((s) => s.trim()).filter(Boolean)
  const opts = { kind: arg('--kind', ''), name: arg('--name', ''), provider: arg('--provider', 'external'), model: arg('--model', ''), promptVersion: arg('--prompt-version', '') }
  // 位置参数；正确跳过带值 option 的值，避免把 --out 的值当输入文件
  const VALUE_FLAGS = new Set(['--out', '--in', '--kind', '--name', '--provider', '--model', '--prompt-version'])
  const positional = []
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]
    if (VALUE_FLAGS.has(a)) { i += 1; continue }
    if (a.startsWith('-')) continue
    positional.push(a)
  }
  const files = [...new Set([...inArg, ...positional])]
  if (files.length === 0) { console.error('用法: node tools/normalize-external-pack.mjs --out <pack.json> <input.jsonl|json|csv>...'); process.exit(1) }
  const inputs = files.map(parseInputFile)
  const res = buildPackFromEntries(inputs, opts)
  if (!res.ok) { console.error(`[normalize] 失败：${res.errors.length} 条错误，无有效 items`); res.errors.slice(0, 20).forEach((e) => console.error('  ✗', e.where, e.message)); process.exit(1) }
  writeFileSync(out, JSON.stringify(res.pack, null, 2) + '\n')
  console.log(`[normalize] ${files.length} 文件 → ${res.pack.items.length} items（kind=${res.pack.kind}），errors=${res.errors.length} skipped=${res.skipped.length}`)
  console.log(`[normalize] 写出 ${out}`)
  console.log(`[normalize] checksum=${res.pack.checksum.slice(0, 16)}…`)
  if (res.errors.length) res.errors.slice(0, 10).forEach((e) => console.log('  ⚠', e.where, e.message))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((e) => { console.error('[fatal]', e.message); process.exit(1) })
