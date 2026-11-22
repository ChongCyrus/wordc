#!/usr/bin/env node
/** 0.3.92 顺序/随机添加点击后运行时诊断。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t273d] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const pending = new Map(); const failedReq = []
page.on('request', (r) => pending.set(r.url(), Date.now()))
page.on('requestfinished', (r) => pending.delete(r.url()))
page.on('requestfailed', (r) => { pending.delete(r.url()); failedReq.push({ url: r.url(), err: r.failure()?.errorText }) })
const planLen = () => page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) }); const p = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) }); return p?.wordIds?.length ?? 0 })
const dialogs = () => page.evaluate(() => Array.from(document.querySelectorAll('[role="dialog"]')).map((d) => ({ label: d.getAttribute('aria-label'), opacity: getComputedStyle(d).opacity, text: d.innerText.replace(/\s+/g, ' ').slice(0, 180), buttons: Array.from(d.querySelectorAll('button')).map((b) => ({ text: (b.textContent ?? '').trim(), disabled: b.disabled })) })))
const addFlow = async (mode) => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await page.waitForTimeout(700)
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  const dlg = page.getByRole('dialog', { name: '添加今日新单词' }).first(); await dlg.waitFor({ state: 'visible', timeout: 5000 })
  await dlg.getByRole('button', { name: mode === 'order' ? '顺序选择' : '随机选择' }).click()
  await dlg.locator('#add-word-count').fill('3'); await dlg.locator('#add-word-count').blur(); await page.waitForTimeout(300)
  const before = await planLen()
  await dlg.getByRole('button', { name: '添加' }).click()
  const planDlg = page.getByRole('dialog', { name: '已有今日计划' }).first()
  await planDlg.waitFor({ state: 'visible', timeout: 8000 })
  const preDlg = await dialogs()
  await planDlg.getByRole('button', { name: '保留今日计划并追加' }).click()
  const at0 = { dialogs: await dialogs(), plan: await planLen() }
  const waitStates = {}
  for (const ms of [5000, 10000, 15000]) {
    await page.waitForTimeout(ms === 5000 ? 5000 : ms === 10000 ? 5000 : 5000)
    waitStates[`${(Date.parse('1970-01-01') + ms) / 1000}s`] = { body: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(-240), dialogVisible: await planDlg.isVisible().catch(() => false), plan: await planLen() }
  }
  const final = await dialogs()
  const consoleNow = [...errors.pageErrors, ...errors.consoleErrors]
  const sw = await page.evaluate(async () => ({ sw: navigator.serviceWorker?.controller?.scriptURL ?? null, regs: (await navigator.serviceWorker?.getRegistrations?.() ?? []).map((r) => r.active?.scriptURL) }))
  const pendingNow = Array.from(pending.keys()).filter((u) => !/favicon/.test(u)).slice(-10)
  record(mode, { before, preDlg, at0, waitStates, final, console: consoleNow.slice(-8), failedReq: failedReq.slice(-5), pending: pendingNow, sw })
  await page.screenshot({ path: join(OUT, `63-add-${mode}-diag.png`) }).catch(() => {})
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  const assets = await page.evaluate(() => ({ scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean) }))
  record('assets', assets)
  await addFlow('order')
  await addFlow('random')
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t273d] DONE in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t273d] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '62-order-diag-fail.png') }).catch(() => {})
} finally { await writeFile(join(OUT, 'qa-task273-diag.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
