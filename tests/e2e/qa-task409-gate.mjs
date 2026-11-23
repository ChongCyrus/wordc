#!/usr/bin/env node
/** 0.4.9 w-c 词源/组合 2 行折叠/展开/短文本无按钮/390-360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t409] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const LONG_ET = '来自拉丁语 denuntiare，由 de-（向下、完全）与 nuntius（信使、消息）组合，原义是把消息正式传达出去，后引申为公开指责、告发、谴责，并在法律与新闻语境中表示正式控告；其语义从“传递信息”逐步转向“公开宣布某人的过错”，因此现代英语中多用于对人或行为的强烈批评。'
const SHORT_ET = '来自拉丁 denuntiare。'
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async (et) => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const id = 'kaoyan-2027-dagang:denounce'; const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get(id); r.onsuccess = () => res(r.result) }); await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rootEtymology: { parts: [{ type: 'prefix', text: 'de-', meaning: '向下' }, { type: 'root', text: 'nounce', meaning: '宣布' }], etymology: et, composition: 'de- + nounce' } }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) }) }, LONG_ET)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 120_000); await page.waitForTimeout(600)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1000); await openAnnotation(page); await page.waitForTimeout(300); await page.getByRole('button', { name: '加权记忆', exact: true }).first().click(); await page.waitForTimeout(900)
  const snap = () => page.evaluate(() => { const lines = Array.from(document.querySelectorAll('.wc-root-etymology-line-clamp')); const info = lines.map((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight) || 20; return { text: (el.textContent ?? '').slice(0, 40), h: Math.round(r.height), lineHeight: Math.round(lh), lines: Math.round(r.height / lh * 10) / 10, overflow: cs.overflow, maxHeight: cs.maxHeight, scrollH: el.scrollHeight, clientH: el.clientHeight } }); return { lines: info, buttons: Array.from(document.querySelectorAll('.wc-root-etymology-expand')).map((b) => b.textContent?.trim()), parts: document.querySelectorAll('.wc-root-etymology-part').length, body: (document.querySelector('.wc-root-etymology')?.innerText ?? '').replace(/\s+/g, ' ') } })
  const before = await snap(); record('before', before)
  assert(before.parts === 2, `parts 丢失：${before.parts}`)
  assert(before.lines.length === 2, `词源/组合行数异常：${before.lines.length}`)
  assert(before.lines[0].lines <= 2.2, `长词源未折叠2行：${JSON.stringify(before.lines[0])}`)
  assert(before.buttons.length === 1 && before.buttons[0] === '展开', `展开按钮异常：${JSON.stringify(before.buttons)}`)
  const shortLine = before.lines.find((l) => l.text.includes('组合'))
  record('shortLine', shortLine)
  // 展开
  await page.locator('.wc-root-etymology-expand').click(); await page.waitForTimeout(600)
  const expanded = await snap(); record('expanded', expanded)
  const expLine = expanded.lines[0]
  assert(expanded.buttons.includes('收起') && expLine.h > before.lines[0].h, `展开无效：${JSON.stringify({ beforeH: before.lines[0].h, afterH: expLine.h, buttons: expanded.buttons })}`)
  assert(expanded.body.includes(LONG_ET.slice(-12)), '展开后未显示全文')
  await page.screenshot({ path: join(OUT, '150-root-etymology-expanded-390.png') }).catch(() => {})
  // 收起
  await page.locator('.wc-root-etymology-expand').click(); await page.waitForTimeout(600)
  const collapsed = await snap(); record('collapsed', collapsed)
  assert(collapsed.lines[0].lines <= 2.2 && collapsed.buttons[0] === '展开', `收起无效：${JSON.stringify(collapsed.lines[0])}`)
  // 390/360 不撑破
  const lay390 = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('lay390', lay390); assert(!lay390.overflow, '390 横向溢出')
  await page.screenshot({ path: join(OUT, '151-root-etymology-collapsed-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(400)
  const lay360 = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('lay360', lay360); assert(!lay360.overflow, '360 横向溢出')
  await page.screenshot({ path: join(OUT, '151b-root-etymology-360.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t409] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t409] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '42-task409-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task409.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
