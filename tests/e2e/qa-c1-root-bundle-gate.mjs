#!/usr/bin/env node
/** 0.4.0 C1 词根缀源 bundle 导出/导入：手改优先/缺词跳过/checksum拒绝、390/360。不调 API。 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[c1] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const seed = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const get = (id) => new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get(id); r.onsuccess = () => res(r.result) })
  const put = (w) => new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put(w); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  const a = await get('kaoyan-2027-dagang:denounce'); const b = await get('kaoyan-2027-dagang:technical')
  await put({ ...a, rootEtymology: { parts: [{ type: 'prefix', text: 'de-', meaning: '向下', source: 'manual', updatedAt: Date.now() }], etymology: 'QA手改词源', source: 'manual', updatedAt: Date.now() }, rootEtymologyCheckedAt: Date.now(), rootEtymologyVersion: 'qa' })
  await put({ ...b, rootEtymology: { parts: [{ type: 'root', text: 'techn', meaning: '技艺', source: 'ai', updatedAt: Date.now() }], etymology: 'QA AI词源', source: 'ai', updatedAt: Date.now() } })
})
const importFile = async (path) => {
  const fc = page.waitForEvent('filechooser', { timeout: 5000 })
  await page.getByText('导入词根缀源', { exact: true }).first().click()
  const chooser = await fc; await chooser.setFiles(path); await page.waitForTimeout(1500)
  const dlg = page.getByRole('dialog', { name: '词根缀源导入报告' }).first()
  const text = (await dlg.innerText().catch(() => '')).replace(/\s+/g, ' ')
  return text
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await seed()
  await page.goto(`${BASE}#/me/import-export`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  await page.getByText('导出词根缀源', { exact: true }).first().click()
  const exDlg = page.getByRole('dialog', { name: '导出词根缀源' }).first(); await exDlg.waitFor({ state: 'visible', timeout: 5000 })
  const dlPromise = page.waitForEvent('download', { timeout: 10_000 })
  await exDlg.getByRole('button', { name: '全部词库' }).click()
  const dl = await dlPromise; const path1 = '/tmp/qa-root-bundle.json'; await dl.saveAs(path1)
  const text1 = await readFile(path1, 'utf8'); const bundle = JSON.parse(text1)
  record('export', { format: bundle.format, version: bundle.formatVersion, items: bundle.items?.length, checksum: Boolean(bundle.checksum), hasManual: bundle.items?.some((x) => x.wordId.endsWith(':denounce') && x.rootEtymology?.source === 'manual'), hasAi: bundle.items?.some((x) => x.wordId.endsWith(':technical')) })
  assert(bundle.format === 'momo-root-etymology-bundle' && bundle.items.length >= 2 && bundle.checksum, `导出bundle异常：${JSON.stringify({ items: bundle.items?.length, checksum: bundle.checksum })}`)
  // 手改优先 + AI覆盖：先改 denounce 手改原文，再导入旧 bundle
  await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) }); await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rootEtymology: { ...w.rootEtymology, etymology: '手改后不应被覆盖', source: 'manual', updatedAt: Date.now() } }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) }) })
  const okReport = await importFile(path1); record('importValid', { okReport: okReport.slice(0, 200) })
  assert(/更新 1/.test(okReport) && /跳过手改 1/.test(okReport), `手改优先/AI更新失败：${okReport}`)
  const rootState = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const a = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) }); const b = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:technical'); r.onsuccess = () => res(r.result) }); return { manual: a?.rootEtymology?.etymology, ai: b?.rootEtymology?.etymology } })
  record('rootAfter', rootState); assert(rootState.manual === '手改后不应被覆盖' && rootState.ai === 'QA AI词源', `手改保护/更新错误：${JSON.stringify(rootState)}`)
  await page.getByRole('button', { name: '关闭' }).last().click().catch(() => {})
  // 缺词跳过：无 checksum + 伪造 item
  const missing = { ...bundle, checksum: undefined, items: [...bundle.items, { wordId: 'kaoyan-2027-dagang:__missing__', headword: 'ghost', deckId: 'kaoyan-2027-dagang' }] }
  await writeFile('/tmp/qa-root-missing.json', JSON.stringify(missing))
  const missReport = await importFile('/tmp/qa-root-missing.json'); record('importMissing', { missReport: missReport.slice(0, 200) })
  assert(/缺词 1/.test(missReport), `缺词跳过未报告：${missReport}`)
  await page.getByRole('button', { name: '关闭' }).last().click().catch(() => {})
  // checksum 错误拒绝
  const corrupt = { ...bundle, checksum: 'deadbeef' }
  await writeFile('/tmp/qa-root-corrupt.json', JSON.stringify(corrupt))
  const badReport = await importFile('/tmp/qa-root-corrupt.json'); record('importBadChecksum', { badReport: badReport.slice(0, 200) })
  assert(/checksum|校验/.test(badReport), `checksum 错误未拒绝：${badReport}`)
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  await page.screenshot({ path: join(OUT, '135-c1-root-bundle-360.png') }).catch(() => {})
  assert(!layout.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[c1] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[c1] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '50-c1-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-c1.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
