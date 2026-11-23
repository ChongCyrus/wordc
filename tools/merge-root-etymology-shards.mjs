#!/usr/bin/env node
/** 合并 workflow/子代理产出的词根缀源分片为 momo-root-etymology-bundle v1。 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const SRCDIR = resolve(arg('--srcdir', '/tmp/root-shards'))
const PATTERN = arg('--pattern', '^out-.*\\.json$')
const OUT = resolve(arg('--out', '/tmp/root-etymology.bundle.json'))
const DECK = arg('--deck', 'kaoyan-2027-dagang')
const VERSION = arg('--version', '0.7.0')
const now = Date.now()

const re = new RegExp(PATTERN)
const files = existsSync(SRCDIR) ? readdirSync(SRCDIR).filter((f) => re.test(f)).sort() : []
if (files.length === 0) { console.error(`没有找到分片：${SRCDIR}`); process.exit(1) }

const byId = new Map()
const invalid = []
const duplicates = []
let rawCount = 0
for (const file of files) {
  const data = JSON.parse(readFileSync(join(SRCDIR, file), 'utf8'))
  const items = Array.isArray(data) ? data : (data.items ?? [])
  for (const item of items) {
    rawCount += 1
    const wordId = typeof item?.wordId === 'string' ? item.wordId.trim() : ''
    const headword = typeof item?.headword === 'string' ? item.headword.trim() : ''
    const parts = Array.isArray(item?.parts) ? item.parts : []
    const clean = parts
      .map((p) => ({
        type: ['prefix', 'root', 'suffix', 'other'].includes(p?.type) ? p.type : 'other',
        text: String(p?.text ?? '').trim(),
        meaning: String(p?.meaning ?? '').trim(),
        ...(p?.note ? { note: String(p.note).trim() } : {}),
      }))
      .filter((p) => p.text && p.meaning)
    if (!wordId || clean.length === 0) { invalid.push({ file, wordId, headword }); continue }
    if (byId.has(wordId)) { duplicates.push({ wordId, file }); continue }
    byId.set(wordId, {
      wordId,
      ...(headword ? { headword } : {}),
      deckId: DECK,
      rootEtymology: {
        parts: clean,
        ...(item.etymology ? { etymology: String(item.etymology).trim() } : {}),
        ...(item.composition ? { composition: String(item.composition).trim() } : {}),
        source: 'ai',
        updatedAt: now,
        model: 'buddy-workflow',
      },
    })
  }
}

const items = [...byId.values()]
const payload = {
  format: 'momo-root-etymology-bundle',
  formatVersion: 1,
  version: VERSION,
  createdAt: now,
  generator: 'tools/merge-root-etymology-shards.mjs',
  counts: { items: items.length },
  items,
}
const stable = (v) => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]])) : val))
const checksum = createHash('sha256').update(stable(payload)).digest('hex')
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify({ ...payload, checksum }, null, 2) + '\n')
const report = { files: files.length, rawCount, merged: items.length, duplicates: duplicates.length, invalid: invalid.length, sampleInvalid: invalid.slice(0, 5), checksum, out: OUT }
writeFileSync(OUT.replace(/\.json$/, '.report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
