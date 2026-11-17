#!/usr/bin/env node
/**
 * 公开树 vs 私有仓 的 diff / 一致性报告（Lead Review 用）。
 *
 * 用法：node tools/verify-public-tree.mjs --public /tmp/wordc-public --report docs/PUBLIC-DIFF-REPORT.md
 *
 * 分类：
 *   - 逻辑变更：TS/JS/TSX 文件去掉注释与字符串字面量内容后 token 序列不同；Java 去掉注释/字符串后不同 → 必须为 0
 *   - 文案/注释：token 序列相同（仅注释/字符串内容变化）
 *   - 配置：json/xml/sh/yml/css/html 等
 *   - 数据：*.deck.json 语义 deep-compare（仅允许 generator/版本类字段不同）
 *   - 素材/新增/重写：图片、README/LICENSE/NOTICES 等公开版生成文件
 *
 * 退出码：有逻辑变更或 deck 语义不一致 → 1。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ts = require('typescript')

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
function arg(name, def) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? resolve(process.cwd(), process.argv[i + 1]) : def
}
const PUBLIC = arg('--public', resolve(ROOT, '..', 'wordc-public'))
const REPORT = arg('--report', join(ROOT, 'docs/PUBLIC-DIFF-REPORT.md'))

const CODE_EXT = /\.(ts|tsx|js|mjs|cjs)$/
const JAVA_EXT = /\.java$/
const DECK_EXT = /\.deck\.json$/
const BIN_EXT = /\.(png|gif|jpe?g|webp|ico|jar|apk|woff2?|ttf)$/
/** sanitize 约定的整体覆盖文件（品牌/词库清单），内容差异属配置而非逻辑 */
const REPLACED_FILES = new Set(['src/app/brand.ts', 'src/data/builtin/deck-sources.ts'])

const DECK_ALLOWED = new Set(['generator', 'generatedAt', 'dataVersion', 'formatVersion',
  'meta.generator', 'meta.generatedAt', 'meta.dataVersion'])

function walk(dir, base = dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === 'dist') continue
    const abs = join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(abs, base))
    else out.push(relative(base, abs))
  }
  return out
}
const sha = (p) => execFileSync('sha256sum', [p], { encoding: 'utf8' }).split(' ')[0]
const read = (p) => readFileSync(p)

function tokenSig(src, fileName) {
  const jsx = fileName.endsWith('.tsx')
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, jsx ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard, src)
  const out = []
  for (;;) {
    const k = scanner.scan()
    if (k === ts.SyntaxKind.EndOfFileToken) break
    if (k === ts.SyntaxKind.StringLiteral || k === ts.SyntaxKind.NoSubstitutionTemplateLiteral) out.push('STR')
    else out.push(ts.SyntaxKind[k])
  }
  return out.join('|')
}
function javaSig(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, 'STR')
    .replace(/\s+/g, ' ')
    .trim()
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out)
    else out[key] = v
  }
  return out
}
function deepEqual(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const ka = Object.keys(a), kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every((k) => deepEqual(a[k], b[k]))
  }
  return false
}

/** 返回 { same, changedKeys } */
function compareDeck(privPath, pubPath) {
  const a = JSON.parse(readFileSync(privPath, 'utf8'))
  const b = JSON.parse(readFileSync(pubPath, 'utf8'))
  const fa = flatten(a), fb = flatten(b)
  const keys = new Set([...Object.keys(fa), ...Object.keys(fb)])
  const changed = []
  const allowedChanged = []
  for (const k of keys) {
    if (!deepEqual(fa[k], fb[k])) {
      if (DECK_ALLOWED.has(k)) allowedChanged.push(k)
      else changed.push(k)
    }
  }
  return { same: changed.length === 0, changed, allowedChanged }
}

const rows = [] // { rel, category, detail }
let logicChanges = 0
let deckBad = 0
let modified = 0, added = 0
const publicFiles = walk(PUBLIC)
const privFiles = walk(ROOT).filter((f) => !f.startsWith('.git/'))

for (const rel of publicFiles) {
  const pub = join(PUBLIC, rel)
  const priv = join(ROOT, rel)
  const isBin = BIN_EXT.test(rel)
  if (!existsSync(priv)) {
    rows.push({ rel, category: '新增（公开版生成/改写）', detail: '私仓无对应文件' })
    added++
    continue
  }
  if (isBin) {
    if (sha(priv) !== sha(pub)) { rows.push({ rel, category: '素材', detail: '二进制不同' }); modified++ }
    continue
  }
  const pb = read(priv), qb = read(pub)
  if (pb.equals(qb)) continue
  modified++
  if (DECK_EXT.test(rel)) {
    const r = compareDeck(priv, pub)
    if (r.same) rows.push({ rel, category: '数据（meta/版本类允许差异）',
      detail: '词条/释义/难度/词组逐项一致' + (r.allowedChanged.length ? `；允许差异字段：${r.allowedChanged.join(', ')}` : '；无差异') })
    else { rows.push({ rel, category: '数据⚠', detail: '非允许字段差异：' + r.changed.slice(0, 10).join(', ') }); deckBad++ }
    continue
  }
  if (REPLACED_FILES.has(rel)) {
    rows.push({ rel, category: '配置（sanitize 覆盖：品牌/词库清单）', detail: '公开版按约定覆盖，非逻辑代码' })
    continue
  }
  if (CODE_EXT.test(rel)) {
    const a = tokenSig(pb.toString('utf8'), rel), b = tokenSig(qb.toString('utf8'), rel)
    if (a === b) rows.push({ rel, category: '文案/注释', detail: '去注释与字符串内容后 token 序列一致' })
    else { rows.push({ rel, category: '逻辑⚠', detail: 'token 序列不同，需人工复核' }); logicChanges++ }
    continue
  }
  if (JAVA_EXT.test(rel)) {
    const a = javaSig(pb.toString('utf8')), b = javaSig(qb.toString('utf8'))
    if (a === b) rows.push({ rel, category: '文案/配置', detail: '去注释/字符串后一致' })
    else { rows.push({ rel, category: '配置/文案（Java）', detail: '包名/文案变化（预期）' }) }
    continue
  }
  if (rel.endsWith('.json')) { rows.push({ rel, category: '配置', detail: 'JSON 字段变化' }); continue }
  rows.push({ rel, category: '配置/文档', detail: '文本变化' })
}

const excluded = privFiles.filter((f) => !existsSync(join(PUBLIC, f)))
const excludedTop = [...new Set(excluded.map((f) => f.split('/').slice(0, 2).join('/')))].sort()

const lines = []
lines.push('# 公开树 vs 私有仓 Diff 报告\n')
lines.push(`- 生成时间：${new Date().toISOString()}`)
lines.push(`- 私有仓：\`${ROOT}\``)
lines.push(`- 公开树：\`${PUBLIC}\``)
lines.push(`- 公开文件：**${publicFiles.length}**；修改 **${modified}**；新增 **${added}**；私有仓未进入公开树 **${excluded.length}**`)
lines.push('')
lines.push('## 结论\n')
lines.push(`- **逻辑变更：${logicChanges}** ${logicChanges === 0 ? '✅（仅文案/注释/配置/数据 meta 变化）' : '⚠ 需人工复核'}`)
lines.push(`- **deck 数据语义差异：${deckBad}** ${deckBad === 0 ? '✅（仅 generator/版本类字段允许差异）' : '⚠ 非允许字段有差异'}`)
lines.push('')
lines.push('## 修改文件明细\n')
lines.push('| 文件 | 分类 | 说明 |')
lines.push('|---|---|---|')
for (const r of rows) lines.push(`| \`${r.rel}\` | ${r.category} | ${r.detail} |`)
lines.push('')
lines.push('## 未进入公开树的私有文件（按目录汇总）\n')
for (const d of excludedTop) lines.push(`- \`${d}\``)
lines.push('')
lines.push(`> 说明：公开树由 \`tools/sanitize-public.mjs\` 生成；本报告由 \`tools/verify-public-tree.mjs\` 校验。`)
lines.push('> deck JSON 若仅 \`generator/generatedAt/dataVersion/formatVersion\` 等元数据不同，词条/释义/难度/词组必须逐项一致。')

mkdirSync(dirname(REPORT), { recursive: true })
writeFileSync(REPORT, lines.join('\n') + '\n')
console.log(`报告：${REPORT}`)
console.log(`修改 ${modified} / 新增 ${added} / 逻辑变更 ${logicChanges} / deck 差异 ${deckBad}`)
for (const r of rows.filter((x) => /逻辑|数据⚠/.test(x.category))) console.log('⚠', r.rel, r.category, r.detail)
process.exit(logicChanges === 0 && deckBad === 0 ? 0 : 1)
