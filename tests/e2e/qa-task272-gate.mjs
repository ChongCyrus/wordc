#!/usr/bin/env node
/** 0.3.92 task-272 Web：预装内容行=浏览器版不含、无全局导入条；详情返回不卡 loading；390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t272] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const meText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('preinstallWeb', { row: /预装内容/.test(meText), webHint: /浏览器版不含预装数据/.test(meText), globalBar: /预装内容导入中/.test(meText) })
  assert(/预装内容/.test(meText) && /浏览器版不含预装数据/.test(meText), `Web 预装行应显示浏览器版不含：${meText.slice(-260)}`)
  assert(!/预装内容导入中/.test(meText), 'Web 不应出现全局预装导入条')
  await page.screenshot({ path: join(OUT, '97-preinstall-web-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('me360', layout)
  await page.screenshot({ path: join(OUT, '97-preinstall-web-360.png') }).catch(() => {})
  assert(!layout.overflow, 'Me 360不应溢出')
  await page.setViewportSize({ width: 390, height: 844 })
  // 详情返回不卡
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(1400)
  assert(/detailWord=/.test(page.url()), `应进详情：${page.url()}`)
  await page.goBack(); await page.waitForTimeout(1800)
  const backText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const searchVisible = await page.locator('input[placeholder*="搜索英文"]').first().isVisible().catch(() => false)
  record('detailBack', { url: page.url(), searchVisible, loadingStuck: /正在加载今日学习/.test(backText), text: backText.slice(0, 140) })
  assert(searchVisible && !/正在加载今日学习/.test(backText), `详情返回不应卡 loading：${JSON.stringify({ searchVisible, backText: backText.slice(0, 100) })}`)
  await page.screenshot({ path: join(OUT, '98-detail-back-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t272] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t272] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '65-task272-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task272.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
