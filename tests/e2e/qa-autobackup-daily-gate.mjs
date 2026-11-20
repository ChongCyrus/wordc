#!/usr/bin/env node
/** 0.3.86：同日多次启动仅1份当日备份、跨天新增、prune7；mock native bridge。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[daily] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
await page.addInitScript(() => {
  const KEY = '__qaDailyMock'
  const st = (() => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null } })() || { files: [], flags: {}, logs: [] }
  const persist = () => localStorage.setItem(KEY, JSON.stringify(st))
  window.__qaDaily = { st, persist, get: () => st }
  window.__qaDailyTexts = {}
  const today = () => new Date().toISOString().slice(0, 10)
  window.MomoBridge = {
    isNativeApp: () => 'momo-apk',
    saveAutoBackup: (name, b64) => {
      let text = ''
      try { const bin = atob(b64); text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))) } catch { text = '' }
      window.__qaDailyTexts[name] = text
      const e = { name, size: text.length, mtime: Date.now(), path: `/auto/${name}` }
      const i = st.files.findIndex((f) => f.name === name)
      if (i >= 0) st.files[i] = e; else st.files.push(e)
      persist(); return `ok:${e.path}`
    },
    listAutoBackups: () => JSON.stringify(st.files),
    readAutoBackup: (n) => window.__qaDailyTexts[n] ?? st.files.find((f) => f.name === n)?.text ?? 'err:missing',
    deleteAutoBackup: (n) => { st.files = st.files.filter((f) => f.name !== n); persist(); return 'ok' },
    pruneAutoBackups: (keep) => { st.files.sort((a, b) => b.mtime - a.mtime); const d = Math.max(0, st.files.length - keep); st.files = st.files.slice(0, keep); st.logs.push(`prune keep=${keep} del=${d}`); persist(); return `ok:${d}` },
    getFlag: (k) => st.flags[k] ?? '',
    setFlag: (k, v) => { st.flags[k] = v; persist(); return 'ok' },
    getWebViewStorageInfo: () => JSON.stringify({}),
    appendDiagLog: (t) => { st.logs.push(t); persist(); return 'ok' },
    selfTestAutoBackup: () => JSON.stringify({ ok: true }),
    readDiagnosticFile: () => JSON.stringify({ ok: true }),
    exportBackupToDownloads: () => 'ok:/mock',
  }
})
const reload = async (ms = 6000) => { await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(ms) }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  const scripts = await page.evaluate(() => Array.from(document.scripts).map((s) => s.src))
  record('scripts', scripts)
  assert(scripts.some((s) => /index-DRDX0lLB\.js/.test(s)), `应加载新入口 DRDX0lLB：${JSON.stringify(scripts)}`)
  if (FIXTURE) await maybeLoadFixture(page)
  // 创建学习进度 state
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.waitForTimeout(600)
  const stateCount = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); return await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').count(); r.onsuccess = () => res(r.result) }) })
  record('states', stateCount)
  assert(stateCount > 0, '应先有学习状态')
  // 清空 mock，同日启动 3 次
  await page.evaluate(() => { const s = window.__qaDaily.get(); s.files = []; s.flags = {}; s.logs = []; window.__qaDaily.persist() })
  await reload(); const one = await page.evaluate(() => window.__qaDaily.get())
  record('sameDay1', { files: one.files.length, names: one.files.map((f) => f.name), flags: one.flags })
  await reload(); await reload();
  const same = await page.evaluate(() => window.__qaDaily.get())
  record('sameDay3', { files: same.files.length, names: same.files.map((f) => f.name), flags: same.flags, logs: same.logs.slice(-4) })
  assert(one.files.length === 1 && same.files.length === 1, `同日多次启动应仅1份：${JSON.stringify({ one: one.files.length, same: same.files.length })}`)
  assert(same.files[0].name.includes(new Date().toISOString().slice(0, 10)), `备份名应含当日日期：${same.files[0].name}`)
  // 跨天：改 lastBackupDate 后启动应新增
  await page.evaluate(() => { const s = window.__qaDaily.get(); s.files = [{ name: 'auto-backup-2000-01-01.migration.json.gz', size: 100, mtime: Date.now() - 86400000, path: '/auto/old' }]; s.flags.lastBackupDate = '2000-01-01'; window.__qaDaily.persist() })
  await reload();
  const cross = await page.evaluate(() => window.__qaDaily.get())
  record('crossDay', { files: cross.files.length, names: cross.files.map((f) => f.name), flags: cross.flags })
  assert(cross.files.length === 2, `跨天启动应新增一份：${JSON.stringify(cross.files.map((f) => f.name))}`)
  // prune7：预置9份旧备份，改 lastDate 后启动
  await page.evaluate(() => { const s = window.__qaDaily.get(); s.files = Array.from({ length: 9 }, (_, i) => ({ name: `old-${i}.json.gz`, size: 100 + i, mtime: Date.now() - (9 - i) * 60000, path: `/auto/old-${i}.json.gz` })); s.flags.lastBackupDate = '2000-01-01'; window.__qaDaily.persist() })
  await reload();
  const pruned = await page.evaluate(() => window.__qaDaily.get())
  record('prune7', { files: pruned.files.length, names: pruned.files.map((f) => f.name), logs: pruned.logs.slice(-4) })
  assert(pruned.files.length === 7 && pruned.logs.some((l) => /prune keep=7/.test(l)), `启动备份后应保留7份：${JSON.stringify(pruned.files.map((f) => f.name))}`)
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 }))
  record('layout360', layout)
  assert(!layout.overflow, '360 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[daily] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[daily] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '75-daily-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-daily.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
