#!/usr/bin/env node
/** 0.4.0-A w-c：三小次/非三小次均三步流程；root 完整展示；设置关闭隐藏；390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t400a] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setRoot = (value) => page.evaluate(async (root) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const id = 'kaoyan-2027-dagang:denounce'
  const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get(id); r.onsuccess = () => res(r.result) })
  if (w) await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rootEtymology: root }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, value)
const setSetting = (key, value) => page.evaluate(async ({ key, value }) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, { key, value })
const enter = async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 120_000); await page.waitForTimeout(900)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1200)
  await openAnnotation(page); await page.waitForTimeout(400)
  await page.getByRole('button', { name: '记忆', exact: true }).first().click(); await page.waitForTimeout(1000)
  return page.evaluate(() => ({
    stage: document.querySelectorAll('.memory-stage').length,
    process: document.querySelectorAll('.wc-root-process').length,
    processOpen: document.querySelector('.wc-root-process')?.hasAttribute('open') ?? false,
    summary: document.querySelector('.wc-root-process summary')?.textContent ?? '',
    steps: Array.from(document.querySelectorAll('.wc-root-process-list li')).map((x) => x.textContent ?? ''),
    oldHint: document.body.innerText.includes('请熟悉/记忆下述映射'),
    rootParts: Array.from(document.querySelectorAll('.wc-root-etymology-part')).map((x) => x.innerText.replace(/\s+/g, ' ')),
    rootLines: Array.from(document.querySelectorAll('.wc-root-etymology-line')).map((x) => x.textContent ?? ''),
    body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160),
  }))
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await setRoot({ parts: [{ type: 'prefix', text: 'de-', meaning: '向下' }, { type: 'root', text: 'nounce', meaning: '宣布' }], etymology: '来自拉丁 denuntiare', composition: 'de- + nounce' })
  await setSetting('memory.threeTapRecall', true)
  const on = await enter(); record('threeTapOn', on)
  assert(on.process === 1 && on.processOpen && /词根词缀法记忆流程/.test(on.summary) && on.steps.length === 3 && !on.oldHint, `三小次三步失败：${JSON.stringify(on)}`)
  assert(on.rootParts.length === 2 && on.rootParts.some((t) => t.includes('前缀') && t.includes('de-') && t.includes('向下')) && on.rootLines.some((t) => t.includes('词源')) && on.rootLines.some((t) => t.includes('组合')), `root 完整展示失败：${JSON.stringify({ parts: on.rootParts, lines: on.rootLines })}`)
  await page.screenshot({ path: join(OUT, '124-wc-root-on-390.png') }).catch(() => {})
  // 非三小次
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(500)
  await setSetting('memory.threeTapRecall', false)
  const off = await enter(); record('threeTapOff', off)
  assert(off.process === 1 && off.processOpen && /词根词缀法记忆流程/.test(off.summary) && off.steps.length === 3 && !off.oldHint, `非三小次三步失败：${JSON.stringify(off)}`)
  await page.screenshot({ path: join(OUT, '125-wc-root-off-390.png') }).catch(() => {})
  // 设置关闭 root：重新进入
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(400)
  await setSetting('study.showRootEtymology', false)
  const hidden = await enter(); record('rootHidden', hidden)
  assert(hidden.rootParts.length === 0 && hidden.rootLines.length === 0, `关闭 root 后仍显示：${JSON.stringify({ parts: hidden.rootParts, lines: hidden.rootLines })}`)
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  await page.screenshot({ path: join(OUT, '126-wc-root-360.png') }).catch(() => {})
  assert(!layout.overflow, '360 不应溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `errors：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t400a] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t400a] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '53-task400a-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task400a.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
