#!/usr/bin/env node
/** 把内置词库切成 root-etymology 生成分片（JSON，每片 N 词）。 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeDeckWords } from './lib/deck-words.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
const has = (n) => args.includes(n)
const DECK = arg('--deck', 'kaoyan-2027-dagang')
const SIZE = Math.max(1, Number(arg('--size', '50')) || 50)
const OFFSET = Math.max(0, Number(arg('--offset', '0')) || 0)
const LIMIT = Math.max(0, Number(arg('--limit', '0')) || 0)
const OUTDIR = resolve(arg('--outdir', '/tmp/root-shards'))
const RESET = has('--reset')

const deck = JSON.parse(readFileSync(join(ROOT, 'src/data/builtin', `${DECK}.deck.json`), 'utf8'))
let words = decodeDeckWords(deck, { splitDunhao: false })
if (OFFSET) words = words.slice(OFFSET)
if (LIMIT) words = words.slice(0, LIMIT)

if (RESET && existsSync(OUTDIR)) rmSync(OUTDIR, { recursive: true, force: true })
mkdirSync(OUTDIR, { recursive: true })

let n = 0
for (let i = 0; i < words.length; i += SIZE) {
  const slice = words.slice(i, i + SIZE)
  const payload = {
    shard: n,
    deck: DECK,
    start: OFFSET + i,
    words: slice.map((w) => ({
      wordId: `${DECK}:${w.headword}`,
      headword: w.headword,
      meanings: w.meanings.map((m) => m.cn),
    })),
  }
  writeFileSync(join(OUTDIR, `words-${String(n).padStart(4, '0')}.json`), JSON.stringify(payload, null, 2) + '\n')
  n += 1
}
console.log(`[split] deck=${DECK} words=${words.length} size=${SIZE} shards=${n} outdir=${OUTDIR}`)
