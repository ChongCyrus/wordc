#!/usr/bin/env node
/** 0.4.1-B 多对象：5词/请求 mock items、按wordId、job results/cursor、缺失单对象回退。不调真实 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[bmo] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const reqs = []
await page.route('**/chat/completions', async (route) => {
  const body = route.request().postData() ?? ''
  const multi = body.includes('一次生成以下')
  const ids = [...body.matchAll(/kaoyan-2027-dagang:[a-z0-9-]+/g)].map((m) => m[0])
  reqs.push({ multi, ids: [...new Set(ids)] })
  let content
  if (multi) {
    const unique = [...new Set(ids)]
    const omit = unique[unique.length - 1]
    content = JSON.stringify({ items: unique.filter((id) => id !== omit).map((id) => ({ wordId: id, examples: [{ en: `QA example for ${id}`, cn: 'QA例句' }] })) })
  } else {
    content = JSON.stringify({ items: [{ wordId: 'kaoyan-2027-dagang:elicit', headword: 'elicit', examples: [{ en: 'QA fallback example', cn: 'QA回退例句' }] }] })
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) })
})
const setAi = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = [['ai.enabled', true], ['ai.provider', 'openai-compatible'], ['ai.baseUrl', 'https://api.deepseek.com'], ['ai.model', 'deepseek-chat'], ['ai.apiKey', 'sk-TEST'], ['ai.keyStorage', 'persistent'], ['ai.jsonMode', true]]
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of rows) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await setAi()
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) }); const list = words.filter((w) => w.deckId === 'kaoyan-2027-dagang').slice(0, 5); await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); for (const w of list) tx.objectStore('words').put({ ...w, examples: [] }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) }) })
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(400)
  const rows = page.locator('.mm-list button.mm-row'); for (let i = 0; i < 5; i += 1) await rows.nth(i).click()
  await page.getByRole('button', { name: /AI 生成选中词（5）/ }).click(); await page.waitForTimeout(1000)
  await page.getByLabel('每请求单词数').selectOption('5'); await page.waitForTimeout(300)
  await page.getByLabel('例句生成模式').selectOption('replace'); await page.waitForTimeout(500)
  await page.getByRole('button', { name: '开始生成' }).first().click({ force: true })
  await page.waitForTimeout(2500)
  record('afterStart', { reqs, body: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(-260), errors: [...errors.pageErrors, ...errors.consoleErrors].slice(-3) })
  await page.waitForFunction(() => /多对象生成完成/.test(document.body.innerText), null, { timeout: 30_000 })
  const summary = (await page.locator('body').innerText()).match(/多对象生成完成：[^\n]*/)?.[0] ?? ''
  record('run', { summary, requests: reqs })
  const multiReq = reqs.find((r) => r.multi)
  const fallbackReq = reqs.find((r) => !r.multi)
  assert(multiReq && multiReq.ids.length === 5, `多对象请求应含5词：${JSON.stringify(reqs)}`)
  assert(fallbackReq, `缺失项应触发单对象回退：${JSON.stringify(reqs)}`)
  const jobs = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const row = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('ai.generationJobs'); r.onsuccess = () => res(r.result?.value) }); return row ?? [] })
  const job = jobs.find((j) => j.kind === 'examples') ?? null
  record('job', job ? { status: job.status, cursor: job.cursor, results: job.results?.length, failed: job.failed?.length, filter: job.filter } : null)
  assert(job && job.status === 'completed' && job.cursor === 5 && job.results?.length === 5, `job 未写全：${JSON.stringify(job)}`)
  await page.screenshot({ path: join(OUT, '138-multiobject-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  assert(!layout.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[bmo] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[bmo] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '48-bmulti-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-bmulti.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
