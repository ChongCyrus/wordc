#!/usr/bin/env node
/** 0.6.2 续跑计数：16词任务 cursor4→继续→completed cursor16 results=16唯一，进度16/16。不调真实 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t602] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
await page.route('**/chat/completions', async (route) => {
  const body = JSON.parse(route.request().postData() ?? '{}')
  const user = String(body.messages?.[1]?.content ?? '')
  let rows = []
  try { rows = JSON.parse(user.slice(user.indexOf('['))) } catch { rows = [] }
  const items = rows.map((row) => ({ wordId: row.wordId, targetKey: row.targetKey, headword: String(row.headword ?? row.wordId?.split(':')[1] ?? ''), examples: [{ en: 'QA', cn: 'QA' }] }))
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) })
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const rows = [['ai.enabled', true], ['ai.provider', 'openai-compatible'], ['ai.baseUrl', 'https://api.deepseek.com'], ['ai.model', 'deepseek-chat'], ['ai.apiKey', 'sk-TEST'], ['ai.keyStorage', 'persistent'], ['ai.jsonMode', true]]
    await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of rows) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const ids = words.filter((w) => w.deckId === 'kaoyan-2027-dagang').slice(0, 16).map((w) => w.id)
    const now = Date.now()
    const job = { id: 'qa_resume16', name: 'QA16词续跑', kind: 'examples', kinds: ['examples'], source: 'custom', targets: ids.map((wordId) => ({ wordId })), cursor: 4, results: ids.slice(0, 4).map((wordId) => ({ wordId, at: now })), failed: [], status: 'paused', targetTotal: 16, batchSize: 5, concurrency: 2, budget: { maxCostPerRun: 3 }, createdAt: now, updatedAt: now }
    await new Promise((res, rej) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key: 'ai.generationJobs', value: [job], updatedAt: now }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await page.goto(`${BASE}#/me/jobs`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  await page.getByRole('button', { name: '继续' }).click(); await page.waitForTimeout(1000)
  const genBody = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('generateSource', { body: genBody.slice(0, 160) }); assert(/进度 4\/16/.test(genBody) && /剩余 12 词|目标 12 个/.test(genBody), `续跑来源/剩余错误：${genBody.slice(0, 160)}`)
  await page.getByRole('button', { name: /统一生成/ }).click()
  await page.waitForFunction(() => /统一生成完成|统一生成失败/.test(document.body.innerText), null, { timeout: 30_000 }).catch(() => {})
  await page.waitForTimeout(900)
  const job = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const row = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('ai.generationJobs'); r.onsuccess = () => res(r.result?.value) }); return row?.[0] })
  const unique = new Set((job?.results ?? []).map((r) => r.wordId)).size
  const counts = { status: job?.status, cursor: job?.cursor, targetTotal: job?.targetTotal, results: job?.results?.length, uniqueResults: unique, failed: job?.failed?.length, failedSample: (job?.failed ?? []).slice(0, 3) }
  record('jobAfter', counts)
  assert(job?.status === 'completed' && job.cursor === 16 && job.targetTotal === 16 && job.results?.length === 16 && unique === 16, `续跑计数错误：${JSON.stringify(counts)}`)
  // 进度展示 16/16（刷新任务中心）
  await page.goto(`${BASE}#/me/jobs`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const rowText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('jobsRow', { has1616: /进度 16\/16/.test(rowText), text: rowText.match(/QA16词续跑[^\n]*/)?.[0] ?? '' })
  assert(/进度 16\/16/.test(rowText), `任务中心进度不是16/16：${rowText.match(/QA16词续跑[^\n]*/)?.[0] ?? ''}`)
  // reload 保持
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const reloadText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('reload', { status16: /进度 16\/16/.test(reloadText) }); assert(/进度 16\/16/.test(reloadText), 'reload 后进度丢失')
  await page.screenshot({ path: join(OUT, '158-resume16-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const small = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', small); assert(!small.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t602] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t602] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '37-task602-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task602.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
