#!/usr/bin/env node
/**
 * 词根词缀词源批量生成器（0.5.3）。
 *
 * 用法：
 *   node tools/gen-root-etymology.mjs --deck kaoyan-2027-dagang \
 *     --offset 0 --limit 50 --batch 10 --concurrency 2 \
 *     --out /tmp/root-000.bundle.json
 *
 * Key：优先 env DEEPSEEK_API_KEY，否则读 .secrets/deepseek-key；绝不打印。
 * 输出：momo-root-etymology-bundle（无 checksum，导入时可省略；正式包可后续补）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeDeckWords } from './lib/deck-words.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const arg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const has = (name) => args.includes(name)

const DECK = arg('--deck', 'kaoyan-2027-dagang')
const OFFSET = Math.max(0, Number(arg('--offset', '0')) || 0)
const LIMIT = Math.max(0, Number(arg('--limit', '0')) || 0)
const BATCH = Math.min(20, Math.max(1, Number(arg('--batch', '10')) || 10))
const CONCURRENCY = Math.min(8, Math.max(1, Number(arg('--concurrency', '2')) || 2))
const OUT = resolve(arg('--out', `/tmp/root-${DECK}-${OFFSET}.bundle.json`))
const KEY_FILE = resolve(arg('--key-file', join(ROOT, '.secrets/deepseek-key')))
const BASE_URL = String(arg('--base-url', 'https://api.deepseek.com')).replace(/\/$/, '')
const MODEL = String(arg('--model', 'deepseek-chat'))
const DRY = has('--dry-run')
const PRICE_INPUT = Number(arg('--price-input', '2')) // 元 / 1M input tokens
const PRICE_OUTPUT = Number(arg('--price-output', '8')) // 元 / 1M output tokens
let promptTokens = 0
let completionTokens = 0

const deckFile = join(ROOT, 'src/data/builtin', `${DECK}.deck.json`)
if (!existsSync(deckFile)) { console.error(`词库不存在：${deckFile}`); process.exit(1) }
const deck = JSON.parse(readFileSync(deckFile, 'utf8'))
let words = decodeDeckWords(deck, { splitDunhao: false })
if (OFFSET) words = words.slice(OFFSET)
if (LIMIT) words = words.slice(0, LIMIT)

const sources = words.map((w) => ({
  wordId: `${DECK}:${w.headword}`,
  headword: w.headword,
  meanings: w.meanings.map((m) => m.cn),
}))

function readKey() {
  if (DRY) return ''
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim()
  if (!existsSync(KEY_FILE)) throw new Error('缺少 Key：设置 DEEPSEEK_API_KEY 或 .secrets/deepseek-key')
  return readFileSync(KEY_FILE, 'utf8').trim()
}

const SYSTEM = `你是英语词源/构词分析助手。为给定单词输出严格 JSON，不要任何解释。
要求：
1. 只输出 {"items":[...]}，每项对应输入 wordId，不能漏、不能多。
2. 每项字段：wordId, parts, etymology, composition。
3. parts 是数组，每项 {type,text,meaning,note?}；type 只能是 prefix/root/suffix/other；**meaning 必填且不能为空**（中文或英文短语均可）；note 可选。
4. etymology 用中文简述来源/演变；composition 用中文写「前缀+词根/词根→义」的整体拼接。
5. 不可拆的单词也至少给一个 part（type=root，text=单词，meaning=核心义），不要编造不存在的词根；不确定时用 other + 说明。
6. 不输出 markdown、代码块、注释。`

function userPrompt(batch) {
  return `请为以下 ${batch.length} 个单词生成词根词缀词源 JSON：\n${JSON.stringify(batch, null, 2)}`
}

function stripJson(text) {
  let s = String(text ?? '').trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  const a = s.indexOf('{'); const b = s.lastIndexOf('}')
  if (a >= 0 && b > a) s = s.slice(a, b + 1)
  return JSON.parse(s)
}

async function chat(key, batch) {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: userPrompt(batch) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2,
    }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`)
  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 返回为空')
  const usage = data?.usage ?? {}
  return { parsed: stripJson(content), usage }
}

function normalize(raw, batch) {
  const byId = new Map()
  for (const item of raw?.items ?? []) {
    if (item && typeof item.wordId === 'string') byId.set(item.wordId, item)
  }
  const out = []
  for (const source of batch) {
    const item = byId.get(source.wordId)
    if (!item) { out.push({ source, error: 'missing' }); continue }
    const parts = Array.isArray(item.parts) ? item.parts : []
    const cleanParts = parts
      .map((p) => ({
        type: ['prefix', 'root', 'suffix', 'other'].includes(p?.type) ? p.type : 'other',
        text: String(p?.text ?? '').trim(),
        meaning: String(p?.meaning ?? '').trim(),
        ...(p?.note ? { note: String(p.note).trim() } : {}),
      }))
      .filter((p) => p.text && p.meaning)
    if (cleanParts.length === 0) { out.push({ source, error: 'no-valid-parts' }); continue }
    out.push({
      wordId: source.wordId,
      headword: source.headword,
      deckId: DECK,
      parts: cleanParts,
      ...(item.etymology ? { etymology: String(item.etymology).trim() } : {}),
      ...(item.composition ? { composition: String(item.composition).trim() } : {}),
    })
  }
  return out
}

async function runBatch(key, batch, index) {
  let lastErr
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { parsed: raw, usage } = await chat(key, batch)
      promptTokens += Number(usage.prompt_tokens ?? 0) || 0
      completionTokens += Number(usage.completion_tokens ?? 0) || 0
      const items = normalize(raw, batch)
      const errors = items.filter((x) => x.error)
      console.log(`[batch ${index}] ok=${items.length - errors.length} failed=${errors.length}${errors.length ? ` (${errors.slice(0, 2).map((e) => e.source.headword).join(',')})` : ''}`)
      return items
    } catch (e) {
      lastErr = e
      console.error(`[batch ${index}] attempt ${attempt} failed: ${String(e.message).slice(0, 160)}`)
      await new Promise((r) => setTimeout(r, 1200 * attempt))
    }
  }
  return batch.map((source) => ({ source, error: String(lastErr?.message ?? 'failed').slice(0, 120) }))
}

function chunks(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function main() {
  if (sources.length === 0) { console.error('没有可生成词'); process.exit(1) }
  console.log(`[root-etym] deck=${DECK} offset=${OFFSET} words=${sources.length} batch=${BATCH} concurrency=${CONCURRENCY} out=${OUT}`)
  if (DRY) {
    console.log(`[dry-run] 预计请求 ${Math.ceil(sources.length / BATCH)} 次，示例：`, JSON.stringify(sources.slice(0, 2), null, 2))
    return
  }
  const key = readKey()
  const batches = chunks(sources, BATCH)
  const results = new Array(batches.length)
  let cursor = 0
  async function worker() {
    while (cursor < batches.length) {
      const i = cursor++
      results[i] = await runBatch(key, batches[i], i + 1)
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()))
  const flat = results.flat()
  const items = flat.filter((x) => !x.error).map((x) => ({
    wordId: x.wordId,
    headword: x.headword,
    deckId: x.deckId,
    rootEtymology: {
      parts: x.parts,
      ...(x.etymology ? { etymology: x.etymology } : {}),
      ...(x.composition ? { composition: x.composition } : {}),
      source: 'ai',
      updatedAt: Date.now(),
      model: MODEL,
    },
  }))
  const failed = flat.filter((x) => x.error).map((x) => ({ wordId: x.source.wordId, headword: x.source.headword, reason: x.error }))
  const payload = {
    format: 'momo-root-etymology-bundle',
    formatVersion: 1,
    version: '0.5.3',
    createdAt: Date.now(),
    generator: 'tools/gen-root-etymology.mjs',
    counts: { items: items.length },
    items,
  }
  mkdirSync(dirname(OUT), { recursive: true })
  writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n')
  const failOut = OUT.replace(/\.bundle\.json$/, '.failed.json')
  if (failed.length) writeFileSync(failOut, JSON.stringify({ failed }, null, 2) + '\n')
  const cost = (promptTokens / 1e6) * PRICE_INPUT + (completionTokens / 1e6) * PRICE_OUTPUT
  console.log(`[root-etym] done items=${items.length} failed=${failed.length} out=${OUT}${failed.length ? ` failedOut=${failOut}` : ''}`)
  console.log(`[root-etym] tokens input=${promptTokens} output=${completionTokens} cost≈¥${cost.toFixed(4)} (price input=¥${PRICE_INPUT}/M output=¥${PRICE_OUTPUT}/M)`)
  console.error(`[usage] input=${promptTokens} output=${completionTokens}`)
}

main().catch((e) => { console.error('[root-etym] fatal:', e.message); process.exit(1) })
