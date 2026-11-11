#!/usr/bin/env node
/** 两遍法合并：base pack + rerun pack，同 headword 若 rerun 的 coreSenses 更多则覆盖 base item。 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const baseFile = arg('--base'), rerunFile = arg('--rerun'), out = arg('--out')
if (!baseFile || !rerunFile || !out) { console.error('用法: node tools/merge-rerun-semantics.mjs --base <base.pack> --rerun <rerun.pack> --out <out.pack>'); process.exit(1) }
const stable = (v) => {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stable(x))).join(',') + ']'
  if (t === 'object') { const k = Object.keys(v).filter((x) => v[x] !== undefined).sort(); return '{' + k.map((x) => JSON.stringify(x) + ':' + stable(v[x])).join(',') + '}' }
  return 'null'
}
const base = JSON.parse(readFileSync(baseFile, 'utf8'))
const rerun = JSON.parse(readFileSync(rerunFile, 'utf8'))
const byWord = new Map((base.items ?? []).map((it) => [(it.headwordLower ?? it.headword).toLowerCase(), it]))
let replaced = 0
for (const it of rerun.items ?? []) {
  const key = (it.headwordLower ?? it.headword).toLowerCase()
  const old = byWord.get(key)
  if (!old || (it.coreSenses?.length ?? 0) > (old.coreSenses?.length ?? 0)) { byWord.set(key, it); replaced += 1 }
}
const items = [...byWord.values()].sort((a, b) => (a.headwordLower < b.headwordLower ? -1 : a.headwordLower > b.headwordLower ? 1 : 0))
const checksum = createHash('sha256').update(stable({ format: 'momo-pack', formatVersion: 1, kind: 'semantics', items })).digest('hex')
const pack = { ...base, createdAt: Date.now(), generator: 'wordc-ai-cli-rerun-merge@0.3.5', items, checksum,
  meta: { ...base.meta, stats: { ...(base.meta?.stats ?? {}), words: items.length, coreSenses: items.reduce((n, it) => n + (it.coreSenses?.length ?? 0), 0), mappedMeanings: items.reduce((n, it) => n + (it.meaningMap?.length ?? 0), 0) } } }
writeFileSync(out, JSON.stringify(pack) + '\n')
console.log(`[rerun-merge] base=${base.items.length} rerun=${rerun.items.length} replaced=${replaced} → ${out}`)
console.log(`[rerun-merge] items=${items.length} cores=${pack.meta.stats.coreSenses} checksum=${checksum.slice(0, 16)}…`)
