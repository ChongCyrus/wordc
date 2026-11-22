#!/usr/bin/env node
/** 0.3.94 补充：autoRequeue 关、rate-only 三键、familiar gap（下一词非同一词/非a）。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t286b] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const word = () => page.locator('.word-text').first().innerText().catch(() => '')
const openAnn = async () => { if ((await page.locator('.board-stage').count()) > 0) await page.locator('.board-stage').first().click(); await page.waitForTimeout(500) }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  const wid = 'kaoyan-2027-dagang:denounce'
  // autoRequeue 关：模糊后直接汇总
  await page.goto(`${BASE}#/temp-review?words=${encodeURIComponent(wid)}&recordMode=rate&returnTo=${encodeURIComponent('/decks/kaoyan-2027-dagang')}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1800)
  await openAnn()
  const vague = page.locator('.rating-btn--vague').first(); await vague.waitFor({ state: 'visible', timeout: 5000 }); await vague.click(); await page.waitForTimeout(1200)
  const offText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('autoOff', { summary: /临时复习汇总/.test(offText), occurrences: offText.match(/本批出现 (\d+) 次/)?.[0] ?? '', text: offText.slice(0, 150) })
  assert(/临时复习汇总/.test(offText), `autoRequeue 关后应直接汇总：${offText.slice(0, 120)}`)
  // rate-only 三键 + 汇总应用
  await page.goto(`${BASE}#/temp-review?words=${encodeURIComponent(wid)}&recordMode=rate-only&returnTo=${encodeURIComponent('/decks/kaoyan-2027-dagang')}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1800)
  await openAnn()
  const btnCount = await page.locator('.rating-btn--know, .rating-btn--vague, .rating-btn--unknown').count()
  const nextCount = await page.getByRole('button', { name: '下一个', exact: true }).count()
  record('rateOnlyButtons', { btnCount, nextCount })
  assert(btnCount === 3 && nextCount === 0, `rate-only 应三键无下一个：${JSON.stringify({ btnCount, nextCount })}`)
  await page.locator('.rating-btn--vague').click(); await page.waitForTimeout(1300)
  const roText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('rateOnlySummary', { text: roText.slice(0, 180), apply: /根据本批次调整日后复习计划/.test(roText) })
  assert(/临时复习汇总/.test(roText) && /根据本批次调整日后复习计划/.test(roText), `rate-only 汇总应有应用：${roText.slice(0, 120)}`)
  await page.screenshot({ path: join(OUT, '108-temp-rateoff-summary-390.png') }).catch(() => {})
  // familiar gap：6词计划，第一词认识→下一词不同且不是 a
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await page.waitForTimeout(500)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const ids = words.filter((w) => w.deckId === 'kaoyan-2027-dagang' && w.headword.length > 2).slice(0, 6).map((w) => w.id)
    const activeId = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
    const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(activeId); r.onsuccess = () => res(r.result) })
    await new Promise((res, rej) => {
      const tx = db.transaction(['plans', 'meta'], 'readwrite')
      const next = { ...(plan ?? { id: '2026-11-21:kaoyan-2027-dagang', date: '2026-11-21', deckId: 'kaoyan-2027-dagang', sources: {}, goals: {}, ratings: {}, createdAt: Date.now() }), wordIds: ids, index: 0, completedAt: null, sources: {}, updatedAt: Date.now() }
      tx.objectStore('plans').put(next); tx.objectStore('meta').put({ key: 'plan.activeId', value: next.id, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await page.waitForTimeout(800)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1200)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 15000 })
  const first = await word(); await openAnn()
  const know = page.locator('.rating-btn--know').first(); await know.waitFor({ state: 'visible', timeout: 5000 }); await know.click(); await page.waitForTimeout(1400)
  const second = await word()
  record('familiarGap', { first, second })
  assert(second !== first && second !== 'a' && second !== '', `认识后下一词应不同且非a：${JSON.stringify({ first, second })}`)
  await page.screenshot({ path: join(OUT, '109-familiar-gap-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]; assert(result.errors.length === 0, `errors：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t286b] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t286b] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '56-task286b-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task286b.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
