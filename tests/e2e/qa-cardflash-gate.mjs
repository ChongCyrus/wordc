#!/usr/bin/env node
/** 0.3.85 task-252：memory.cardFlashAnimation 默认 false；设置开关；第3拍无闪动/有闪动。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[flash] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setSettings = async (pairs) => page.evaluate(async (pairs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries(pairs)) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, pairs)
const tap = async () => { await page.locator('.memory-stage').evaluate((el) => el.click()); await page.waitForTimeout(350) }
const enterMemory = async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.getByRole('button', { name: '记忆' }).first().click(); await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
}
const runThirdTap = async () => {
  await page.evaluate(() => { const c = document.querySelector('.memory-stage .wc-card'); if (c) c.setAttribute('data-qa-marker', 'kept') })
  await tap()
  const hidden = await page.evaluate(() => ({ marker: document.querySelector('.memory-stage .wc-card')?.getAttribute('data-qa-marker') ?? null, cls: document.querySelector('.memory-stage')?.className ?? '' }))
  await tap()
  const verify = await page.evaluate(() => ({ marker: document.querySelector('.memory-stage .wc-card')?.getAttribute('data-qa-marker') ?? null, cls: document.querySelector('.memory-stage')?.className ?? '' }))
  const before = await page.evaluate(() => ({ marker: document.querySelector('.memory-stage .wc-card')?.getAttribute('data-qa-marker') ?? null, count: document.querySelector('.wc-count')?.textContent?.trim() }))
  await tap()
  const after = await page.evaluate(() => ({ marker: document.querySelector('.memory-stage .wc-card')?.getAttribute('data-qa-marker') ?? null, count: document.querySelector('.wc-count')?.textContent?.trim(), cls: document.querySelector('.memory-stage')?.className ?? '' }))
  return { hidden, verify, before, after }
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await setSettings({ 'memory.threeTapRecall': true })
  // 设置默认/页面开关
  await page.goto(`${BASE}#/me/settings`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const sw = page.getByRole('switch', { name: '记忆卡切换闪动动画' }).first()
  const settingsText = await page.locator('body').innerText()
  const defaultChecked = await sw.isChecked().catch(() => null)
  record('settings', { label: /记忆卡切换闪动动画/.test(settingsText), defaultChecked, hint: /默认关闭/.test(settingsText) })
  assert(/记忆卡切换闪动动画/.test(settingsText) && defaultChecked === false, `默认应关闭且设置项存在：${JSON.stringify({ defaultChecked, label: /记忆卡切换闪动动画/.test(settingsText) })}`)
  await page.screenshot({ path: join(OUT, '73-flash-setting-390.png') }).catch(() => {})
  // 默认关闭：第3拍不 remount
  await enterMemory()
  const off = await runThirdTap()
  record('offThirdTap', off)
  assert(off.hidden.marker === 'kept' && off.verify.marker === 'kept' && off.after.marker === 'kept' && off.after.count === '1 / 3', `关闭闪动 hidden/verify/第3拍均不应 remount：${JSON.stringify(off)}`)
  await page.screenshot({ path: join(OUT, '74-flash-off-390.png') }).catch(() => {})
  // 开启：第3拍 remount
  await setSettings({ 'memory.cardFlashAnimation': true })
  await enterMemory()
  const on = await runThirdTap()
  record('onThirdTap', on)
  assert(on.hidden.marker === 'kept' && on.verify.marker === 'kept' && on.before.marker === 'kept' && on.after.marker === null && on.after.count === '1 / 3', `开启闪动仅第3拍 remount：${JSON.stringify(on)}`)
  await page.screenshot({ path: join(OUT, '75-flash-on-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[flash] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[flash] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '79-flash-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-flash.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
