#!/usr/bin/env node
/** 列出 semantics pack 中「可疑全并」词：c 数 ≥ minC 且 coreSenses=1，或单 core 组 ≥ minGroup。 */
import { readFileSync } from 'node:fs'
const file = process.argv[2]
const minC = Number(process.argv[3] || 6)
const minGroup = Number(process.argv[4] || 8)
if (!file) { console.error('用法: node tools/list-suspicious-semantics.mjs <pack.json> [minC=6] [minGroup=8]'); process.exit(1) }
const pack = JSON.parse(readFileSync(file, 'utf8'))
const out = []
for (const it of pack.items ?? []) {
  const c = it.meaningMap?.length ?? 0
  const cores = it.coreSenses?.length ?? 0
  const groups = new Map()
  for (const m of it.meaningMap ?? []) groups.set(m.coreSenseIndex, (groups.get(m.coreSenseIndex) ?? 0) + 1)
  const maxGroup = Math.max(0, ...groups.values())
  if ((c >= minC && cores === 1) || maxGroup >= minGroup) out.push({ headword: it.headword, c, cores, maxGroup })
}
out.sort((a, b) => b.maxGroup - a.maxGroup || b.c - a.c)
console.log(JSON.stringify(out, null, 2))
console.error(`[suspicious] ${out.length} 词：` + out.slice(0, 40).map((x) => x.headword).join(', '))
