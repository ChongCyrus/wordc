#!/usr/bin/env node
/**
 * 合并 semantics 分片为单一 momo-pack（task-78 全量用）：
 * - 各片词不重叠（直接拼接）；若重复 headword，则合并 coreSenses（按 index 重映射）与 meaningMap；
 * - checksum = sha256(stableStringify({format,formatVersion,kind,items}))；
 * - meta.stats 汇总各片。
 * 用法：node tools/merge-semantics-packs.mjs --out /tmp/sem.pack.json /tmp/shards/*.pack.json
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const outIdx = args.indexOf('--out')
const out = outIdx >= 0 ? args[outIdx + 1] : null
const files = args.filter((_, i) => i !== outIdx && i !== outIdx + 1)
if (!out || files.length === 0) {
  console.error('用法: node tools/merge-semantics-packs.mjs --out <file> <pack1> <pack2> ...')
  process.exit(1)
}
const stable = (v) => {
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
let inputMeanings = 0, coreSenses = 0, mappedMeanings = 0, cost = 0, tokensIn = 0, tokensOut = 0, failed = 0, invalid = 0, skipped = 0, labelGroups = 0, labelMultiGroups = 0, labelExactGroups = 0
let promptVersion = null, model = null, provider = null
for (const f of files) {
  const pack = JSON.parse(readFileSync(f, 'utf8'))
  if (pack.kind !== 'semantics' && pack.kind !== 'mixed') throw new Error(`${f} 不是 semantics pack: ${pack.kind}`)
  promptVersion = promptVersion ?? pack.meta?.promptVersion ?? null
  model = model ?? pack.meta?.model ?? null
  provider = provider ?? pack.meta?.provider ?? null
  const st = pack.meta?.stats ?? {}
  inputMeanings += Number(st.inputMeanings ?? 0)
  coreSenses += Number(st.coreSenses ?? 0)
  mappedMeanings += Number(st.mappedMeanings ?? 0)
  cost += Number(st.costYuan ?? 0)
  tokensIn += Number(st.tokensIn ?? 0)
  tokensOut += Number(st.tokensOut ?? 0)
  failed += Number(st.failedBatches ?? 0)
  invalid += Number(st.invalidItems ?? 0)
  skipped += Number(st.skippedMeanings ?? 0)
  labelGroups += Number(st.labelGroups ?? 0)
  labelMultiGroups += Number(st.labelMultiGroups ?? 0)
  labelExactGroups += Number(st.labelExactGroups ?? 0)
  for (const it of pack.items ?? []) {
    const key = (it.headwordLower ?? it.headword).toLowerCase()
    if (!merged.has(key)) { merged.set(key, it); continue }
    // 重复词（理论上分片不重叠）：保留已有，只补缺失的 meaningMap
    const cur = merged.get(key)
    const have = new Set((cur.meaningMap ?? []).map((m) => m.meaningIndex))
    for (const m of it.meaningMap ?? []) if (!have.has(m.meaningIndex)) cur.meaningMap.push(m)
    if (!cur.coreSenses?.length && it.coreSenses?.length) cur.coreSenses = it.coreSenses
  }
}
const items = [...merged.values()].sort((a, b) => (a.headwordLower < b.headwordLower ? -1 : a.headwordLower > b.headwordLower ? 1 : 0))
const cores = items.reduce((n, it) => n + (it.coreSenses?.length ?? 0), 0)
const maps = items.reduce((n, it) => n + (it.meaningMap?.length ?? 0), 0)
const checksum = createHash('sha256').update(stable({ format: 'momo-pack', formatVersion: 1, kind: 'semantics', items })).digest('hex')
const pack = {
  format: 'momo-pack', formatVersion: 1, kind: 'semantics', createdAt: Date.now(),
  generator: 'wordc-ai-cli-merge@0.3.4',
  meta: {
    name: `WordC 本义/引申链 pack（kaoyan-2027-dagang · ${items.length} 词）`,
    source: 'ai', provider, model, promptVersion,
    scope: { kind: 'deck', deckId: 'kaoyan-2027-dagang', semantics: true, shards: files.length },
    createdBy: 'WordC', checksumAlgo: 'sha256',
    stats: {
      words: items.length, inputMeanings, coreSenses: cores, mappedMeanings: maps,
      failedBatches: failed, invalidItems: invalid, skippedMeanings: skipped,
      labelGroups, labelMultiGroups, labelExactGroups,
      tokensIn, tokensOut, costYuan: Number(cost.toFixed(4)),
    },
  },
  items, checksum,
}
writeFileSync(out, JSON.stringify(pack, null, 2) + '\n')
console.log(`[merge-sem] ${files.length} 片 → ${out}`)
console.log(`[merge-sem] items=${items.length} coreSenses=${cores} mapped=${maps} cost≈¥${cost.toFixed(3)} prompt=${promptVersion} checksum=${checksum.slice(0, 16)}…`)
