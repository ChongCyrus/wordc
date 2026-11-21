#!/usr/bin/env node
/** 0.3.86 task-254 Web 降级：自动备份仅 APK；不静默下载；立即/恢复不可用；持久化提示；390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[autobk] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
let downloads = 0
page.on('download', () => { downloads += 1 })
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000).catch(() => {})
  await page.waitForTimeout(900)
  const txt = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('webLabels', {
    backup: /自动备份/.test(txt),
    webManual: /自动备份存 App 内部（清 WebView 数据不丢），浏览器版请手动导出/.test(txt),
    dailyUnavailable: /每日自动备份/.test(txt) && /不可用/.test(txt),
    nowHint: /当前环境不支持，请手动导出/.test(txt),
    restoreHint: /浏览器版请手动导入/.test(txt),
    persist: /持久化存储/.test(txt),
  })
  assert(/自动备份存 App 内部（清 WebView 数据不丢），浏览器版请手动导出/.test(txt), 'Web 应提示内部存储+浏览器手动导出')
  assert(/每日自动备份/.test(txt) && /不可用/.test(txt), 'Web 每日自动备份应显示不可用')
  assert(/当前环境不支持，请手动导出/.test(txt) && /浏览器版请手动导入/.test(txt), 'Web 立即/恢复应提示不支持')
  assert(/持久化存储/.test(txt), '应有持久化存储状态')
  const sw = await page.getByRole('switch', { name: '每日自动备份' }).count()
  record('dailySwitchCount', sw)
  assert(sw === 0, 'Web 不应出现每日自动备份开关')
  // 点击立即备份/恢复不应下载/弹窗/报错
  await page.getByText('立即备份', { exact: true }).first().click()
  await page.getByText('从自动备份恢复', { exact: true }).first().click()
  await page.waitForTimeout(600)
  const dlg = await page.locator('.mm-dialog').filter({ hasText: '从自动备份恢复' }).count()
  record('webClicks', { downloads, dialog: dlg })
  assert(downloads === 0 && dlg === 0, `Web 不应静默下载/打开恢复：${JSON.stringify({ downloads, dlg })}`)
  await page.screenshot({ path: join(OUT, '76-autobackup-web-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, pageOverflowX: document.body.scrollWidth > innerWidth + 1 }))
  record('layout360', layout)
  await page.screenshot({ path: join(OUT, '76b-autobackup-web-360.png') }).catch(() => {})
  assert(!layout.overflow, '360 不应横向溢出')
  const dbg = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const row = await new Promise((res) => { const r = db.transaction('settings', 'readonly').objectStore('settings').get('data.autoBackupEnabled'); r.onsuccess = () => res(r.result) })
    return { settingRow: row?.value ?? null, bridge: typeof window.MomoBridge }
  })
  record('dbDebug', dbg)
  assert(dbg.settingRow == null || dbg.settingRow === true, `Web 默认 autoBackupEnabled 应为 true/未写：${JSON.stringify(dbg)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[autobk] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[autobk] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '78-autobackup-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-autobackup.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
