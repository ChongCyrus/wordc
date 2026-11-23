#!/usr/bin/env node
/** 0.3.77 task-231：13k 本义助记导入读取/校验/应用进度与落地抽查。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[bigimport] ${k}: ${JSON.stringify(v)}`) }
const file = '/sdcard/Download/DSH-Go/背单词-本义助记-生成-2026-11-17.json'
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.getByText('导入本义助记', { exact: true }).first().click()])
  const clickAt = Date.now()
  await chooser.setFiles(file)
  await page.waitForTimeout(250)
  const busy = await page.evaluate(() => {
    const text = document.body.innerText.replace(/\s+/g, ' ')
    return { hasBusy: /读取\/校验中|校验中|读取中/.test(text), text: text.slice(-220), disabled: Array.from(document.querySelectorAll('button')).some((b) => /导入本义助记|取消/.test(b.textContent ?? '') && b.disabled) }
  })
  record('immediateBusy', { ms: Date.now() - clickAt, ...busy })
  await page.screenshot({ path: join(OUT, '56-core-import-13k-busy-390.png') }).catch(() => {})
  assert(busy.hasBusy, `选文件后应立即显示读取/校验中：${busy.text}`)
  const dlg = page.getByRole('dialog', { name: '导入本义助记' }).first()
  await dlg.waitFor({ state: 'visible', timeout: 180_000 })
  const preview = (await dlg.innerText()).replace(/\s+/g, ' ')
  record('preview', { ms: Date.now() - clickAt, text: preview.slice(0, 300) })
  await page.screenshot({ path: join(OUT, '57-core-import-13k-preview-390.png') }).catch(() => {})
  assert(/本义助记 \d+ 条/.test(preview), `13k 文件应出预览：${preview.slice(0, 200)}`)
  await dlg.getByRole('button', { name: '确认导入（合并）' }).click()
  const resultDlg = page.getByRole('dialog', { name: '导入结果' }).first()
  await resultDlg.waitFor({ state: 'visible', timeout: 180_000 })
  const done = (await resultDlg.innerText()).replace(/\s+/g, ' ')
  record('done', { ms: Date.now() - clickAt, text: done.slice(0, 320) })
  await page.screenshot({ path: join(OUT, '58-core-import-13k-result-390.png') }).catch(() => {})
  const db = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const rows = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const withContent = rows.filter((w) => w.coreSenseOverview?.text || (w.senseMnemonics?.length ?? 0) > 0)
    return { contentWords: withContent.length, samples: withContent.slice(0, 3).map((w) => ({ headword: w.headword, mnemonics: w.senseMnemonics?.length ?? 0, overview: Boolean(w.coreSenseOverview?.text) })) }
  })
  record('spotcheck', db)
  assert(db.contentWords > 0 && db.samples.length > 0, `导入后应至少抽查到助记/串联落地：${JSON.stringify(db)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[bigimport] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[bigimport] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '84-bigimport-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-bigimport.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
