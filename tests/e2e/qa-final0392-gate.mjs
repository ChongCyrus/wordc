#!/usr/bin/env node
/** 0.3.92 final task-274：manual 无词首页、顺序/随机 toast、详情返回、390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[final] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const clearPlan = () => page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); await new Promise((res, rej) => { const tx = db.transaction(['plans', 'meta'], 'readwrite'); tx.objectStore('plans').clear(); tx.objectStore('meta').delete('plan.activeId'); tx.oncomplete = res; tx.onerror = () => rej(tx.error) }) })
const planLen = () => page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) }); if (id == null) return 0; const p = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) }); return p?.wordIds?.length ?? 0 })
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await clearPlan(); await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); await waitHome(page, 90_000); await page.waitForTimeout(1200)
  const home = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const checks = { zero: /今日 0 \/ 0|今日 0\/0/.test(home), pending0: /待新学 0/.test(home), start: await page.getByText('开始学习', { exact: true }).count(), add: await page.getByText('添加今日新单词', { exact: true }).count(), text: home.slice(0, 220) }
  record('homeManualNoWords', checks)
  assert(checks.pending0 && checks.add > 0 && checks.start === 0, `manual 无词首页错误：${JSON.stringify(checks)}`)
  assert(checks.zero, `今日应 0/0：${checks.text}`)
  await page.screenshot({ path: join(OUT, '100-home-manual-0-390.png') }).catch(() => {})
  // 顺序3：无 plan 直接加，toast
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  let dlg = page.getByRole('dialog', { name: '添加今日新单词' }).first(); await dlg.waitFor({ state: 'visible', timeout: 5000 })
  await dlg.getByRole('button', { name: '顺序选择' }).click(); await dlg.locator('#add-word-count').fill('3'); await dlg.locator('#add-word-count').blur(); await page.waitForTimeout(300)
  const beforeOrder = await planLen(); await dlg.getByRole('button', { name: '添加' }).click()
  const doneDlg = page.getByRole('dialog', { name: '添加完成' }).first()
  await doneDlg.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const doneText = await doneDlg.innerText().catch(() => '')
  await page.waitForTimeout(300); const afterOrder = await planLen()
  record('orderAdd', { beforeOrder, afterOrder, doneText: doneText.replace(/\s+/g, ' ').slice(0, 120) })
  assert(afterOrder === beforeOrder + 3 && /已追加 3 个新词/.test(doneText), `顺序添加/确认弹窗失败：${JSON.stringify({ beforeOrder, afterOrder, doneText })}`)
  await doneDlg.getByRole('button', { name: '确定' }).click().catch(() => {}); await page.waitForTimeout(300)
  // 随机3：有 plan -> 弹窗保留，toast
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  dlg = page.getByRole('dialog', { name: '添加今日新单词' }).first(); await dlg.waitFor({ state: 'visible', timeout: 5000 })
  await dlg.getByRole('button', { name: '随机选择' }).click(); await dlg.locator('#add-word-count').fill('3'); await dlg.locator('#add-word-count').blur(); await page.waitForTimeout(300)
  const beforeRandom = await planLen(); await dlg.getByRole('button', { name: '添加' }).click()
  const planDlg = page.getByRole('dialog', { name: '已有今日计划' }).first(); await planDlg.waitFor({ state: 'visible', timeout: 5000 })
  await planDlg.getByRole('button', { name: '保留今日计划并追加' }).click()
  const doneDlg2 = page.getByRole('dialog', { name: '添加完成' }).first()
  await doneDlg2.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const doneText2 = await doneDlg2.innerText().catch(() => '')
  await page.waitForTimeout(300); const afterRandom = await planLen()
  record('randomAdd', { beforeRandom, afterRandom, doneText: doneText2.replace(/\s+/g, ' ').slice(0, 120) })
  assert(afterRandom === beforeRandom + 3 && /已追加 3 个新词/.test(doneText2), `随机添加/确认弹窗失败：${JSON.stringify({ beforeRandom, afterRandom, doneText2 })}`)
  await doneDlg2.getByRole('button', { name: '确定' }).click().catch(() => {}); await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, '101-add-toast-390.png') }).catch(() => {})
  // 详情返回
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(1000)
  await page.getByLabel('返回详情').click(); await page.waitForTimeout(1800)
  const back = await page.evaluate(() => ({ url: location.href, rows: document.querySelectorAll('.mm-list button.mm-row').length, loading: document.querySelectorAll('.study-loading').length, body: document.body.innerText.slice(0, 80) }))
  record('detailBack', back)
  assert(/decks\/kaoyan/.test(back.url) && back.rows > 0 && back.loading === 0, `详情返回失败：${JSON.stringify(back)}`)
  await page.screenshot({ path: join(OUT, '102-detail-back-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  assert(!layout.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[final] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[final] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '61-final-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-final0392.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
