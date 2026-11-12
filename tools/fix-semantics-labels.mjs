#!/usr/bin/env node
/**
 * 合并同词内审计判定为「近义未合并」的 coreSenses（task-99 后处理）：
 * - label 相同 / 互相包含 / 编辑距离 ≤1 → 合并为较短 label（审计 E_LABEL_SIMILAR/DUP 规则）；
 * - 重新编号 coreSenses.index，并把 meaningMap.coreSenseIndex 映射到合并后的 index；
 * - 重新计算 pack checksum，原地或 --out 写出。
 * 用法：node tools/fix-semantics-labels.mjs --in /tmp/x.pack.json --out /tmp/x.fixed.pack.json
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const inPath = args[args.indexOf('--in') + 1]
const outIdx = args.indexOf('--out')
const outPath = outIdx >= 0 ? args[outIdx + 1] : inPath
if (!inPath) { console.error('用法: --in <pack.json> [--out <fixed.json>]'); process.exit(1) }

function stableStringify(v) {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',') + ']'
  if (t === 'object') { const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort(); return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}' }
  return 'null'
}
function checksumOf(pack) {
  const payload = stableStringify({ format: pack.format, formatVersion: pack.formatVersion, kind: pack.kind, items: pack.items })
  return createHash('sha256').update(payload).digest('hex')
}
function normLabel(raw) { return String(raw ?? '').replace(/[\s，。、；：""''()（）【】「」·—…\-,.;:!?！？]/g, '').replace(/[的地得]$/, '').trim() }
function distAtMost1(a, b) {
  if (a === b) return true
  if (Math.abs(a.length - b.length) > 1) return false
  if (a.length === b.length) { let diffs = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diffs++; return diffs <= 1 }
  const [s, l] = a.length < b.length ? [a, b] : [b, a]
  let i = 0, j = 0, skipped = false
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue }
    if (skipped) return false
    skipped = true; j++
  }
  return true
}
function similar(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) return true
  return distAtMost1(a, b)
}

const pack = JSON.parse(readFileSync(inPath, 'utf8'))
let mergedWords = 0
let mergedSenses = 0
for (const item of Array.isArray(pack.items) ? pack.items : []) {
  const senses = Array.isArray(item.coreSenses) ? item.coreSenses : []
  if (senses.length < 2) continue
  const groups = [] // {sense, oldIndexes[]}
  for (const sense of senses) {
    const label = normLabel(sense.label)
    const hit = groups.find((g) => similar(normLabel(g.sense.label), label))
    if (hit) { hit.oldIndexes.push(sense.index); mergedSenses += 1 }
    else groups.push({ sense: { ...sense }, oldIndexes: [sense.index] })
  }
  if (groups.length === senses.length) continue
  mergedWords += 1
  const remap = new Map()
  const nextSenses = groups.map((group, i) => {
    for (const old of group.oldIndexes) remap.set(old, i + 1)
    return { ...group.sense, index: i + 1 }
  })
  item.coreSenses = nextSenses
  if (Array.isArray(item.meaningMap)) {
    item.meaningMap = item.meaningMap.map((mapping) => {
      const mapped = remap.get(mapping.coreSenseIndex)
      return { ...mapping, coreSenseIndex: mapped ?? 1 }
    })
  }
}
pack.checksum = checksumOf(pack)
if (pack.meta?.stats) {
  pack.meta.stats.coreSenses = pack.items.reduce((n, item) => n + (item.coreSenses?.length ?? 0), 0)
  pack.meta.stats.labelMergeFixedWords = mergedWords
  pack.meta.stats.labelMergeMergedSenses = mergedSenses
}
writeFileSync(outPath, JSON.stringify(pack))
console.log(`[fix-labels] ${inPath} -> ${outPath}: mergedWords=${mergedWords} mergedSenses=${mergedSenses} checksum=${pack.checksum.slice(0, 12)}…`)
