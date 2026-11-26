/**
 * 0.16 QA：连评10词 / 快速连点 / reload 数据一致性（Web/PWA 形态；APK 真机由 Lead 同脚本流程验证）
 * 不调 App API；fixture 预设 10 词计划。
 * env: QA_BASE, QA_FIXTURE, QA_PERF_P95_MS(默认1500), QA_HEADFUL
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, assert } from './qa-gate-lib.mjs'

const P95 = Number(process.env.QA_PERF_P95_MS ?? 1500)
const { page, close } = await launch()
const result = { ratings: [], rapid: null, reload: null, errors: [] }
page.on('pageerror', (e) => result.errors.push(String(e)))
page.on('crash', () => result.errors.push('page-crash'))

async function readCounts() {
  return page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const c = (s) => new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).count(); r.onsuccess = () => res(r.result) })
    const plans = await new Promise((res) => { const q = db.transaction('plans', 'readonly').objectStore('plans').getAll(); q.onsuccess = () => res(q.result) })
    const logs = await new Promise((res) => { const q = db.transaction('reviewLogs', 'readonly').objectStore('reviewLogs').getAll(); q.onsuccess = () => res(q.result) })
    return { states: await c('states'), plans: await c('plans'), logs: logs.length, planLens: plans.map((p) => p.wordIds?.length ?? 0), lastLogAt: logs.at(-1)?.at ?? null }
  })
}

try {
  if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await waitHome(page, 120000)
  // 预设 10 词今日计划（取当前词库前 10 个词；只用于 QA fixture）
  const planInfo = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const q = db.transaction('words', 'readonly').objectStore('words').limit(20).getAll(); q.onsuccess = () => res(q.result) })
    const deckId = words[0]?.deckId ?? 'kaoyan-2027-dagang'
    const ids = words.slice(0, 10).map((w) => w.id)
    const today = new Date().toISOString().slice(0, 10)
    const plan = { id: `${today}:${deckId}`, date: today, deckId, wordIds: ids, index: 0, sources: Object.fromEntries(ids.map((id) => [id, 'goal'])), goals: { dailyGoal: ids.length, dueCount: 0, newBudget: ids.length, extraCount: 0 }, ratings: [], createdAt: Date.now(), updatedAt: Date.now(), completedAt: null }
    await new Promise((res, rej) => { const tx = db.transaction('plans', 'readwrite'); tx.objectStore('plans').put(plan); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    return { deckId, ids: ids.length }
  })
  result.plan = planInfo
  await page.goto(`${BASE}#/study`, { waitUntil: 'domcontentloaded' })
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30000 })

  for (let i = 0; i < 10; i += 1) {
    const t0 = Date.now()
    await page.locator('.board-stage').first().click()
    await page.locator('.annotation-stage').first().waitFor({ state: 'visible', timeout: 10000 })
    const before = await page.evaluate(() => document.querySelector('.board-stage')?.textContent ?? '')
    const btn = page.getByRole('button', { name: /^(认识|熟悉)$/ }).first()
    assert(await btn.count() === 1, `第${i + 1}词未找到「认识」按钮`)
    await btn.click()
    await page.waitForFunction((prev) => {
      const board = document.querySelector('.board-stage')
      if (!board) return false
      const text = board.textContent ?? ''
      return text !== prev && text.length > 0
    }, before, { timeout: 8000 })
    const ms = Date.now() - t0
    result.ratings.push({ index: i, ms })
  }

  // 快速连点：找词根/标注按钮（若存在），5 次快速点击后应仍能评分
  await page.locator('.board-stage').first().click()
  await page.locator('.annotation-stage').first().waitFor({ state: 'visible', timeout: 10000 })
  const candidate = page.getByRole('button', { name: /词根|词缀|标注|本义/ }).first()
  if (await candidate.count()) {
    const t0 = Date.now()
    for (let i = 0; i < 5; i += 1) await candidate.click({ delay: 10, force: true })
    const rapidMs = Date.now() - t0
    const rating = page.getByRole('button', { name: /^(认识|熟悉)$/ }).first()
    await rating.waitFor({ state: 'visible', timeout: 2000 })
    const before = await page.evaluate(() => document.querySelector('.board-stage')?.textContent ?? '')
    await rating.click()
    await page.waitForFunction((prev) => (document.querySelector('.board-stage')?.textContent ?? '') !== prev, before, { timeout: 3000 })
    result.rapid = { rapidMs, nextWordMs: Date.now() - t0, button: await candidate.innerText().catch(() => '') }
  } else {
    result.rapid = { skipped: 'no root/annotation button found' }
  }

  const beforeReload = await readCounts()
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const afterReload = await readCounts()
  result.reload = { before: beforeReload, after: afterReload, equal: JSON.stringify(beforeReload) === JSON.stringify(afterReload) }

  const sorted = result.ratings.map((r) => r.ms).sort((a, b) => a - b)
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
  result.summary = { count: result.ratings.length, avgMs: Math.round(sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length)), p95Ms: p95, maxMs: sorted.at(-1) ?? 0, reloadEqual: result.reload.equal }

  await mkdir(OUT, { recursive: true }).catch(() => {})
  await page.screenshot({ path: join(OUT, 'qa-0.16-perf-390.png'), fullPage: true }).catch(() => {})
  assert(result.ratings.length === 10, `连评未完成：${result.ratings.length}/10`)
  assert(p95 < P95, `连评 p95 ${p95}ms 超过阈值 ${P95}ms`)
  assert(result.reload.equal, 'reload 前后计数不一致')
  assert(result.errors.length === 0, `页面错误：${result.errors.join('|')}`)
  console.log(JSON.stringify(result, null, 2))
  console.log('PASS: 10 ratings, p95 under threshold, reload consistent')
} finally {
  await writeFile('/tmp/qa-0.16-perf.json', JSON.stringify(result, null, 2)).catch(() => {})
  await close()
}
