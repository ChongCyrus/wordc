#!/usr/bin/env node
/**
 * task-99 · 用 v4 重生成结果**替换**旧 semantics pack 中对应词，输出新 pack。
 *
 * - 按 headwordLower 替换（不是只补缺）：base 中命中的词用 regen 的 item 覆盖；
 * - regen 里有、base 没有的词追加到末尾；
 * - 其它词保留旧 item；checksum 重算；meta.promptVersion 写 v4；旧文件保留备份。
 *
 * 用法：
 *   node tools/merge-semantics-packs.mjs --base data/packs/hongbaoshu/semantics-full-6702.pack.json \
 *     --regen /tmp/regen/full.v4.pack.json --out data/packs/hongbaoshu/semantics-full-6702-v4.pack.json
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(',')}]`
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value ?? null)
}

export function packChecksum(pack) {
  const payload = { format: pack.format, formatVersion: pack.formatVersion, kind: pack.kind, items: pack.items }
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

/** 合并 base + regen（按 headwordLower 替换），纯函数 */
export function mergeSemanticsPacks(base, regen, opts = {}) {
  const regenItems = Array.isArray(regen?.items) ? regen.items : []
  const baseItems = Array.isArray(base?.items) ? base.items : []
  const regenByLower = new Map()
  for (const item of regenItems) {
    const lower = String(item?.headwordLower ?? item?.headword ?? '').toLowerCase()
    if (lower) regenByLower.set(lower, item)
  }
  const replaced = []
  const seen = new Set()
  const items = baseItems.map((item) => {
    const lower = String(item?.headwordLower ?? item?.headword ?? '').toLowerCase()
    seen.add(lower)
    const next = regenByLower.get(lower)
    if (!next) return item
    replaced.push(lower)
    return next
  })
  const appended = []
  for (const [lower, item] of regenByLower) {
    if (seen.has(lower)) continue
    items.push(item)
    appended.push(lower)
  }
  const now = Date.now()
  const meta = {
    ...(base?.meta ?? {}),
    ...(regen?.meta?.promptVersion ? { promptVersion: regen.meta.promptVersion } : { promptVersion: opts.promptVersion ?? 'v4.0-semantics-grouped' }),
    name: opts.name ?? `${base?.meta?.name ?? 'semantics'}（v4 重生成 ${replaced.length} 词）`,
  }
  const pack = {
    ...base,
    createdAt: base?.createdAt ?? now,
    items,
    meta,
    checksum: '',
  }
  pack.checksum = packChecksum(pack)
  return { pack, replaced: replaced.sort(), appended: appended.sort(), replacedCount: replaced.length, appendedCount: appended.length }
}

function main() {
  const args = process.argv.slice(2)
  const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
  const basePath = arg('--base', '')
  const regenPath = arg('--regen', '')
  const out = arg('--out', '')
  if (!basePath || !regenPath || !out) {
    console.error('用法: node tools/merge-semantics-packs.mjs --base <old.pack.json> --regen <regen.pack.json> --out <v4.pack.json> [--name "..."]')
    process.exit(1)
  }
  const base = JSON.parse(readFileSync(resolve(basePath), 'utf8'))
  const regen = JSON.parse(readFileSync(resolve(regenPath), 'utf8'))
  const result = mergeSemanticsPacks(base, regen, { name: arg('--name', '') || undefined })
  writeFileSync(resolve(out), JSON.stringify(result.pack, null, 2) + '\n')
  console.log(`[merge] base=${basePath} regen=${regenPath}`)
  console.log(`[merge] items=${result.pack.items.length} 替换=${result.replacedCount} 追加=${result.appendedCount} promptVersion=${result.pack.meta.promptVersion}`)
  console.log(`[merge] checksum=${result.pack.checksum.slice(0, 16)}… → ${out}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error('[fatal]', error.message); process.exit(1) }
}
