#!/usr/bin/env node
/** 0.3.92 final2：manual 添加5→待新学5/0-5、仅一个添加按钮、弹窗不透明、详情返回、390。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[final2] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const clearPlan = () => page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); await new Promise((res, rej) => { const tx = db.transaction(['plans', 'meta'], 'readwrite'); tx.objectStore('plans').clear(); tx.objectStore('meta').delete('plan.activeId'); tx.oncomplete = res; tx.onerror = () => rej(tx.error) }) })
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await clearPlan(); await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }); await waitHome(page, 90_000); await page.waitForTimeout(1000)
  const addCount0 = await page.getByText('添加今日新单词', { exact: true }).count()
  record('emptyAddCount', { addCount: addCount0 })
  assert(addCount0 === 1, `无 plan 首页应仅一个添加按钮：${addCount0}`)
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  const dlg = page.getByRole('dialog', { name: '添加今日新单词' }).first(); await dlg.waitFor({ state: 'visible', timeout: 5000 })
  await dlg.getByRole('button', { name: '顺序选择' }).click(); await dlg.locator('#add-word-count').fill('5'); await dlg.locator('#add-word-count').blur(); await page.waitForTimeout(300)
  await dlg.getByRole('button', { name: '添加' }).click()
  const done = page.getByRole('dialog', { name: '添加完成' }).first(); await done.waitFor({ state: 'visible', timeout: 8000 })
  const doneText = (await done.innerText()).replace(/\s+/g, ' '); await done.getByRole('button', { name: '确定' }).click(); await page.waitForTimeout(1000)
  const home = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const kpis = await page.$$eval('.mm-kpi', (els) => els.map((e) => ({ value: (e.querySelector('.mm-kpi-value')?.textContent ?? '').trim(), label: (e.querySelector('.mm-kpi-label')?.textContent ?? '').trim() })))
  const kpi = Object.fromEntries(kpis.map((k) => [k.label, k.value]))
  const addCount = await page.getByText('添加今日新单词', { exact: true }).count()
  const progress = /今日 0 \/ 5/.test(home)
  record('manual5Home', { kpis, progress, addCount, doneText: doneText.slice(0, 100), text: home.slice(0, 240) })
  assert(kpi['待新学'] === '5' && kpi['待复习'] === '0' && kpi['今日已学'] === '0', `顶部 KPI 应 待复习0/待新学5/今日已学0：${JSON.stringify(kpi)}`)
  assert(progress, `进度应 0/5：${home.slice(0, 160)}`)
  assert(addCount === 1, `添加后首页仍应仅一个添加按钮：${addCount}`)
  // 弹窗不透明
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  const dlg2 = page.getByRole('dialog', { name: '添加今日新单词' }).first(); await dlg2.waitFor({ state: 'visible', timeout: 5000 }); await page.waitForTimeout(500)
  const style = await page.evaluate(() => { const d = Array.from(document.querySelectorAll('[role="dialog"]')).find((x) => (x.getAttribute('aria-label') ?? '') === '添加今日新单词'); const m = d?.closest('.mm-mask'); return { dialogBg: d ? getComputedStyle(d).backgroundColor : '', opacity: d ? getComputedStyle(d).opacity : '', maskBg: m ? getComputedStyle(m).backgroundColor : '', maskZ: m ? getComputedStyle(m).zIndex : '' } })
  record('dialogStyle', style)
  const alpha = /rgba\([^)]*,\s*0?\.\d+\)/.test(style.dialogBg)
  assert(style.opacity === '1' && !alpha && !/transparent/.test(style.dialogBg), `弹窗应不透明：${JSON.stringify(style)}`)
  await page.screenshot({ path: join(OUT, '103-manual5-home-390.png') }).catch(() => {})
  await page.getByRole('button', { name: '取消', exact: true }).click().catch(() => {}); await page.waitForTimeout(300)
  // 详情返回
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(1000)
  await page.getByLabel('返回详情').click(); await page.waitForTimeout(1800)
  const back = await page.evaluate(() => ({ url: location.href, rows: document.querySelectorAll('.mm-list button.mm-row').length, loading: document.querySelectorAll('.study-loading').length }))
  record('detailBack', back); assert(/decks\/kaoyan/.test(back.url) && back.rows > 0 && back.loading === 0, `详情返回失败：${JSON.stringify(back)}`)
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke390', layout); assert(!layout.overflow, '390 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]; assert(result.errors.length === 0, `errors：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[final2] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[final2] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '59-final2-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-final2.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
