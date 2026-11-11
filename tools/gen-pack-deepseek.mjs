#!/usr/bin/env node
/**
 * 批量生成 momo-pack（DeepSeek）——task-73。
 *
 * 与 App 内生成共用契约：prompt 直接 import `src/data/ai/prompts.ts`（Node ≥22.18/24 的 type stripping；
 * 旧 Node 可用 `--experimental-strip-types`），输出经同款 JSON 校验后写成 `momo-pack` v1。
 *
 * 用法：
 *   node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang --kinds examples,phrases,mnemonics \
 *     --limit 200 --out /tmp/wordc-200.pack.json
 *   # 分片/断点：--shard 1/12 --resume
 *
 * Key：优先 env `DEEPSEEK_API_KEY`，否则读 `.secrets/deepseek-key`；**永不打印**。
 */
import { decodeDeckWords, splitMeanings } from './lib/deck-words.mjs'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRepairPrompt, buildSystemPrompt, buildUserPrompt, PROMPT_VERSION, CONTENT_LIMITS, buildSystemPromptV2, buildUserPromptV2, PROMPT_VERSION_V2, WC_CONTENT_LIMITS, buildSystemPromptV3, buildUserPromptV3, buildSemanticsRepairPromptV3, PROMPT_VERSION_V3 } from '../src/data/ai/prompts.ts'
import { aggregateSemanticsLabels, normalizeCoreSenseLabel } from '../src/data/ai/semantics.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
function arg(name, def) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}
const DECK = arg('--deck', 'kaoyan-2027-dagang')
const KIND_ARG = arg('--kind', null)
const KINDS_RAW = (KIND_ARG ?? String(arg('--kinds', 'examples,phrases,mnemonics'))).split(',').map((s) => s.trim()).filter(Boolean)
const SEMANTICS = KINDS_RAW.includes('semantics') || args.includes('--semantics')
const KINDS = KINDS_RAW.filter((k) => k !== 'semantics')
const LIMIT = Number(arg('--limit', '0')) || 0
const OFFSET = Number(arg('--offset', '0')) || 0
const SHARD = arg('--shard', '')
const OUT = resolve(arg('--out', join(ROOT, 'packs/pregen/wordc-dagang.pack.json')))
const RESUME = args.includes('--resume')
const DRY = args.includes('--dry-run')
const CONCURRENCY = Math.max(1, Math.min(5, Number(arg('--concurrency', '3')) || 3))
const PER_MEANING = args.includes('--per-meaning')
const MIN_MEANINGS = Number(arg('--min-meanings', SEMANTICS ? '2' : '0')) || 0
const LIMIT_WORDS = Number(arg('--limit-words', '0')) || 0
const WC_BATCH = Math.max(1, Math.min(20, Number(arg('--wc-batch', '10')) || 10))
const SEM_BATCH = Math.max(1, Math.min(20, Number(arg('--sem-batch', '10')) || 10))
const JSON_MODE = args.includes('--no-json-mode') ? false : String(arg('--json-mode', 'true')) !== 'false'
const API_KEY_FILE = arg('--api-key-file', '')
const API_KEY_ENV = arg('--api-key-env', '')
const MAX_TOKENS = Math.max(256, Math.min(16384, Number(arg('--max-tokens', '4096')) || 4096))
const TIMEOUT_MS = Math.max(5000, Number(arg('--timeout-ms', '180000')) || 180000)
const EXCLUDE_WORDS = new Set(
  String(arg('--exclude-words', '')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
)
const SPLIT_DUNHAO = args.includes('--split-dunhao')
const CHAPTER_CONTAINS = String(arg('--chapter-contains', '')).trim()
const INCLUDE_CHAPTERS = String(arg('--include-chapters', '')).split(',').map((x) => x.trim()).filter(Boolean)
const INCLUDE_WORDS = new Set(
  String(arg('--include-words', '')).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
)
const BATCH = Math.max(1, Math.min(50, Number(arg('--batch', '20')) || 20))
const MAX_COST = Number(arg('--max-cost', '40')) || 40
const MODEL = arg('--model', 'deepseek-chat')
const BASE_URL = arg('--base-url', 'https://api.deepseek.com')
const PRICE = { inputPerM: 2, outputPerM: 8 } // 元/百万 tokens（DeepSeek 公开价，按官网为准）
const VALID_KINDS = new Set(['examples', 'phrases', 'mnemonics'])
for (const k of KINDS) if (!VALID_KINDS.has(k)) throw new Error(`未知 kind：${k}`)
if (SEMANTICS && KINDS.length > 0) throw new Error('semantics 需单独生成（不要与 examples/phrases/mnemonics 混跑）')

function buildChatUrl(base) {
  const b = String(base).replace(/\/+$/, '')
  if (b.endsWith('/chat/completions')) return b
  if (/\/v\d+$/.test(b)) return `${b}/chat/completions`
  return `${b}/v1/chat/completions`
}

function readKey() {
  if (API_KEY_ENV) {
    const fromEnv = process.env[API_KEY_ENV]
    if (!fromEnv || !fromEnv.trim()) throw new Error(`--api-key-env ${API_KEY_ENV} 未设置或为空`)
    return fromEnv.trim()
  }
  if (API_KEY_FILE) {
    if (!existsSync(API_KEY_FILE)) throw new Error(`--api-key-file 不存在：${API_KEY_FILE}`)
    return readFileSync(API_KEY_FILE, 'utf8').trim()
  }
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim()
  const p = join(ROOT, '.secrets/deepseek-key')
  if (existsSync(p)) return readFileSync(p, 'utf8').trim()
  throw new Error('缺少 Key：设置 DEEPSEEK_API_KEY、--api-key-file 或 .secrets/deepseek-key')
}

/** 读内置紧凑 deck（columns + words），含义拆分/无释义兜底口径见 tools/lib/deck-words.mjs */
function loadWords() {
  const file = join(ROOT, 'src/data/builtin', `${DECK}.deck.json`)
  if (!existsSync(file)) throw new Error(`找不到词库：${file}`)
  const json = JSON.parse(readFileSync(file, 'utf8'))
  if (!json?.deck?.id) json.deck = { id: DECK }
  return decodeDeckWords(json, { splitDunhao: SPLIT_DUNHAO })
}

function plan(words) {
  let list = words.slice(OFFSET)
  if (LIMIT > 0) list = list.slice(0, LIMIT)
  if (SHARD) {
    const [i, n] = SHARD.split('/').map(Number)
    if (!(i >= 1 && n >= 1 && i <= n)) throw new Error('--shard 格式应为 i/n')
    const size = Math.ceil(list.length / n)
    list = list.slice((i - 1) * size, i * size)
  }
  return list
}

function existingHeadwords() {
  if (!RESUME || !existsSync(OUT)) return new Set()
  try {
    const pack = JSON.parse(readFileSync(OUT, 'utf8'))
    return new Set((pack.items ?? []).map((it) => String(it.headwordLower ?? it.headword).toLowerCase()))
  } catch { return new Set() }
}

function stable(v) {
  if (v === null || v === undefined) return 'null'
  const t = typeof v
  if (t === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null'
  if (t === 'boolean') return v ? 'true' : 'false'
  if (t === 'string') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stable(x))).join(',') + ']'
  if (t === 'object') {
    const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}'
  }
  return 'null'
}
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

function extractJson(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim()
  try { return JSON.parse(t) } catch {}
  const start = t.indexOf('{')
  if (start < 0) throw new Error('响应不含 JSON')
  let depth = 0
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++
    else if (t[i] === '}') { depth--; if (depth === 0) return JSON.parse(t.slice(start, i + 1)) }
  }
  throw new Error('JSON 不完整')
}

function normalizeItems(raw, targets, kind) {
  const allowed = new Map(targets.map((t) => [t.headword.toLowerCase(), t]))
  const out = []
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const hw = String(it?.headword ?? '').trim()
    const t = allowed.get(hw.toLowerCase())
    if (!t) continue
    const item = { headword: t.headword, headwordLower: t.headwordLower }
    if (kind === 'examples' && Array.isArray(it.examples)) {
      item.examples = it.examples
        .filter((e) => e && typeof e.en === 'string' && typeof e.cn === 'string' && e.en.trim() && e.cn.trim())
        .slice(0, CONTENT_LIMITS.examples)
        .map((e) => ({ en: e.en.trim(), cn: e.cn.trim() }))
    }
    if (kind === 'phrases' && Array.isArray(it.phrases)) {
      item.phrases = it.phrases
        .filter((p) => p && typeof p.en === 'string' && typeof p.cn === 'string' && p.en.trim() && p.cn.trim())
        .slice(0, CONTENT_LIMITS.phrases)
        .map((p) => ({ en: p.en.trim(), cn: p.cn.trim(), ...(Number.isInteger(p.meaningIndex) ? { meaningIndex: p.meaningIndex } : {}) }))
    }
    if (kind === 'mnemonics' && Array.isArray(it.mnemonics)) {
      item.mnemonics = it.mnemonics
        .filter((m) => m && typeof m.text === 'string' && m.text.trim() && ['root', 'assoc', 'story'].includes(m.type))
        .slice(0, CONTENT_LIMITS.mnemonics)
        .map((m) => ({ type: m.type, text: m.text.trim().slice(0, 120) }))
    }
    if (Object.keys(item).length > 2) out.push(item)
  }
  return out
}

async function callDeepSeek(key, system, user, signal) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  const started = Date.now()
  const res = await fetch(buildChatUrl(BASE_URL), {
    method: 'POST',
    signal: controller.signal,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.3,
      max_tokens: MAX_TOKENS,
      ...(JSON_MODE ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  })
  const text = await res.text()
  clearTimeout(timer)
  console.log(`[req] ${res.status} ${Date.now() - started}ms url=${buildChatUrl(BASE_URL)} out=${text.length}B`)
  if (res.status === 429) throw Object.assign(new Error('RATE_LIMIT'), { code: 'RATE_LIMIT', retryable: true })
  if (res.status === 401 || res.status === 403) throw Object.assign(new Error('AUTH'), { code: 'AUTH', retryable: false })
  if (res.status === 402) throw Object.assign(new Error('QUOTA'), { code: 'QUOTA', retryable: false })
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'HTTP', retryable: res.status >= 500 })
  const json = JSON.parse(text)
  const content = json?.choices?.[0]?.message?.content ?? ''
  return { content, usage: json?.usage ?? {} }
}

async function generateBatch(key, system, kind, targets) {
  const limit = CONTENT_LIMITS[kind]
  let user = buildUserPrompt({ kind, targets, limit })
  let lastErr
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const { content, usage } = await callDeepSeek(key, system, user)
      try {
        const raw = extractJson(content)
        return { items: normalizeItems(raw, targets, kind), usage }
      } catch (e) {
        lastErr = e
        user = buildRepairPrompt(user, e.message)
      }
    } catch (e) {
      lastErr = e
      if (!e.retryable || attempt >= 2) throw e
      const wait = e.code === 'RATE_LIMIT' ? [1000, 2000, 4000][attempt] : [500, 1000][attempt] || 1000
      await new Promise((r) => setTimeout(r, wait))
    }
  }
  throw lastErr
}

async function main() {
  const key = readKey()
  const all = loadWords()
  let selected = plan(all)
  if (INCLUDE_WORDS.size > 0) selected = selected.filter((w) => INCLUDE_WORDS.has(w.headwordLower))
  if (CHAPTER_CONTAINS) selected = selected.filter((w) => String(w.chapter ?? '').includes(CHAPTER_CONTAINS))
  if (INCLUDE_CHAPTERS.length > 0) {
    selected = selected.filter((w) => INCLUDE_CHAPTERS.some((part) => String(w.chapter ?? '').includes(part)))
  }
  if (EXCLUDE_WORDS.size > 0) selected = selected.filter((w) => !EXCLUDE_WORDS.has(w.headwordLower))
  if (MIN_MEANINGS > 0) selected = selected.filter((w) => w.meanings.length >= MIN_MEANINGS)
  if (LIMIT_WORDS > 0) selected = selected.slice(0, LIMIT_WORDS)
  const seen = existingHeadwords()
  const words = selected.filter((w) => !seen.has(w.headwordLower))
  if (SEMANTICS) {
    const cTotal = words.reduce((n, w) => n + w.meanings.length, 0)
    if (DRY) { console.log(`[dry-run] semantics：${words.length} 个多含义词 / ${cTotal} 个 c；每请求 ${SEM_BATCH} 词`); return }
    await runSemantics(key, words, selected.length)
    return
  }
  if (PER_MEANING) {
    if (DRY) { console.log(`[dry-run] per-meaning：${words.length} 词 / ${words.reduce((n, w) => n + w.meanings.length, 0)} 个 c；每请求 ${WC_BATCH} 词`); return }
    await runPerMeaning(key, words, selected.length)
    return
  }
  console.log(`[gen-pack] deck=${DECK} 词=${selected.length} 待生成=${words.length} kinds=${KINDS.join(',')} batch=${BATCH} concurrency=${CONCURRENCY}`)
  const batches = Math.ceil(words.length / BATCH)
  if (DRY) {
    console.log(`[dry-run] 预计请求 ${batches * KINDS.length} 次（每批 ${BATCH} 词 × ${KINDS.length} kinds）`)
    return
  }
  const system = buildSystemPrompt()
  const merged = new Map()
  let usage = { prompt_tokens: 0, completion_tokens: 0 }
  let costYuan = 0
  let failed = 0
  let done = 0
  const total = batches * KINDS.length
  const queue = []
  for (let b = 0; b < batches; b++) {
    const slice = words.slice(b * BATCH, (b + 1) * BATCH)
    for (const kind of KINDS) queue.push({ slice, kind })
  }
  async function worker() {
    while (queue.length) {
      const job = queue.shift()
      if (!job) return
      const { slice, kind } = job
      const targets = slice.map((w) => ({ headword: w.headword, headwordLower: w.headwordLower, meanings: w.meanings.map((m) => ({ id: m.id, cn: m.cn })), existing: { examples: 0, phrases: 0, mnemonics: 0 } }))
      try {
        const r = await generateBatch(key, system, kind, targets)
        usage.prompt_tokens += Number(r.usage?.prompt_tokens ?? 0)
        usage.completion_tokens += Number(r.usage?.completion_tokens ?? 0)
        costYuan = (usage.prompt_tokens / 1e6) * PRICE.inputPerM + (usage.completion_tokens / 1e6) * PRICE.outputPerM
        for (const it of r.items) {
          const key = it.headwordLower
          const cur = merged.get(key) ?? { headword: it.headword, headwordLower: key }
          if (it.examples) cur.examples = [...(cur.examples ?? []), ...it.examples]
          if (it.phrases) cur.phrases = [...(cur.phrases ?? []), ...it.phrases]
          if (it.mnemonics) cur.mnemonics = [...(cur.mnemonics ?? []), ...it.mnemonics]
          merged.set(key, cur)
        }
      } catch (e) {
        failed++
        console.error(`[fail] kind=${kind} words=${slice[0]?.headword}..${slice.at(-1)?.headword} code=${e.code ?? 'ERR'} msg=${String(e.message).slice(0, 120)}`)
        if (e.code === 'AUTH' || e.code === 'QUOTA') throw e
      } finally {
        done++
        console.log(`[${done}/${total}] kind=${kind} words=${slice[0]?.headword}..${slice.at(-1)?.headword} tokens(in/out)=${usage.prompt_tokens}/${usage.completion_tokens} cost=¥${costYuan.toFixed(3)}`)
        if (costYuan > MAX_COST) throw new Error(`成本超限：¥${costYuan.toFixed(2)} > ${MAX_COST}`)
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker())
  await Promise.all(workers)
  const items = [...merged.values()].map((it) => {
    if (it.examples) it.examples = it.examples.slice(0, 8)
    if (it.phrases) it.phrases = it.phrases.slice(0, 8)
    if (it.mnemonics) it.mnemonics = it.mnemonics.slice(0, 4)
    return it
  })
  const kind = KINDS.length === 1 ? KINDS[0] : 'mixed'
  const createdAt = Date.now()
  const checksum = sha256(stable({ format: 'momo-pack', formatVersion: 1, kind, items }))
  const pack = {
    format: 'momo-pack', formatVersion: 1, kind, createdAt,
    generator: `wordc-ai-cli@${(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version)}`,
    meta: {
      name: `WordC AI pack（${DECK} · ${words.length} 词）`,
      source: 'ai', provider: 'deepseek', model: MODEL, promptVersion: PROMPT_VERSION,
      scope: { kind: 'deck', deckId: DECK, offset: OFFSET, limit: LIMIT, shard: SHARD || null },
      createdBy: 'WordC', checksumAlgo: 'sha256',
      stats: { words: items.length, failedBatches: failed, tokensIn: usage.prompt_tokens, tokensOut: usage.completion_tokens, costYuan: Number(costYuan.toFixed(4)) },
    },
    items,
    checksum,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(pack, null, 2) + '\n')
  console.log(`[done] 写出 ${OUT}`)
  console.log(`[done] items=${items.length} 失败批次=${failed} tokens(in/out)=${usage.prompt_tokens}/${usage.completion_tokens} 实际花费≈¥${costYuan.toFixed(4)} checksum=${checksum.slice(0, 16)}…`)
  for (const word of words.slice(0, 5)) {
    const it = merged.get(word.headwordLower)
    console.log(`[sample] ${word.headword}: examples=${it?.examples?.length ?? 0} phrases=${it?.phrases?.length ?? 0} mnemonics=${it?.mnemonics?.length ?? 0}`)
  }
}


// ============================================================================
// --per-meaning（w-c 级）：每个含义独立内容，prompt v2
// ============================================================================

/** 校验 v2 输出：headwordLower + meaningIndex 必须命中输入，内容数组做字段/条数过滤 */
function normalizeWcItems(raw, targetMap) {
  const out = []
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const hw = String(it?.headword ?? '').trim().toLowerCase()
    const idx = Number(it?.meaningIndex)
    if (!Number.isInteger(idx) || idx < 1) continue
    const info = targetMap.get(`${hw}#${idx}`)
    if (!info) continue // 不串词/不串 c
    const item = { headword: info.headword, headwordLower: info.headwordLower, meaningIndex: idx }
    if (it.skipped === true) { item.skipped = true; out.push(item); continue }
    if (Array.isArray(it.examples)) {
      item.examples = it.examples
        .filter((e) => e && typeof e.en === 'string' && typeof e.cn === 'string' && e.en.trim() && e.cn.trim())
        .slice(0, WC_CONTENT_LIMITS.examples)
        .map((e) => ({ en: e.en.trim(), cn: e.cn.trim() }))
    }
    if (Array.isArray(it.phrases)) {
      item.phrases = it.phrases
        .filter((p) => p && typeof p.en === 'string' && typeof p.cn === 'string' && p.en.trim() && p.cn.trim())
        .slice(0, WC_CONTENT_LIMITS.phrases)
        .map((p) => ({ en: p.en.trim(), cn: p.cn.trim() }))
    }
    if (Array.isArray(it.mnemonics)) {
      item.mnemonics = it.mnemonics
        .filter((m) => m && typeof m.text === 'string' && m.text.trim() && ['root', 'assoc', 'story'].includes(m.type))
        .slice(0, WC_CONTENT_LIMITS.mnemonics)
        .map((m) => ({ type: m.type, text: m.text.trim().slice(0, 120) }))
    }
    out.push(item)
  }
  return out
}

async function runPerMeaning(key, words, totalWords) {
  const system = buildSystemPromptV2()
  const batchWords = WC_BATCH
  const batches = []
  for (let i = 0; i < words.length; i += batchWords) batches.push(words.slice(i, i + batchWords))
  const merged = new Map()
  let usage = { prompt_tokens: 0, completion_tokens: 0 }
  let costYuan = 0
  let failed = 0
  let done = 0
  let missing = 0
  console.log(`[wc] words=${words.length}/${totalWords} c=${words.reduce((n, w) => n + w.meanings.length, 0)} batchWords=${batchWords} concurrency=${CONCURRENCY}`)
  const queue = [...batches]
  async function worker() {
    while (queue.length) {
      const slice = queue.shift()
      if (!slice) return
      const targets = []
      const targetMap = new Map()
      for (const w of slice) {
        w.meanings.forEach((m, i) => {
          const target = { headword: w.headword, headwordLower: w.headwordLower, meaningIndex: i + 1, meaning: { cn: m.cn } }
          targets.push(target)
          targetMap.set(`${w.headwordLower}#${i + 1}`, { headword: w.headword, headwordLower: w.headwordLower, cn: m.cn })
        })
      }
      let user = buildUserPromptV2(targets)
      let lastErr
      try {
        let parsed = null
        for (let attempt = 0; attempt <= 2 && !parsed; attempt++) {
          try {
            const { content, usage: u } = await callDeepSeek(key, system, user)
            usage.prompt_tokens += Number(u?.prompt_tokens ?? 0)
            usage.completion_tokens += Number(u?.completion_tokens ?? 0)
            costYuan = (usage.prompt_tokens / 1e6) * PRICE.inputPerM + (usage.completion_tokens / 1e6) * PRICE.outputPerM
            try { parsed = normalizeWcItems(extractJson(content), targetMap) }
            catch (e) { lastErr = e; user = buildRepairPrompt(user, e.message) }
          } catch (e) {
            lastErr = e
            if (!e.retryable || attempt >= 2) throw e
            const wait = e.code === 'RATE_LIMIT' ? [1000, 2000, 4000][attempt] : [500, 1000][attempt] || 1000
            await new Promise((r) => setTimeout(r, wait))
          }
        }
        if (!parsed) throw lastErr ?? new Error('no parsed items')
        const got = new Set(parsed.map((it) => `${it.headwordLower}#${it.meaningIndex}`))
        for (const [k] of targetMap) if (!got.has(k)) missing++
        for (const it of parsed) merged.set(`${it.headwordLower}#${it.meaningIndex}`, it)
      } catch (e) {
        failed++
        console.error(`[wc-fail] words=${slice[0]?.headword}..${slice.at(-1)?.headword} code=${e.code ?? 'ERR'} msg=${String(e.message).slice(0, 120)}`)
        if (e.code === 'AUTH' || e.code === 'QUOTA') throw e
      } finally {
        done++
        console.log(`[wc ${done}/${batches.length}] words=${slice[0]?.headword}..${slice.at(-1)?.headword} cost=¥${costYuan.toFixed(3)} missingC=${missing}`)
        if (costYuan > MAX_COST) throw new Error(`成本超限：¥${costYuan.toFixed(2)} > ${MAX_COST}`)
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker())
  await Promise.all(workers)
  const sorted = [...merged.values()].sort((a, b) => (a.headwordLower < b.headwordLower ? -1 : a.headwordLower > b.headwordLower ? 1 : a.meaningIndex - b.meaningIndex))
  // 同一词不同 c 间去重（句/词组/助记）；去重后无内容的 c 记为 skipped
  const seenByWord = new Map()
  let skippedC = 0
  const items = []
  for (const it of sorted) {
    if (it.skipped) { skippedC++; continue }
    const seen = seenByWord.get(it.headwordLower) ?? { examples: new Set(), phrases: new Set(), mnemonics: new Set() }
    seenByWord.set(it.headwordLower, seen)
    const keep = {}
    if (it.examples) {
      const list = it.examples.filter((e) => { const k = e.en.trim().toLowerCase(); if (seen.examples.has(k)) return false; seen.examples.add(k); return true })
      if (list.length) keep.examples = list
    }
    if (it.phrases) {
      const list = it.phrases.filter((p) => { const k = p.en.trim().toLowerCase(); if (seen.phrases.has(k)) return false; seen.phrases.add(k); return true })
      if (list.length) keep.phrases = list
    }
    if (it.mnemonics) {
      const list = it.mnemonics.filter((m) => { const k = `${m.type}:${m.text.trim()}`; if (seen.mnemonics.has(k)) return false; seen.mnemonics.add(k); return true })
      if (list.length) keep.mnemonics = list
    }
    if (!keep.examples && !keep.phrases && !keep.mnemonics) { skippedC++; continue }
    // 目标词出现检查：例句/词组里至少一条包含目标词（原形/变形含子串），否则视为串义 → skipped
    const enTexts = [...(keep.examples ?? []).map((e) => e.en), ...(keep.phrases ?? []).map((p) => p.en)].join(' ').toLowerCase()
    if (!enTexts.includes(it.headwordLower)) { skippedC++; continue }
    items.push({ headword: it.headword, headwordLower: it.headwordLower, meaningIndex: it.meaningIndex, ...keep })
  }
  const createdAt = Date.now()
  const checksum = sha256(stable({ format: 'momo-pack', formatVersion: 1, kind: 'mixed', items }))
  const pack = {
    format: 'momo-pack', formatVersion: 1, kind: 'mixed', createdAt,
    generator: `wordc-ai-cli@${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`,
    meta: {
      name: `WordC w-c pack（${DECK} · ${words.length} 词 / ${items.length} c）`,
      source: 'ai', provider: 'deepseek', model: MODEL, promptVersion: PROMPT_VERSION_V2,
      scope: { kind: 'deck', deckId: DECK, perMeaning: true, limitWords: LIMIT_WORDS, minMeanings: MIN_MEANINGS },
      createdBy: 'WordC', checksumAlgo: 'sha256',
      stats: { words: words.length, meanings: items.length, skippedMeanings: skippedC, failedBatches: failed, missingMeanings: missing, tokensIn: usage.prompt_tokens, tokensOut: usage.completion_tokens, costYuan: Number(costYuan.toFixed(4)) },
    },
    items, checksum,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(pack, null, 2) + '\n')
  console.log(`[wc-done] 写出 ${OUT}`)
  console.log(`[wc-done] items=${items.length} c skipped=${skippedC} 失败批次=${failed} 未返回 c=${missing} tokens(in/out)=${usage.prompt_tokens}/${usage.completion_tokens} 花费≈¥${costYuan.toFixed(4)} checksum=${checksum.slice(0, 16)}…`)
}


// ============================================================================
// --kind semantics（本义/引申链；等 task-76 prompt v3 就绪后接线）
// ============================================================================

/**
 * CLI 骨架：筛选多含义词 → （待接入）调用 prompt v3 → 输出 kind='semantics' 的 momo-pack。
 * 契约（task-76/75）：
 *   item: { headword, headwordLower, coreSenses:[{index,label,note?,origin?,confidence}], meaningMap:[{meaningIndex,coreSenseIndex,note?}] }
 *   只对 ≥2 个 c 的词生成；meaningMap 必须覆盖该词全部 c（1..N）。
 */
/** v3.4 原始输出的 label 一致性统计（分组归一口径与 semantics.ts 一致） */
function semanticsLabelStats(raw) {
  let groups = 0
  let multiGroups = 0
  let exactGroups = 0
  for (const it of Array.isArray(raw?.items) ? raw.items : []) {
    const byLabel = new Map()
    for (const m of Array.isArray(it?.meanings) ? it.meanings : []) {
      const rawLabel = String(m?.coreSenseLabel ?? m?.coreSenseNote ?? '').trim()
      const key = normalizeCoreSenseLabel(rawLabel) || '__unlabeled__'
      const arr = byLabel.get(key) ?? []
      arr.push(rawLabel)
      byLabel.set(key, arr)
    }
    for (const arr of byLabel.values()) {
      groups += 1
      if (arr.length >= 2) {
        multiGroups += 1
        if (new Set(arr).size === 1) exactGroups += 1
      }
    }
  }
  return { groups, multiGroups, exactGroups }
}

/** 本义/引申链（prompt v3）：每个多含义词一条 item（coreSenses+meaningMap） */
async function runSemantics(key, words, totalWords) {
  const system = buildSystemPromptV3()
  const batches = []
  for (let i = 0; i < words.length; i += SEM_BATCH) batches.push(words.slice(i, i + SEM_BATCH))
  const merged = new Map()
  let usage = { prompt_tokens: 0, completion_tokens: 0 }
  let costYuan = 0
  let failed = 0
  let done = 0
  let invalidCount = 0
  let skippedBatch = 0
  let labelGroups = 0
  let labelMultiGroups = 0
  let labelExactGroups = 0
  console.log(`[sem] words=${words.length}/${totalWords} batchWords=${SEM_BATCH} concurrency=${CONCURRENCY} prompt=${PROMPT_VERSION_V3}`)
  const queue = [...batches]
  async function worker() {
    while (queue.length) {
      const slice = queue.shift()
      if (!slice) return
      const wordMap = new Map()
      for (const w of slice) {
        wordMap.set(w.headwordLower, {
          headword: w.headword,
          headwordLower: w.headwordLower,
          count: w.meanings.length,
        })
      }
      const targets = slice.map((w) => ({
        headword: w.headword,
        headwordLower: w.headwordLower,
        meanings: w.meanings.map((m, i) => ({ meaningIndex: i + 1, cn: m.cn })),
      }))
      let user = buildUserPromptV3(targets)
      let lastErr = null
      try {
        let parsed = null
        for (let attempt = 0; attempt <= 2 && !parsed; attempt++) {
          try {
            const { content, usage: u } = await callDeepSeek(key, system, user)
            usage.prompt_tokens += Number(u?.prompt_tokens ?? 0)
            usage.completion_tokens += Number(u?.completion_tokens ?? 0)
            costYuan = (usage.prompt_tokens / 1e6) * PRICE.inputPerM + (usage.completion_tokens / 1e6) * PRICE.outputPerM
            try {
              const rawJson = extractJson(content)
              const ls = semanticsLabelStats(rawJson)
              const agg = aggregateSemanticsLabels({ json: rawJson, targets })
              if (agg.error) { lastErr = new Error(agg.error); user = buildSemanticsRepairPromptV3(user, agg.error); continue }
              const got = [...agg.byKey.values()]
              const missing = Math.max(0, slice.length - got.length)
              parsed = { items: got, stats: ls, missing }
            } catch (e) { user = buildSemanticsRepairPromptV3(user, e.message); lastErr = e }
          } catch (e) {
            lastErr = e
            if (!e.retryable || attempt >= 2) throw e
            const wait = e.code === 'RATE_LIMIT' ? [1000, 2000, 4000][attempt] : [500, 1000][attempt] || 1000
            await new Promise((r) => setTimeout(r, wait))
          }
        }
        if (!parsed) throw lastErr ?? new Error('no parsed semantics')
        invalidCount += parsed.missing
        skippedBatch += parsed.missing
        labelGroups += parsed.stats.groups
        labelMultiGroups += parsed.stats.multiGroups
        labelExactGroups += parsed.stats.exactGroups
        for (const it of parsed.items) merged.set(it.headwordLower, it)
      } catch (e) {
        failed++
        console.error(`[sem-fail] words=${slice[0]?.headword}..${slice.at(-1)?.headword} code=${e.code ?? 'ERR'} msg=${String(e.message).slice(0, 120)}`)
        if (e.code === 'AUTH' || e.code === 'QUOTA') throw e
      } finally {
        done++
        console.log(`[sem ${done}/${batches.length}] words=${slice[0]?.headword}..${slice.at(-1)?.headword} cost=¥${costYuan.toFixed(3)} mapped=${merged.size} invalid=${invalidCount}`)
        if (costYuan > MAX_COST) throw new Error(`成本超限：¥${costYuan.toFixed(2)} > ${MAX_COST}`)
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker())
  await Promise.all(workers)
  const items = [...merged.values()].sort((a, b) => (a.headwordLower < b.headwordLower ? -1 : a.headwordLower > b.headwordLower ? 1 : 0))
  const cores = items.reduce((n, it) => n + it.coreSenses.length, 0)
  const maps = items.reduce((n, it) => n + it.meaningMap.length, 0)
  const createdAt = Date.now()
  const checksum = sha256(stable({ format: 'momo-pack', formatVersion: 1, kind: 'semantics', items }))
  const pack = {
    format: 'momo-pack', formatVersion: 1, kind: 'semantics', createdAt,
    generator: `wordc-ai-cli@${JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version}`,
    meta: {
      name: `WordC 本义/引申链 pack（${DECK} · ${items.length} 词）`,
      source: 'ai', provider: 'deepseek', model: MODEL, promptVersion: PROMPT_VERSION_V3,
      scope: { kind: 'deck', deckId: DECK, semantics: true, limitWords: LIMIT_WORDS, minMeanings: MIN_MEANINGS },
      createdBy: 'WordC', checksumAlgo: 'sha256',
      stats: {
        words: words.length, coveredWords: items.length, coreSenses: cores, mappedMeanings: maps,
        inputMeanings: words.reduce((n, w) => n + w.meanings.length, 0),
        failedBatches: failed, invalidItems: invalidCount, labelGroups, labelMultiGroups, labelExactGroups, tokensIn: usage.prompt_tokens, tokensOut: usage.completion_tokens,
        costYuan: Number(costYuan.toFixed(4)),
      },
    },
    items, checksum,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(pack, null, 2) + '\n')
  console.log(`[sem-done] 写出 ${OUT}`)
  console.log(`[sem-done] items=${items.length} coreSenses=${cores} mapped=${maps} invalid=${invalidCount} 失败批次=${failed} tokens(in/out)=${usage.prompt_tokens}/${usage.completion_tokens} 花费≈¥${costYuan.toFixed(4)} checksum=${checksum.slice(0, 16)}…`)
}


main().catch((e) => {
  console.error('[fatal]', String(e.message).slice(0, 200))
  process.exit(1)
})
