#!/usr/bin/env node
/**
 * 只补/重写 semantics pack 的 meaningMap.steps（引申链），不改 coreSenses/label。
 *
 * 用法：
 *   node tools/gen-steps.mjs --in data/packs/hongbaoshu/semantics-full-6702-v4.pack.json \
 *     --out data/packs/_staging/steps/full-pilot.pack.json \
 *     --base-url https://open.bigmodel.cn/api/paas/v4 --model glm-5.3-flash \
 *     --key-file .secrets/zhipu-key --batch 10 --concurrency 2 --limit 50
 *
 * 断点：同一 --out 已存在时，已含的 headword 会跳过（--resume 可读已有 shard）。
 * 合并：node tools/gen-steps.mjs --merge --base <base.pack> --steps <steps.pack> --out <out.pack>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname } from 'node:path'
import { STEP_BLACKLIST } from './audit-semantics-pack.mjs'

const args = process.argv.slice(2)
const arg = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : d
}
const has = (n) => args.includes(n)

const BLACK = /通读|义项|定名|归并|其中|综上|可见|分类|统计|归纳|标注|映射|判定|推断|总结|首先|其次|然后|释义|条释义|归为|归入|判为|分为|区分|其余|归类|拆分|划为|归到|检查|是否|来源|词源|源自|来自|出自|词根|希腊|拉丁|英语|法语|德语|→|->|推导/

const stable = (v) => {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stable(x))).join(',') + ']'
  if (t === 'object') {
    const k = Object.keys(v).filter((x) => v[x] !== undefined).sort()
    return '{' + k.map((x) => JSON.stringify(x) + ':' + stable(v[x])).join(',') + '}'
  }
  return 'null'
}

function checksumOf(items) {
  return createHash('sha256')
    .update(stable({ format: 'momo-pack', formatVersion: 1, kind: 'semantics', items }))
    .digest('hex')
}

function validSteps(steps) {
  if (!Array.isArray(steps)) return false
  if (steps.length < 2 || steps.length > 4) return false
  return steps.every((s) => typeof s === 'string' && s.trim().length >= 2 && s.trim().length <= 20 && !STEP_BLACKLIST.some((w) => s.includes(w)))
}

function parseJsonLoose(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  try { return JSON.parse(t) } catch {}
  const a = t.indexOf('{'), b = t.lastIndexOf('}')
  if (a >= 0 && b > a) {
    try { return JSON.parse(t.slice(a, b + 1)) } catch {}
  }
  return null
}

async function callProvider(cfg, system, user) {
  const url = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions'
  const body = {
    model: cfg.model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    max_tokens: 8192,
    stream: false,
  }
  if (cfg.jsonMode) body.response_format = { type: 'json_object' }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      })
      const txt = await res.text()
      if (!res.ok) {
        if (res.status === 400 && cfg.jsonMode) { cfg.jsonMode = false; continue }
        if (res.status === 429 || res.status >= 500) { if (attempt === 2) throw new Error('HTTP ' + res.status + ' retry exhausted'); await sleep(2000 * (attempt + 1)); continue }
        throw new Error('HTTP ' + res.status + ' ' + txt.slice(0, 200))
      }
      const j = JSON.parse(txt)
      const content = j?.choices?.[0]?.message?.content ?? ''
      const parsed = parseJsonLoose(content)
      if (!parsed) throw new Error('JSON parse failed: ' + String(content).slice(0, 120))
      return parsed
    } catch (e) {
      if (attempt === 2) throw e
      await sleep(1200 * (attempt + 1))
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function buildPrompt(wordItem, onlyMissing) {
  const senses = (wordItem.coreSenses ?? []).map((s) => `本义${s.index}「${s.label}」${s.note ? '：' + s.note : ''}`).join('\n')
  const cs = (wordItem.meaningMap ?? [])
    .filter((m) => (onlyMissing ? !(Array.isArray(m.steps) && m.steps.length >= 2) : true))
    .map((m) => {
      const label = senseLabel(wordItem, m.coreSenseIndex)
      return `c${m.meaningIndex}（${m.partOfSpeech ?? wordItem.partOfSpeech ?? ''}）${m.zh ?? m.meaning ?? ''} → 本义${m.coreSenseIndex}「${label}」`
    })
    .join('\n')
  const sys =
    '你是英汉词典编辑。只输出 JSON，不要解释。' +
    '任务：为每个 c 写 2–4 步「本义→该含义」的语义演变链（steps）。' +
    '每步 2–20 个汉字，必须是含义变化（如「图纸」→「按图施工的方案」→「计划」），' +
    '禁止任何推理过程/词典操作词（通读、义项、定名、归并、其中、综上、判断、可见、分类、统计、归纳、标注、映射、判定、推断、总结、释义、归为、归入、判为、分为、区分、其余、归类、拆分、划为、归到、检查、是否、来源、词源）。' +
    '不要照抄 label；起点可以就是本义。'
  const user =
    `单词：${wordItem.headword}\n${senses}\n各含义：\n${cs}\n\n` +
    '严格输出：{"items":[{"headword":"' + wordItem.headword + '","steps":[{"meaningIndex":1,"steps":["...","..."]}]}]}'
  return { sys, user }
}

function senseLabel(it, idx) {
  return (it.coreSenses ?? []).find((s) => s.index === idx)?.label ?? ''
}


function buildPromptBatch(items, onlyMissing) {
  const parts = items.map((it) => {
    const senses = (it.coreSenses ?? []).map((x) => `本义${x.index}「${x.label}」${x.note ? '：' + x.note : ''}`).join('；')
    const cs = (it.meaningMap ?? [])
      .filter((m) => (onlyMissing ? !(Array.isArray(m.steps) && m.steps.length >= 2) : true))
      .map((m) => {
        const label = senseLabel(it, m.coreSenseIndex)
        return `c${m.meaningIndex}(${m.partOfSpeech ?? ''})${m.zh ?? m.meaning ?? ''}→本义${m.coreSenseIndex}「${label}」`
      })
      .join(' | ')
    return `【${it.headword}】${senses}；含义：${cs}`
  }).join('\n')
  const sys =
    '你是英汉词典编辑。只输出 JSON，不要解释。' +
    '为每个单词的每个 c 写 2–4 步「本义→该含义」的语义演变链（steps）。' +
    '每步 2–20 个汉字，必须是含义变化，禁止推理/词典操作词（通读、义项、定名、归并、其中、综上、判断、可见、分类、统计、归纳、标注、映射、判定、推断、总结、释义、归为、归入、判为、分为、区分、其余、归类、拆分、划为、归到、检查、是否、来源、词源）。不要照抄 label。'
  const user =
    parts + '\n\n严格输出：{"items":[{"headword":"单词","steps":[{"meaningIndex":1,"steps":["...","..."]}]}]}'
  return { sys, user }
}

async function solveBatch(cfg, items, onlyMissing, stats) {
  if (!items.length) return []
  try {
    const { sys, user } = buildPromptBatch(items, onlyMissing)
    const parsed = await callProvider(cfg, sys, user)
    const by = new Map((parsed.items ?? []).map((x) => [String(x.headword ?? '').toLowerCase(), x]))
    const out = []
    for (const it of items) {
      const got = by.get(String(it.headword).toLowerCase())
      const steps = (got?.steps ?? []).filter((x) => validSteps(x.steps))
      if (steps.length) out.push({ headword: it.headword, headwordLower: String(it.headwordLower ?? it.headword).toLowerCase(), steps })
    }
    if (out.length === items.length) { stats.ok += items.length; return out }
    // 部分成功：成功的留下，失败的继续拆分
    stats.ok += out.length
    const okSet = new Set(out.map((x) => x.headwordLower))
    const rest = items.filter((it) => !okSet.has(String(it.headwordLower ?? it.headword).toLowerCase()))
    return [...out, ...(await solveBatch(cfg, rest, onlyMissing, stats))]
  } catch (e) {
    if (items.length === 1) {
      stats.failed++
      console.warn(`[gen-steps] ${items[0].headword} failed: ${String(e.message || e).slice(0, 100)}`)
      return []
    }
    const mid = Math.ceil(items.length / 2)
    const a = await solveBatch(cfg, items.slice(0, mid), onlyMissing, stats)
    const b = await solveBatch(cfg, items.slice(mid), onlyMissing, stats)
    return [...a, ...b]
  }
}

async function runGenerate() {
  const inFile = arg('--in')
  const outFile = arg('--out')
  if (!inFile || !outFile) {
    console.error('用法: node tools/gen-steps.mjs --in <pack> --out <staging> --base-url <url> --model <m> --key-file <f> [--batch 10] [--concurrency 2] [--limit N] [--offset N] [--all]')
    process.exit(1)
  }
  const cfg = {
    baseUrl: arg('--base-url', 'https://open.bigmodel.cn/api/paas/v4'),
    model: arg('--model', 'glm-5.3-flash'),
    key: (() => {
      const kf = arg('--key-file')
      if (kf) return readFileSync(kf, 'utf8').trim()
      if (process.env.AI_KEY) return process.env.AI_KEY.trim()
      throw new Error('缺少 --key-file 或 AI_KEY')
    })(),
    jsonMode: has('--json-mode'),
  }
  const BATCH = Math.max(1, Math.min(50, Number(arg('--batch', '10')) || 10))
  const CONC = Math.max(1, Math.min(8, Number(arg('--concurrency', '2')) || 2))
  const LIMIT = Number(arg('--limit', '0')) || 0
  const OFFSET = Number(arg('--offset', '0')) || 0
  const ONLY_MISSING = !has('--all')
  const SINGLE = has('--single')

  const pack = JSON.parse(readFileSync(inFile, 'utf8'))
  const all = (pack.items ?? []).filter((it) => (it.meaningMap ?? []).some((m) => !validSteps(m.steps)))
  const selected = all.slice(OFFSET, LIMIT ? OFFSET + LIMIT : undefined)
  const prev = existsSync(outFile) ? JSON.parse(readFileSync(outFile, 'utf8')) : { items: [] }
  const done = new Set((prev.items ?? []).map((x) => String(x.headwordLower ?? x.headword).toLowerCase()))
  const todo = selected.filter((it) => !done.has(String(it.headwordLower ?? it.headword).toLowerCase()))

  console.log(`[gen-steps] pack=${inFile} missingWords=${all.length} selected=${selected.length} todo=${todo.length} batch=${BATCH} concurrency=${CONC} model=${cfg.model}`)
  mkdirSync(dirname(outFile), { recursive: true })
  const out = { format: 'steps-shard', formatVersion: 1, source: inFile, model: cfg.model, createdAt: Date.now(), items: [...(prev.items ?? [])] }

  let cursor = 0
  const stats = { ok: 0, failed: 0 }
  async function worker() {
    while (cursor < todo.length) {
      const my = todo.slice(cursor, cursor + BATCH)
      cursor += my.length
      let got = []
      if (SINGLE) {
        for (const it of my) got.push(...(await solveBatch(cfg, [it], ONLY_MISSING, stats)))
      } else {
        got = await solveBatch(cfg, my, ONLY_MISSING, stats)
      }
      for (const g of got) out.items.push(g)
      out.items.sort((a, b) => (a.headwordLower < b.headwordLower ? -1 : a.headwordLower > b.headwordLower ? 1 : 0))
      writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n')
      console.log(`[gen-steps] progress ${out.items.length}/${selected.length} (ok=${stats.ok} failed=${stats.failed})`)
    }
  }
  await Promise.all(Array.from({ length: CONC }, () => worker()))
  writeFileSync(outFile, JSON.stringify(out, null, 1) + '\n')
  console.log(`[gen-steps] done items=${out.items.length} ok=${stats.ok} failed=${stats.failed} → ${outFile}`)
}

function runMerge() {
  const baseFile = arg('--base'), stepsFile = arg('--steps'), out = arg('--out')
  if (!baseFile || !stepsFile || !out) {
    console.error('用法: node tools/gen-steps.mjs --merge --base <base.pack> --steps <steps.pack> --out <out.pack>')
    process.exit(1)
  }
  const base = JSON.parse(readFileSync(baseFile, 'utf8'))
  const shard = JSON.parse(readFileSync(stepsFile, 'utf8'))
  const byWord = new Map((shard.items ?? []).map((x) => [String(x.headwordLower ?? x.headword).toLowerCase(), x]))
  let updated = 0
  for (const it of base.items ?? []) {
    const g = byWord.get(String(it.headwordLower ?? it.headword).toLowerCase())
    if (!g) continue
    const mm = new Map((g.steps ?? []).map((s) => [Number(s.meaningIndex), s.steps]))
    for (const m of it.meaningMap ?? []) {
      const st = mm.get(Number(m.meaningIndex))
      if (validSteps(st)) { m.steps = st; updated++ }
    }
  }
  const checksum = checksumOf(base.items)
  const pack = {
    ...base,
    createdAt: Date.now(),
    checksum,
    meta: {
      ...(base.meta ?? {}),
      stats: {
        ...(base.meta?.stats ?? {}),
        words: base.items.length,
        coreSenses: base.items.reduce((n, it) => n + (it.coreSenses?.length ?? 0), 0),
        mappedMeanings: base.items.reduce((n, it) => n + (it.meaningMap?.length ?? 0), 0),
      },
    },
  }
  writeFileSync(out, JSON.stringify(pack) + '\n')
  console.log(`[gen-steps] merged updatedMeaningMaps=${updated} words=${pack.items.length} checksum=${checksum.slice(0, 16)}… → ${out}`)
}

if (has('--merge')) runMerge()
else await runGenerate()
