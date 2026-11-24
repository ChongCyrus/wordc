#!/usr/bin/env node
/** 0.10.0 模拟 IndexedDB eviction：清空 Dexie 但保留 native checkpoint → 启动恢复 states/plans，words 重新补种。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[evict] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
await page.addInitScript(() => {
  const KEY = '__qaEvict'
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null } }
  const st = load() || { files: [], flags: {}, logs: [] }
  const persist = () => localStorage.setItem(KEY, JSON.stringify({ files: st.files, flags: st.flags, logs: st.logs }))
  window.__qaEvict = st
  window.MomoBridge = {
    isNativeApp: () => 'momo-apk', getFlag: (k) => st.flags[k] ?? '', setFlag: (k, v) => { st.flags[k] = v; persist(); return 'ok' },
    saveAutoBackup: (name, text) => { const i = st.files.findIndex((f) => f.name === name); const e = { name, text: String(text ?? ''), size: String(text ?? '').length, mtime: Date.now(), path: `/auto/${name}` }; if (i >= 0) st.files[i] = e; else st.files.push(e); persist(); return `ok:/auto/${name}` },
    listAutoBackups: () => JSON.stringify(st.files.map(({ text, ...e }) => e)), readAutoBackup: (name) => st.files.find((f) => f.name === name)?.text ?? '', deleteAutoBackup: (name) => { st.files = st.files.filter((f) => f.name !== name); persist(); return 'ok' }, pruneAutoBackups: () => 'ok:0',
    getWebViewStorageInfo: () => '{}', appendDiagLog: (t) => { st.logs.push(t); persist(); return 'ok' }, selfTestAutoBackup: () => '{}', readDiagnosticFile: () => '{}', exportBackupToDownloads: () => 'ok:/x',
  }
})
const counts = () => page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const c = (s) => new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).count(); r.onsuccess = () => res(r.result) }); const meta = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('checkpoint.lastState'); r.onsuccess = () => res(r.result?.value ?? null) }); return { decks: await c('decks'), words: await c('words'), states: await c('states'), plans: await c('plans'), logs: await c('reviewLogs'), checkpoint: meta, bridgeFiles: (window.__qaEvict?.files ?? []).map((f) => f.name) } })
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 120_000); await page.waitForTimeout(700)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1600); if (await page.locator('.board-stage').count()) await openAnnotation(page); await page.waitForTimeout(400)
  const rate = page.locator('button.rating-btn--know'); if (await rate.count()) await rate.first().click(); await page.waitForTimeout(3500)
  const before = await counts(); record('beforeEvict', before)
  assert(before.checkpoint != null && (before.checkpoint.state === 'saved' || before.checkpoint.at), `评分后未写检查点：${JSON.stringify(before.checkpoint)}`)
  // 模拟 IndexedDB 被回收：清空关键表（保留 native checkpoint/localStorage）
  await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); await new Promise((res, rej) => { const tx = db.transaction(['decks', 'words', 'states', 'plans', 'reviewLogs', 'meta'], 'readwrite'); for (const s of ['decks', 'words', 'states', 'plans', 'reviewLogs', 'meta']) tx.objectStore(s).clear(); tx.oncomplete = res; tx.onerror = () => rej(tx.error) }) })
  const evicted = await counts(); record('evicted', evicted); assert(evicted.decks === 0 && evicted.words === 0 && evicted.states === 0, `eviction 模拟失败：${JSON.stringify(evicted)}`)
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(6000)
  const after = await counts(); record('afterRestart', after)
  assert(after.decks > 0 && after.words > 0, `重启后 words/decks 未补种：${JSON.stringify(after)}`)
  assert(after.states > 0 && after.plans > 0, `重启后未从 checkpoint 恢复 states/plans：${JSON.stringify(after)}`)
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('bodyStart', body.slice(0, 160))
  await page.screenshot({ path: join(OUT, '169-eviction-restored-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const small = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', small); assert(!small.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[evict] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[evict] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '36-eviction-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-eviction.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
