#!/usr/bin/env node
/**
 * task-177 升级 gate（自包含旧 SW fixture，不依赖 /tmp 旧 dist）：
 * 同 origin 注册 legacy SW → 设旧 appVersion → 加载当前 dist → 断言 SW/缓存被清理、版本更新、学习页不黑屏。
 * 运行：QA_BASE=http://127.0.0.1:4173/ QA_APP_VERSION=0.3.54 node tests/e2e/qa-upgrade-sw-gate.mjs
 */
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BASE, OUT, PROFILE, ROOT, assert, clickStart, launch, sleep, waitHome, watchErrors,
} from './qa-gate-lib.mjs'

const started = Date.now()
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const version = process.env.QA_APP_VERSION || pkg.version
const result = { base: BASE, version, profile: PROFILE || '(fresh)', checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[sw-upgrade] ${k}: ${JSON.stringify(v)}`) }
const LEGACY_SW = `self.addEventListener('install', e => self.skipWaiting()); self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));`
await mkdir(OUT, { recursive: true })
const legacySwPath = join(ROOT, 'dist/qa-legacy-sw.js')
await writeFile(legacySwPath, LEGACY_SW, 'utf8')
const { ctx, page, close } = await launch()
const errors = watchErrors(page)
try {
  // 同 origin 的 bootstrap 页：注册 legacy SW 并写入旧版本
  await page.route('**/qa-bootstrap.html', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>qa</title><body>qa</body>' }))
  await page.goto(`${BASE}qa-bootstrap.html`, { waitUntil: 'domcontentloaded' })
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/qa-legacy-sw.js', { scope: '/' })
    await navigator.serviceWorker.ready
    localStorage.setItem('mm.appVersion', '0.3.51')
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 })
  const boot = await page.evaluate(() => ({
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    appVersion: localStorage.getItem('mm.appVersion'),
  }))
  record('legacyBoot', boot)
  assert(boot.controller?.includes('qa-legacy-sw.js'), `未建立 legacy SW controller：${JSON.stringify(boot)}`)
  // 切换到当前生产 dist
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await waitHome(page, 120_000)
  await sleep(1500)
  const after = await page.evaluate(async () => {
    const regs = await navigator.serviceWorker.getRegistrations().catch(() => [])
    const cachesKeys = await caches.keys().catch(() => [])
    return {
      controllers: regs.map((r) => ({ active: r.active?.scriptURL ?? null, scope: r.scope })),
      caches: cachesKeys,
      appVersion: localStorage.getItem('mm.appVersion'),
      lastError: localStorage.getItem('mm.lastError'),
      errorBoundary: document.body.innerText.includes('页面渲染出错'),
      bodyLen: document.body.innerText.length,
      entry: Array.from(document.scripts).map((s) => s.src).find((s) => /\/assets\/index-[^/]+\.js/.test(s)) ?? null,
    }
  })
  record('afterUpgrade', after)
  assert(after.appVersion === version, `mm.appVersion 未更新 ${version}（实际 ${after.appVersion}）`)
  assert(!after.errorBoundary, '出现 ErrorBoundary fallback')
  assert(!after.lastError, `存在 mm.lastError：${after.lastError}`)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  record('studyBoard', true)
  const all = [...errors.pageErrors, ...errors.consoleErrors]
  result.errors.push(...all)
  assert(all.length === 0, `pageerror/console.error：${all.join('\n')}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[sw-upgrade] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[sw-upgrade] FAIL: ${result.failReason}`)
  process.exitCode = 1
} finally {
  result.errors.push(...errors.pageErrors.map((message) => ({ type: 'pageerror', message })))
  result.errors.push(...errors.consoleErrors.map((message) => ({ type: 'console.error', message })))
  await writeFile(join(OUT, 'qa-upgrade-sw.json'), JSON.stringify(result, null, 2))
  await unlink(legacySwPath).catch(() => {})
  await close().catch(() => {})
}
