#!/usr/bin/env node
/** 0.3.89 task-262/263：词库详情默认点词进注释面无评分；抽词→加入计划/立即复习 practice/rate 不改计划。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t262] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const db = async () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
  const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
  const stateCount = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').count(); r.onsuccess = () => res(r.result) })
  const logCount = await new Promise((res) => { const r = db.transaction('reviewLogs', 'readonly').objectStore('reviewLogs').count(); r.onsuccess = () => res(r.result) })
  return { planLen: plan?.wordIds?.length ?? 0, index: plan?.index ?? 0, stateCount, logCount }
})
const goDeck = async () => { await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000) }
const selectFirst = async () => { const done = page.getByRole('button', { name: '完成', exact: true }).first(); if (await done.isVisible().catch(() => false)) { await done.click(); await page.waitForTimeout(300) } const sel = page.getByRole('button', { name: '选择', exact: true }).first(); await sel.waitFor({ state: 'visible', timeout: 10_000 }); await sel.click(); await page.waitForTimeout(300); await page.locator('.mm-list button.mm-row').first().waitFor({ state: 'visible', timeout: 10_000 }); await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(300) }
const openChoice = async () => { await page.getByRole('button', { name: /抽这些词复习（1）/ }).first().click(); const dlg = page.getByRole('dialog', { name: '抽这些词复习（1）' }).first(); await dlg.waitFor({ state: 'visible', timeout: 5000 }); return dlg }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await goDeck()
  // A 默认点词 -> 注释面
  await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(1200)
  const detailUrl = page.url()
  const detailText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const ratings = await page.getByRole('button', { name: /^(认识|模糊|不认识|忘记)$/ }).count()
  record('deckWordDetail', { url: detailUrl, annotation: await page.locator('.annotation-stage').count(), meanings: await page.locator('.meaning-row').count(), ratings, memoryBtns: ['记忆', '加权记忆', '生成式记忆'].map((n) => n) })
  assert(/detailWord=/.test(detailUrl) && (await page.locator('.annotation-stage').count()) > 0 && ratings === 0, `默认点词应进注释面且无评分：${JSON.stringify({ url: detailUrl, ratings })}`)
  assert((await page.getByRole('button', { name: /^(记忆|加权记忆|生成式记忆)$/ }).count()) >= 3, '详情应可进记忆/加权/生成式')
  await page.screenshot({ path: join(OUT, '84-deck-word-detail-390.png') }).catch(() => {})
  // 返回列表
  await goDeck()
  // C 加入今日计划
  await selectFirst(); let choice = await openChoice()
  const beforeAdd = await db(); await choice.getByRole('button', { name: '加入今日计划' }).click()
  await page.waitForFunction(() => /已追加/.test(document.body.innerText), null, { timeout: 10_000 })
  const afterAdd = await db(); record('addToPlan', { beforeAdd, afterAdd })
  assert(afterAdd.planLen > beforeAdd.planLen && afterAdd.stateCount === beforeAdd.stateCount, `加入计划应只改 plan：${JSON.stringify({ beforeAdd, afterAdd })}`)
  // practice 立即复习
  await goDeck(); await selectFirst(); choice = await openChoice()
  await choice.getByText('只练不记录（不显示评分）').click()
  const beforePractice = await db()
  await choice.getByRole('button', { name: '立即复习' }).click()
  await page.waitForTimeout(1200)
  const practiceText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const practiceRatings = await page.getByRole('button', { name: /^(认识|模糊|不认识|忘记)$/ }).count()
  const afterPractice = await db()
  record('practice', { url: page.url(), ratings: practiceRatings, next: /下一个/.test(practiceText), beforePractice, afterPractice })
  assert(/temp-review/.test(page.url()) && practiceRatings === 0 && /下一个/.test(practiceText), 'practice 应不显示评分')
  assert(afterPractice.stateCount === beforePractice.stateCount && afterPractice.logCount === beforePractice.logCount && afterPractice.planLen === beforePractice.planLen, `practice 不应写库/改计划：${JSON.stringify({ beforePractice, afterPractice })}`)
  await page.screenshot({ path: join(OUT, '85-temp-practice-390.png') }).catch(() => {})
  // rate 立即复习
  await goDeck(); await selectFirst(); choice = await openChoice()
  await choice.getByText('评分并记录（不改变今日计划）').click()
  const beforeRate = await db()
  await choice.getByRole('button', { name: '立即复习' }).click(); await page.waitForTimeout(900)
  const rateBtn = page.locator('.temp-review-actions button').first(); await rateBtn.click(); await page.waitForTimeout(900)
  const afterRate = await db()
  record('rate', { beforeRate, afterRate, url: page.url() })
  assert(afterRate.planLen === beforeRate.planLen && (afterRate.stateCount > beforeRate.stateCount || afterRate.logCount > beforeRate.logCount), `rate 应记录且不改 plan：${JSON.stringify({ beforeRate, afterRate })}`)
  await page.screenshot({ path: join(OUT, '86-temp-rate-390.png') }).catch(() => {})
  // 360
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('layout360', layout)
  assert(!layout.overflow, '360 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t262] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t262] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '70-task262-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task262.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
