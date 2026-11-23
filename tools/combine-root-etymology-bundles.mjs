#!/usr/bin/env node
/** 合并多个 root-etymology bundle（按 wordId 去重，后者覆盖前者）+ 可选分片目录。 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const has = (n) => args.includes(n)
const OUT = resolve(arg('--out', '/tmp/root-etymology-full.bundle.json'))
const VERSION = arg('--version', '0.7.0')
const DECK = arg('--deck', 'kaoyan-2027-dagang')
const bundles = []
for (let i = 0; i < args.length; i++) if (args[i] === '--bundle') bundles.push(resolve(args[i + 1]))
const dirs = []
for (let i = 0; i < args.length; i++) if (args[i] === '--dir') dirs.push(resolve(args[i + 1]))

const byId = new Map()
const add = (it, src) => {
  const wid = String(it?.wordId ?? '').trim()
  const re = it?.rootEtymology ?? (Array.isArray(it?.parts) ? it : null)
  const parts = Array.isArray(re?.parts) ? re.parts : []
  if (!wid || parts.length === 0) return
  if (parts.some((p) => !String(p?.meaning ?? '').trim() || !String(p?.text ?? '').trim())) return
  byId.set(wid, { wordId: wid, ...(it.headword ? { headword: it.headword } : {}), deckId: it.deckId ?? DECK, rootEtymology: { parts, ...(re.etymology ? { etymology: re.etymology } : {}), ...(re.composition ? { composition: re.composition } : {}), source: re.source ?? 'ai', updatedAt: re.updatedAt ?? Date.now(), ...(re.model ? { model: re.model } : {}) }, _src: src })
}
let raw = 0
for (const f of bundles) {
  const d = JSON.parse(readFileSync(f, 'utf8'))
  for (const it of d.items ?? []) { raw++; add(it, f) }
}
for (const dir of dirs) {
  if (!existsSync(dir)) continue
  for (const f of readdirSync(dir).filter((x) => /^out-.*\.json$/.test(x)).sort()) {
    const d = JSON.parse(readFileSync(resolve(dir, f), 'utf8'))
    for (const it of (Array.isArray(d) ? d : d.items ?? [])) { raw++; add(it, f) }
  }
}
const items = [...byId.values()].map(({ _src, ...it }) => it)
const payload = { format: 'momo-root-etymology-bundle', formatVersion: 1, version: VERSION, createdAt: Date.now(), generator: 'tools/combine-root-etymology-bundles.mjs', counts: { items: items.length }, items }
const stable = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val))
const checksum = createHash('sha256').update(stable(payload)).digest('hex')
writeFileSync(OUT, JSON.stringify({ ...payload, checksum }, null, 2) + '\n')
console.log(JSON.stringify({ raw, merged: items.length, out: OUT, checksum }, null, 2))
