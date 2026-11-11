#!/usr/bin/env node
/**
 * 分析 semantics pack（task-78 全量报告/质检用）。
 * 用法：node tools/analyze-semantics-pack.mjs /tmp/wordc-2027-dagang-semantics.pack.json
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file) { console.error('用法: node tools/analyze-semantics-pack.mjs <pack.json>'); process.exit(1) }
const pack = JSON.parse(readFileSync(file, 'utf8'))
const items = pack.items ?? []
const multi = items.filter((it) => (it.coreSenses?.length ?? 0) > 1)
const conf = { high: 0, medium: 0, low: 0 }
for (const it of items) for (const cs of it.coreSenses ?? []) conf[cs.confidence] = (conf[cs.confidence] ?? 0) + 1
let nonFirst = 0
let withSteps = 0
let stepsCount = 0
for (const it of items) {
  const firstOfCore = new Map()
  for (const m of [...(it.meaningMap ?? [])].sort((a, b) => a.meaningIndex - b.meaningIndex)) {
    const isFirst = !firstOfCore.has(m.coreSenseIndex)
    if (isFirst) firstOfCore.set(m.coreSenseIndex, m.meaningIndex)
    if (!isFirst || (it.coreSenses?.length ?? 0) >= 2) {
      nonFirst += 1
      if (m.steps?.length) { withSteps += 1; stepsCount += m.steps.length }
    }
  }
}
// 同本义组（同一 coreSense 被多个 c 引用）统计；标签唯一性/逐字一致性由 pack 结构保证，这里量化
let sharedGroups = 0
let maxGroup = 0
let labelDupItems = 0
for (const it of items) {
  const groups = new Map()
  for (const m of it.meaningMap ?? []) {
    const arr = groups.get(m.coreSenseIndex) ?? []
    arr.push(m.meaningIndex)
    groups.set(m.coreSenseIndex, arr)
  }
  for (const arr of groups.values()) {
    if (arr.length >= 2) { sharedGroups += 1; maxGroup = Math.max(maxGroup, arr.length) }
  }
  const labels = (it.coreSenses ?? []).map((c) => c.label.trim())
  if (new Set(labels).size !== labels.length) labelDupItems += 1
}
const single = items.filter((it) => (it.coreSenses?.length ?? 0) === 1)
const sampleSingle = single.slice(0, 10).map((it) => ({
  headword: it.headword,
  core: it.coreSenses?.[0]?.label,
  meanings: (it.meaningMap ?? []).map((m) => `c${m.meaningIndex}→${m.coreSenseIndex}`),
  note: it.meaningMap?.[0]?.note,
}))
const stats = pack.meta?.stats ?? {}
console.log(JSON.stringify({
  file,
  kind: pack.kind,
  promptVersion: pack.meta?.promptVersion,
  items: items.length,
  multiCoreWords: multi.length,
  coreSenses: items.reduce((n, it) => n + (it.coreSenses?.length ?? 0), 0),
  mappedMeanings: items.reduce((n, it) => n + (it.meaningMap?.length ?? 0), 0),
  stepsCoverageNonFirst: nonFirst ? Number((withSteps / nonFirst).toFixed(4)) : 0,
  stepsCount,
  sharedCoreGroups: sharedGroups,
  maxGroupSize: maxGroup,
  labelDuplicateItems: labelDupItems,
  confidence: conf,
  invalidItems: stats.invalidItems ?? null,
  failedBatches: stats.failedBatches ?? null,
  costYuan: stats.costYuan ?? null,
  tokensIn: stats.tokensIn ?? null,
  tokensOut: stats.tokensOut ?? null,
  sampleSingleCoreWords: sampleSingle,
}, null, 2))
