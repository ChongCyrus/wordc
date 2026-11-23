#!/usr/bin/env node
/** 0.6.1 临时复习 practice/score-only/rate：practice 无评分且不写，rate-only due不变，rate 更新。不调真实 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t601] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const W = (name) => `kaoyan-2027-dagang:${name}`
const readState = (wordId) => page.evaluate(async (id) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const state = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').get(id); r.onsuccess = () => res(r.result ?? null) })
  const logs = await new Promise((res) => { const r = db.transaction('reviewLogs', 'readonly').objectStore('reviewLogs').getAll(); r.onsuccess = () => res(r.result ?? []) })
  return { state, logs: logs.filter((l) => l.wordId === id).length }
}, wordId)
const openTemp = async (wordId, mode) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(300)
  await page.goto(`${BASE}#/study?tempWords=${encodeURIComponent(wordId)}&tempRecordMode=${mode}&returnTo=%2Fme`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  let practice = await page.locator('button.rating-btn--know').count()
  if (mode !== 'practice' && practice === 0) { await page.waitForTimeout(700); practice = await page.locator('button.rating-btn--know').count() }
  return { practice, body: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 160) }
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.waitForTimeout(800)
  const clean = await page.evaluate(async (ids) => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); for (const id of ids) { await new Promise((res) => { const tx = db.transaction('states', 'readwrite'); tx.objectStore('states').delete(id); tx.oncomplete = res }); const logs = await new Promise((res) => { const r = db.transaction('reviewLogs', 'readonly').objectStore('reviewLogs').getAll(); r.onsuccess = () => res(r.result ?? []) }); for (const l of logs.filter((l) => l.wordId === id)) await new Promise((res) => { const tx = db.transaction('reviewLogs', 'readwrite'); tx.objectStore('reviewLogs').delete(l.id); tx.oncomplete = res }) } }, [W('abandon'), W('ability'), W('abnormal')])
  record('clean', clean)
  // practice
  const p0 = await readState(W('abandon')); const prac = await openTemp(W('abandon'), 'practice')
  record('practiceOpen', prac); assert(prac.practice === 0, `practice 不应显示评分按钮：${prac.practice}`)
  await page.getByRole('button', { name: '退出临时复习' }).click().catch(() => {}); await page.waitForTimeout(700)
  const p1 = await readState(W('abandon')); record('practiceAfter', p1)
  assert(!p1.state && p1.logs === 0, `practice 写入了状态/日志：${JSON.stringify({ state: p1.state, logs: p1.logs })}`)
  // score-only
  const s0 = await readState(W('ability')); const score = await openTemp(W('ability'), 'rate-only')
  record('scoreOpen', score); assert(score.practice === 1, 'rate-only 应显示评分按钮')
  await page.locator('button.rating-btn--know').first().click(); await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '退出临时复习' }).click().catch(() => {}); await page.waitForTimeout(700)
  const s1 = await readState(W('ability')); record('scoreAfter', { state: s1.state ? { dueAt: s1.state.dueAt, lastReviewedAt: s1.state.lastReviewedAt, lastRating: s1.state.lastRating } : null, logs: s1.logs })
  assert(s1.logs === 1 && s1.state && s1.state.dueAt == null, `rate-only 应记录但不改 due：${JSON.stringify({ logs: s1.logs, dueAt: s1.state?.dueAt })}`)
  // rate
  const r0 = await readState(W('abnormal')); const rateOpen = await openTemp(W('abnormal'), 'rate')
  record('rateOpen', rateOpen); assert(rateOpen.practice === 1, 'rate 应显示评分按钮')
  await page.locator('button.rating-btn--know').first().click(); await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '退出临时复习' }).click().catch(() => {}); await page.waitForTimeout(700)
  const r1 = await readState(W('abnormal')); record('rateAfter', { state: r1.state ? { dueAt: r1.state.dueAt, lastReviewedAt: r1.state.lastReviewedAt, lastRating: r1.state.lastRating } : null, logs: r1.logs })
  assert(r1.logs === 1 && r1.state && r1.state.dueAt != null, `rate 应更新 due：${JSON.stringify({ logs: r1.logs, dueAt: r1.state?.dueAt })}`)
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const small = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', small); assert(!small.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t601] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t601] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '38-task601-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task601.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
