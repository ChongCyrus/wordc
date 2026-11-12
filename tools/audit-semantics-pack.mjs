#!/usr/bin/env node
/**
 * task-97 · 本义/引申链 pack 审计工具（离线、纯读文件）
 *
 * 按 docs/SEMANTICS-FORMAT.md §5 规则扫描 `data/packs/**\/*.pack.json` 的 semantics items：
 * - label：2–6 汉字、黑名单、标点/数字、「的」堆叠、词内重复/近义未合并；
 * - gloss（coreSense.note）：1–40 字；
 * - origin：≤20 字且必须含 `=`/`即`/`意为`/`指`，不得以「源自/来自/出自」开头；
 * - steps：2–4 步，每步 2–20 字，黑名单；
 * - 结构：coreSenses 1–4、index 连续唯一、meaningMap 覆盖/无重复/引用有效、无孤儿本义。
 *
 * 输出：`--out` 下每包 `<pack>.violations.jsonl`（违规词，供 task-99 重生成）+ `audit-report.json`。
 *
 * 用法：
 *   node tools/audit-semantics-pack.mjs --dir data/packs --out /tmp/audit
 *   node tools/audit-semantics-pack.mjs --pack data/packs/dagang/semantics-v37.pack.json --out /tmp/audit
 *   node tools/audit-semantics-pack.mjs --deck kaoyan-hongbaoshu-2025 --fix-report
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

export const LABEL_RE = /^[\u4e00-\u9fff]{1,6}(?:[A-Za-z]|…[\u4e00-\u9fff]{1,4})?$/
/** 短语/子串模式（不按单字误杀：检查/看法/可能性/朝外看 合法） */
export const LABEL_BLACKLIST = [
  '看是否', '查看是否', '是否指', '检查是否', '核对',
  '源自', '源古', '来自', '出自', '词源', '词根',
  '希腊', '拉丁', '英语', '法语', '德语', '古英语',
  '→', '->',
]
export const STEP_BLACKLIST = [
  '是否', '看', '检查', '判断', '确认', '核对', '来源',
  '源自', '来自', '出自', '词源', '词根', '希腊', '拉丁', '英语', '法语', '德语', '→', '->', '推导',
  // task-112：steps 里的「元推理」词（给学习者看的应是语义链，不是标注过程）
  '通读', '义项', '定名', '归并', '其中', '综上', '可见', '分类', '统计',
  '归纳', '标注', '映射', '判定', '推断', '总结', '首先', '其次', '然后',
]
const DOUBLE_DE = /的[^的]{0,6}的/
const PUNCT = /[，。；：、！？"'“”‘’（）()\[\]【】<>《》\d]/
const ORIGIN_OK = /(=|＝|即|意为|意思是|指)/
const ORIGIN_BAD_PREFIX = /^(源自|来自|出自)/
/**
 * 放宽的 origin 规则（Lead task-97 补充）：不强制 `=`/`即`，
 * 只要**含中文解释**（如「古法语 bracchium 臂」「拉丁 basis 基础」）即通过；
 * 剥离语言名/来源词/外文后无中文（如「源自希腊 basis」「词根 tract」「希腊语」）才违规。
 */
const ORIGIN_LANGUAGE_TOKENS =
  /(源自|来自|出自|词源|词根|古英语|中古英语|古法语|希腊语|拉丁语|英语|法语|德语|希腊|拉丁|北欧|阿拉伯语|阿拉伯|意大利语|意大利|西班牙语|西班牙|荷兰语|荷兰|俄语|日语|汉语|中文)/g
function originHasChineseExplanation(origin) {
  const text = String(origin ?? '')
  // 带 `=`/`即` 等解释连接符：有中文即认为有解释（避免「拉丁 Italia=意大利」被语言名词误删）
  if (/(=|＝|意为|意思是|即|指)/.test(text) && /[\u4e00-\u9fff]/.test(text)) {
    return !/^(源自|来自|出自)/.test(text)
  }
  const stripped = text
    .replace(ORIGIN_LANGUAGE_TOKENS, '')
    // 去掉外文/数字/标点/箭头等（保留中文）
    .replace(/[A-Za-z0-9\s=＝+\-.,，。:：;；()（）"'“”‘’\/→~`!?！？、]/g, '')
  return /[\u4e00-\u9fff]/.test(stripped)
}
const CONFIDENCE = ['high', 'medium', 'low']

export function normalizeLabel(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .replace(/[\s\u3000]+/g, '')
    .trim()
    .replace(/的$/, '')
}

function editDistanceAtMost1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false
  if (a === b) return true
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1)
  if (a.length > b.length) return a.slice(i + 1) === b.slice(i)
  return a.slice(i) === b.slice(i + 1)
}

const FIX_HINT = {
  E_LABEL_FORMAT: '重写为 2–6 个汉字含义（不要解释句/词源/检查步骤）',
  E_LABEL_PUNCT: '去掉标点/数字，只保留汉字含义',
  E_LABEL_BANNED: 'label 含检查/词源/语言名/箭头等说明性文字，改写为含义（如「基础」「图纸」）',
  E_LABEL_DE: 'label 含「…的…的」堆叠，改写为短含义',
  E_LABEL_DUP: '同词内重复本义，合并为一条',
  E_LABEL_SIMILAR: '同词内近义本义未合并，合并为较短者',
  E_GLOSS_MISSING: '补 1–40 字本义解释',
  E_GLOSS_LEN: 'gloss 超过 40 字，压缩为一句',
  E_ORIGIN_LEN: 'origin 超过 20 字',
  E_ORIGIN_NO_EXPLAIN: 'origin 必须解释含义（如「拉丁 basis=基础」），否则省略',
  E_SENSE_COUNT: 'coreSenses 需 1–4 项',
  E_SENSE_INDEX: 'coreSenses.index 需从 1 连续唯一',
  E_SENSE_ORPHAN: '本义未被任何含义引用，删除',
  E_MAP_INDEX: 'meaningMap.coreSenseIndex 无效',
  E_MAP_DUP: 'meaningMap.meaningIndex 重复',
  E_STEPS_COUNT: 'steps 需 2–4 步',
  E_STEPS_LEN: 'steps 每步需 2–20 字',
  E_STEPS_BANNED: 'steps 含检查/词源/箭头等词，改写为语义演变',
  E_CONFIDENCE: 'confidence 仅 high/medium/low',
}

/** 审计单个 semantics item；返回 violations（不含 headword） */
export function auditSemanticsItem(item) {
  const violations = []
  const add = (code, field, value, extra = {}) => {
    violations.push({ code, field, value: String(value ?? ''), ...extra })
  }
  const coreSenses = Array.isArray(item?.coreSenses) ? item.coreSenses : []
  const meaningMap = Array.isArray(item?.meaningMap) ? item.meaningMap : []
  if (coreSenses.length < 1 || coreSenses.length > 4) add('E_SENSE_COUNT', 'structure', coreSenses.length)
  const indexes = coreSenses.map((sense) => Number(sense?.index))
  const sorted = [...indexes].sort((a, b) => a - b)
  if (indexes.length > 0) {
    const contiguous = sorted.every((value, index) => Number.isInteger(value) && value === index + 1)
    if (!contiguous || new Set(indexes).size !== indexes.length) add('E_SENSE_INDEX', 'structure', indexes.join(','))
  }

  // label / gloss / origin / confidence
  coreSenses.forEach((sense) => {
    const label = String(sense?.label ?? '').trim()
    if (!LABEL_RE.test(label)) add('E_LABEL_FORMAT', 'coreLabel', label)
    else if (PUNCT.test(label)) add('E_LABEL_PUNCT', 'coreLabel', label)
    else if (LABEL_BLACKLIST.some((word) => label.includes(word))) add('E_LABEL_BANNED', 'coreLabel', label)
    else if (DOUBLE_DE.test(label)) add('E_LABEL_DE', 'coreLabel', label)
    const gloss = String(sense?.note ?? sense?.gloss ?? '').trim()
    if (!gloss) add('E_GLOSS_MISSING', 'note', label)
    else if (gloss.length > 40) add('E_GLOSS_LEN', 'note', gloss.slice(0, 60))
    const origin = String(sense?.origin ?? '').trim()
    if (origin) {
      if (origin.length > 20) add('E_ORIGIN_LEN', 'origin', origin)
      else if (!originHasChineseExplanation(origin)) add('E_ORIGIN_NO_EXPLAIN', 'origin', origin)
    }
    if (sense?.confidence && !CONFIDENCE.includes(String(sense.confidence))) {
      add('E_CONFIDENCE', 'confidence', sense.confidence)
    }
  })

  // 词内 label 去重/近义未合并
  const normalized = coreSenses.map((sense) => normalizeLabel(sense?.label))
  for (let i = 0; i < normalized.length; i += 1) {
    for (let j = i + 1; j < normalized.length; j += 1) {
      const a = normalized[i]
      const b = normalized[j]
      if (!a || !b) continue
      if (a === b) add('E_LABEL_DUP', 'coreLabel', `${a} / ${b}`)
      else if (a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a))) {
        add('E_LABEL_SIMILAR', 'coreLabel', `${a} / ${b}`)
      } else if (editDistanceAtMost1(a, b)) add('W_LABEL_SIMILAR', 'coreLabel', `${a} / ${b}`) // 编辑距离≤1：仅 warning（§2.4 不自动合并）
    }
  }

  // meaningMap：引用/重复/孤儿
  const used = new Set()
  const seenMeaning = new Set()
  meaningMap.forEach((entry) => {
    const index = Number(entry?.coreSenseIndex)
    if (!Number.isInteger(index) || index < 1 || index > coreSenses.length) {
      add('E_MAP_INDEX', 'meaningMap', `${entry?.meaningIndex}→${entry?.coreSenseIndex}`)
    } else used.add(index)
    if (seenMeaning.has(Number(entry?.meaningIndex))) add('E_MAP_DUP', 'meaningMap', entry?.meaningIndex)
    seenMeaning.add(Number(entry?.meaningIndex))
    const steps = Array.isArray(entry?.steps) ? entry.steps.map((step) => String(step).trim()).filter(Boolean) : []
    if (steps.length > 0) {
      if (steps.length < 2 || steps.length > 4) add('E_STEPS_COUNT', 'steps', steps.join(' → '))
      for (const step of steps) {
        if (step.length < 2 || step.length > 20) add('E_STEPS_LEN', 'steps', step)
        if (STEP_BLACKLIST.some((word) => step.includes(word))) add('E_STEPS_BANNED', 'steps', step)
      }
    }
  })
  coreSenses.forEach((sense, index) => {
    if (!used.has(index + 1)) add('E_SENSE_ORPHAN', 'structure', String(sense?.label ?? index + 1))
  })
  // task-97 补充：旧 v3 per-c 的 coreSenseLabel（可能仍在 payload/meanings 里，链上括号来源）
  for (const raw of collectLegacyCoreLabels(item)) {
    const label = raw.trim()
    if (!LABEL_RE.test(label)) violations.push({ code: 'E_LEGACY_LABEL_FORMAT', field: 'legacyCoreLabel', value: raw })
    else if (PUNCT.test(label)) violations.push({ code: 'E_LEGACY_LABEL_PUNCT', field: 'legacyCoreLabel', value: raw })
    else if (LABEL_BLACKLIST.some((word) => label.includes(word))) {
      violations.push({ code: 'E_LEGACY_LABEL_BANNED', field: 'legacyCoreLabel', value: raw })
    } else if (DOUBLE_DE.test(label)) violations.push({ code: 'E_LEGACY_LABEL_DE', field: 'legacyCoreLabel', value: raw })
  }
  return violations
}

/** 递归收集旧 v3 per-c coreSenseLabel（item.payload / item.meanings 等任意层级） */
export function collectLegacyCoreLabels(node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return []
  const out = []
  for (const [key, value] of Object.entries(node)) {
    if (key === 'coreSenseLabel' && typeof value === 'string' && value.trim()) out.push(value)
    else if (value && typeof value === 'object') out.push(...collectLegacyCoreLabels(value, depth + 1))
  }
  return out
}

function walkPackFiles(dir) {
  const files = []
  if (!existsSync(dir)) return files
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) files.push(...walkPackFiles(path))
    else if (name.endsWith('.pack.json')) files.push(path)
  }
  return files
}

/** 审计一个 pack 文件内容，返回统计 + 违规词记录 */
export function auditPack(filePath, pack) {
  const items = Array.isArray(pack?.items) ? pack.items : []
  const semanticsItems = items.filter((item) => Array.isArray(item?.coreSenses) && item.coreSenses.length > 0)
  const records = []
  const byCode = {}
  const byWarning = {}
  for (const item of semanticsItems) {
    const violations = auditSemanticsItem(item)
    if (violations.length === 0) continue
    const hard = violations.filter((violation) => violation.code.startsWith('E_'))
    for (const violation of violations) {
      if (violation.code.startsWith('E_')) byCode[violation.code] = (byCode[violation.code] ?? 0) + 1
      else byWarning[violation.code] = (byWarning[violation.code] ?? 0) + 1
    }
    if (hard.length === 0) continue
    records.push({
      pack: basename(filePath),
      deckId: pack?.meta?.deckId ?? '',
      headword: item.headword ?? '',
      headwordLower: item.headwordLower ?? String(item.headword ?? '').toLowerCase(),
      violations,
    })
  }
  const words = semanticsItems.length
  // 按类别统计（唯一词数），便于 task-99 分批：label 硬违规优先，origin/steps 可批量修复或重生成
  const labelCodes = new Set(['E_LABEL_FORMAT', 'E_LABEL_PUNCT', 'E_LABEL_BANNED', 'E_LABEL_DE', 'E_LABEL_DUP', 'E_LABEL_SIMILAR', 'E_LEGACY_LABEL_FORMAT', 'E_LEGACY_LABEL_PUNCT', 'E_LEGACY_LABEL_BANNED', 'E_LEGACY_LABEL_DE'])
  const originCodes = new Set(['E_ORIGIN_LEN', 'E_ORIGIN_NO_EXPLAIN'])
  const stepsCodes = new Set(['E_STEPS_COUNT', 'E_STEPS_LEN', 'E_STEPS_BANNED'])
  const structureCodes = new Set(['E_SENSE_COUNT', 'E_SENSE_INDEX', 'E_SENSE_ORPHAN', 'E_MAP_INDEX', 'E_MAP_DUP', 'E_CONFIDENCE'])
  const glossCodes = new Set(['E_GLOSS_MISSING', 'E_GLOSS_LEN'])
  const byCategory = { label: 0, origin: 0, steps: 0, structure: 0, gloss: 0 }
  const byField = { coreLabel: 0, legacyCoreLabel: 0, steps: 0, origin: 0, note: 0, structure: 0 }
  let violationEntries = 0
  let labelOrStepsWords = 0
  let labelStepsOriginWords = 0
  for (const record of records) {
    violationEntries += record.violations.length
    const fields = new Set(record.violations.map((violation) => violation.field))
    for (const field of fields) if (field in byField) byField[field] += 1
    const hasLabel = fields.has('coreLabel') || fields.has('legacyCoreLabel')
    const hasSteps = fields.has('steps')
    if (hasLabel || hasSteps) labelOrStepsWords += 1
    if (hasLabel || hasSteps || fields.has('origin')) labelStepsOriginWords += 1
    const codes = new Set(record.violations.map((violation) => violation.code))
    if ([...codes].some((code) => labelCodes.has(code))) byCategory.label += 1
    if ([...codes].some((code) => originCodes.has(code))) byCategory.origin += 1
    if ([...codes].some((code) => stepsCodes.has(code))) byCategory.steps += 1
    if ([...codes].some((code) => structureCodes.has(code))) byCategory.structure += 1
    if ([...codes].some((code) => glossCodes.has(code))) byCategory.gloss += 1
  }
  return {
    file: filePath,
    name: basename(filePath),
    kind: pack?.kind ?? '',
    deckId: pack?.meta?.deckId ?? '',
    promptVersion: pack?.meta?.promptVersion ?? '',
    words,
    violatingWords: records.length,
    violationRate: words > 0 ? Number(((records.length / words) * 100).toFixed(2)) : 0,
    byCategory,
    byField,
    byWarning,
    labelOrStepsWords,
    labelStepsOriginWords,
    violationEntries,
    byCode,
    records,
  }
}

function main() {
  const args = process.argv.slice(2)
  const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
  const outDir = resolve(arg('--out', '/tmp/audit'))
  const deckFilter = String(arg('--deck', '')).trim()
  const fixReport = args.includes('--fix-report')
  const packArgs = String(arg('--pack', '')).split(',').map((s) => s.trim()).filter(Boolean)
  const dir = arg('--dir', 'data/packs')
  const files = packArgs.length > 0 ? packArgs.map((file) => resolve(file)) : walkPackFiles(resolve(dir))
  const semanticsFiles = files.filter((file) => existsSync(file))
  mkdirSync(outDir, { recursive: true })
  const report = { generatedAt: new Date().toISOString(), outDir, packs: [], totals: { packs: 0, words: 0, violatingWords: 0, byCode: {} } }
  for (const file of semanticsFiles) {
    const pack = JSON.parse(readFileSync(file, 'utf8'))
    if (deckFilter && pack?.meta?.deckId !== deckFilter) continue
    if (!(Array.isArray(pack?.items) && pack.items.some((item) => item?.coreSenses?.length))) continue // 跳过纯内容 pack
    const audit = auditPack(file, pack)
    if (fixReport) {
      for (const record of audit.records) {
        record.violations = record.violations.map((violation) => ({ ...violation, fix: FIX_HINT[violation.code] ?? '' }))
      }
    }
    const rel = relative(process.cwd(), file)
    const jsonl = join(outDir, `${audit.name.replace(/\.pack\.json$/, '')}.violations.jsonl`)
    writeFileSync(jsonl, audit.records.map((record) => JSON.stringify(record)).join('\n') + (audit.records.length ? '\n' : ''))
    const { records, ...summary } = audit
    report.packs.push({ ...summary, jsonl })
    report.totals.packs += 1
    report.totals.words += audit.words
    report.totals.violatingWords += audit.violatingWords
    for (const [code, count] of Object.entries(audit.byCode)) report.totals.byCode[code] = (report.totals.byCode[code] ?? 0) + count
    report.totals.byCategory ??= { label: 0, origin: 0, steps: 0, structure: 0, gloss: 0 }
    for (const [key, count] of Object.entries(audit.byCategory)) report.totals.byCategory[key] += count
    report.totals.byField ??= { coreLabel: 0, legacyCoreLabel: 0, steps: 0, origin: 0, note: 0, structure: 0 }
    for (const [key, count] of Object.entries(audit.byField)) report.totals.byField[key] += count
    report.totals.violationEntries = (report.totals.violationEntries ?? 0) + audit.violationEntries
    report.totals.labelOrStepsWords = (report.totals.labelOrStepsWords ?? 0) + audit.labelOrStepsWords
    report.totals.labelStepsOriginWords = (report.totals.labelStepsOriginWords ?? 0) + audit.labelStepsOriginWords
    console.log(
      `[audit] ${rel}: words=${audit.words} 违规词=${audit.violatingWords} (${audit.violationRate}%) 条目=${audit.violationEntries} label∪steps=${audit.labelOrStepsWords} 字段=${JSON.stringify(audit.byField)}`,
    )
    console.log(`        分类=${JSON.stringify(audit.byCategory)} codes=${JSON.stringify(audit.byCode)}`)
    console.log(`        → ${jsonl}`)
  }
  report.totals.rate = report.totals.words > 0 ? Number(((report.totals.violatingWords / report.totals.words) * 100).toFixed(2)) : 0
  writeFileSync(join(outDir, 'audit-report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(
    `[audit] 总计：packs=${report.totals.packs} words=${report.totals.words} 违规词=${report.totals.violatingWords} (${report.totals.rate}%) 条目=${report.totals.violationEntries ?? 0} label∪steps=${report.totals.labelOrStepsWords ?? 0} 字段=${JSON.stringify(report.totals.byField)}`,
  )
  console.log(`[audit] report: ${join(outDir, 'audit-report.json')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) { console.error('[fatal]', error.message); process.exit(1) }
}
