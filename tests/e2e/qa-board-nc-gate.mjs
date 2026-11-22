#!/usr/bin/env node
/** 0.3.72 白板 nc 仅词性（无中文）+ 本义「标记不常考」按钮不拉伸；390 截图。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[board-nc] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
    await new Promise((res, rej) => { const tx = db.transaction(['plans', 'settings'], 'readwrite'); const st = tx.objectStore('plans'); const g = st.get(id); g.onsuccess = () => { const p = g.result; if (p) st.put({ ...p, index: 1 }) }; tx.objectStore('settings').put({ key: 'study.hideRareBlocks', value: false, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await page.waitForTimeout(500)
  const board = await page.evaluate(() => {
    const nc = document.querySelector('.board-nc')
    const text = nc?.textContent ?? ''
    return { text: text.replace(/\s+/g, ' '), hasCjk: /[\u4e00-\u9fa5]/.test(text), hasPos: /\[(n|vt|vi|adj|adv)\.\]/.test(text), overflow: document.documentElement.scrollWidth > innerWidth + 1 }
  })
  record('boardNc', board)
  await page.screenshot({ path: join(OUT, '41-board-nc-390.png') }).catch(() => {})
  assert(board.hasPos && !board.hasCjk && !board.overflow, `白板 nc 应仅词性无中文：${JSON.stringify(board)}`)
  await page.mouse.click(195, Math.round(844 * 0.45))
  await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForTimeout(400)
  const btn = await page.evaluate(() => {
    const b = document.querySelector('.rare-toggle-btn')
    const card = b?.closest('.core-sense-card, .meaning-row, .meanings > div')
    const br = b?.getBoundingClientRect()
    const cr = card?.getBoundingClientRect()
    return br && cr ? { buttonWidth: Math.round(br.width), containerWidth: Math.round(cr.width), ratio: br.width / cr.width } : null
  })
  record('rareButton', btn ?? {})
  await page.screenshot({ path: join(OUT, '42-rare-button-390.png') }).catch(() => {})
  assert(btn && btn.ratio <= 0.85, `本义不常考按钮不应拉伸：${JSON.stringify(btn)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[board-nc] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[board-nc] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '89-board-nc-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-board-nc.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
