#!/usr/bin/env node
/** 0.3.80 task-242：生成式阶段2 三拍 full→hidden→verify→+1，满次数进阶段3；阶段1不变。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[gen242] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setSettings = async (pairs) => page.evaluate(async (pairs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries(pairs)) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, pairs)
const snap = async () => page.evaluate(() => {
  const stage = document.querySelector('.generative-stage')
  const cn = document.querySelector('.generative-wc-card .wc-cn')
  const vis = cn ? cn.getBoundingClientRect().width > 0 && getComputedStyle(cn).visibility !== 'hidden' && getComputedStyle(cn).display !== 'none' : false
  return { header: stage?.querySelector('.mm-row-title')?.textContent?.trim() ?? '', phase2: !!document.querySelector('.generative-phase2'), count: document.querySelector('.generative-count .wc-count')?.textContent?.trim() ?? '', cnVisible: vis, posText: Array.from(document.querySelectorAll('.generative-wc-card .wc-hidden-pos-item')).map((n) => n.textContent?.trim()).join(' '), question: !!document.querySelector('.generative-wc-card .wc-hidden-question'), questionFont: document.querySelector('.generative-wc-card .wc-hidden-question') ? getComputedStyle(document.querySelector('.generative-wc-card .wc-hidden-question')).fontSize : '', order: (() => { const w = document.querySelector('.generative-wc-card .wc-word')?.getBoundingClientRect(); const a = document.querySelector('.generative-wc-card .wc-hidden-arrow')?.getBoundingClientRect(); const q = document.querySelector('.generative-wc-card .wc-hidden-question')?.getBoundingClientRect(); return w && a && q ? { wordBottom: Math.round(w.bottom), arrowTop: Math.round(a.top), arrowBottom: Math.round(a.bottom), questionTop: Math.round(q.top) } : null })(), overflow: document.documentElement.scrollWidth > innerWidth + 1 }
})
const tap2 = async () => { await page.evaluate(() => { const z = document.querySelector('.generative-phase2'); if (z) z.dispatchEvent(new MouseEvent('click', { bubbles: true })) }); await page.waitForTimeout(350) }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await setSettings({ 'memory.threeTapRecall': true })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.getByRole('button', { name: '生成式记忆' }).first().click()
  await page.locator('.generative-stage').waitFor({ state: 'visible', timeout: 15_000 })
  const p1 = await snap(); record('phase1', p1)
  assert(/阶段 1\/4/.test(p1.header), `应阶段1：${JSON.stringify(p1)}`)
  await page.getByRole('button', { name: '下一步' }).first().click()
  await page.locator('.generative-phase2').waitFor({ state: 'visible', timeout: 5000 })
  const s0 = await snap(); record('phase2Start', s0)
  assert(/阶段 2\/4/.test(s0.header) && s0.count === '0 / 3' && s0.cnVisible, `阶段2初始应完整：${JSON.stringify(s0)}`)
  await tap2(); const h = await snap(); record('phase2Hidden', h)
  assert(h.count === '0 / 3' && !h.cnVisible && h.question && h.questionFont === '38px' && h.order && h.order.wordBottom <= h.order.arrowTop && h.order.arrowBottom <= h.order.questionTop, `第1拍hidden应 w→大↓→大?(38px) 且不+1：${JSON.stringify(h)}`)
  await page.screenshot({ path: join(OUT, '68-generative-phase2-hidden-390.png') }).catch(() => {})
  await tap2(); const v = await snap(); record('phase2Verify', v)
  assert(v.count === '0 / 3' && v.cnVisible, `第2拍verify且不+1：${JSON.stringify(v)}`)
  await tap2(); const inc = await snap(); record('phase2Increment', inc)
  assert(inc.count === '1 / 3' && !/阶段 3\/4/.test(inc.header), `第3拍才+1：${JSON.stringify(inc)}`)
  for (let i = 0; i < 12 && !/阶段 3\/4/.test((await snap()).header); i += 1) { await tap2(); await tap2(); await tap2() }
  const p3 = await snap(); record('phase3', p3)
  await page.screenshot({ path: join(OUT, '69-generative-phase3-390.png') }).catch(() => {})
  assert(/阶段 3\/4/.test(p3.header), `满次数应进阶段3：${JSON.stringify(p3)}`)
  assert(!p3.overflow, '390 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[gen242] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[gen242] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '81-gen242-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-gen242.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
