#!/usr/bin/env node
/**
 * 合并多个 momo-pack v1（同 kind 或 mixed）为一个 pack（task-73 全量预生成用）。
 * 用法：node tools/merge-packs.mjs --out /tmp/full.pack.json /tmp/shard-*.pack.json
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? args[outIdx + 1] : null
const files = args.filter((_, i) => i !== outIdx && i !== outIdx + 1)
if (!out || files.length === 0) {
  console.error('用法: node tools/merge-packs.mjs --out <file> <pack1> <pack2> ...')
  process.exit(1)
}
function stable(v) {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stable(x))).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  }
  return 'null'
}
const merged = new Map()
const kinds = new Set()
let words = 0, tokensIn = 0, tokensOut = 0, cost = 0, failed = 0
for (const f of files) {
  const pack = JSON.parse(readFileSync(f, 'utf8'))
  kinds.add(pack.kind)
  words += Number(pack.meta?.stats?.words ?? pack.items.length)
  tokensIn += Number(pack.meta?.stats?.tokensIn ?? 0)
  tokensOut += Number(pack.meta?.stats?.tokensOut ?? 0)
  cost += Number(pack.meta?.stats?.costYuan ?? 0)
  failed += Number(pack.meta?.stats?.failedBatches ?? 0)
  for (const it of pack.items ?? []) {
    const key = String(it.headwordLower ?? it.headword).toLowerCase()
    const cur = merged.get(key) ?? { headword: it.headword, headwordLower: key }
    if (it.examples) cur.examples = [...(cur.examples ?? []), ...it.examples]
    if (it.phrases) cur.phrases = [...(cur.phrases ?? []), ...it.phrases]
    if (it.mnemonics) cur.mnemonics = [...(cur.mnemonics ?? []), ...it.mnemonics]
    merged.set(key, cur)
  }
}
const items = [...merged.values()].map((it) => {
  if (it.examples) it.examples = it.examples.slice(0, 8)
  if (it.phrases) it.phrases = it.phrases.slice(0, 8)
  if (it.mnemonics) it.mnemonics = it.mnemonics.slice(0, 4)
  return it
})
const kind = kinds.size === 1 ? [...kinds][0] : 'mixed'
const checksum = createHash('sha256').update(stable({ format: 'momo-pack', formatVersion: 1, kind, items })).digest('hex')
const pack = {
  format: 'momo-pack', formatVersion: 1, kind, createdAt: Date.now(),
  generator: 'wordc-ai-cli-merge',
  meta: {
    name: `WordC AI pack 全量（kaoyan-2027-dagang · ${items.length} 词）`,
    source: 'ai', provider: 'deepseek', model: 'deepseek-chat', promptVersion: 'v1',
    createdBy: 'WordC', checksumAlgo: 'sha256',
    stats: { words: items.length, shards: files.length, tokensIn, tokensOut, costYuan: Number(cost.toFixed(4)), failedBatches: failed },
  },
  items, checksum,
}
writeFileSync(out, JSON.stringify(pack, null, 2) + '\n')
console.log(`[merge] ${files.length} 片 → ${out}`)
console.log(`[merge] items=${items.length} tokens(in/out)=${tokensIn}/${tokensOut} cost≈¥${cost.toFixed(3)} failed=${failed} checksum=${checksum.slice(0, 16)}…`)
