#!/usr/bin/env node
/** 0.3.92 诊断：详情返回三条路径 + 10s 后 URL/body/loading/root/errors。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t272d] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
if (FIXTURE) await maybeLoadFixture(page)
const assets = await page.evaluate(() => ({ scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean), css: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => l.href) }))
record('assets', assets)
const probe = async (p) => p.evaluate(() => ({
  url: location.href,
  body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220),
  studyLoading: document.querySelectorAll('.study-loading').length,
  root: document.querySelectorAll('#root').length,
  bodyChildren: document.body.children.length,
  htmlLen: document.body.innerHTML.length,
  perf: performance.getEntriesByType('resource').filter((e) => /generated|packs|momo|\.json/.test(e.name)).slice(-8).map((e) => ({ name: e.name.split('/').pop(), duration: Math.round(e.duration), size: e.transferSize, status: e.responseStatus })),
}))
const newPage = async () => {
  const p = await page.context().newPage()
  const errs = watchErrors(p)
  const failed = []
  p.on('requestfailed', (r) => failed.push({ url: r.url(), err: r.failure()?.errorText }))
  if (FIXTURE) await p.route('**/packs/**', (r) => r.abort())
  await p.setViewportSize({ width: 390, height: 844 })
  return { p, errs, failed }
}
const openDetail = async (p) => {
  await p.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(1200)
  await p.locator('.mm-list button.mm-row').first().click(); await p.waitForTimeout(1200)
  return p.url()
}
try {
  for (const [name, action] of [
    ['a-appBack', async (p) => { await p.getByLabel('返回详情').click() }],
    ['b-goBack', async (p) => { await p.goBack() }],
    ['c-gotoReload', async (p) => { await p.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await p.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }) }],
  ]) {
    const { p, errs, failed } = await newPage()
    const detailUrl = await openDetail(p)
    const before = await probe(p)
    let actionErr = ''
    try { await action(p) } catch (e) { actionErr = e instanceof Error ? e.message : String(e) }
    await p.waitForTimeout(10_000)
    const after = await probe(p)
    record(name, { detailUrl, beforeUrl: before.url, beforeBody: before.body.slice(0, 100), actionErr, after, console: [...errs.pageErrors, ...errs.consoleErrors].slice(-5), failed: failed.slice(-5) })
    await p.screenshot({ path: join(OUT, `99-return-${name}.png`) }).catch(() => {})
    await p.close().catch(() => {})
  }
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t272d] DONE in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t272d] FAIL: ${result.failReason}`)
} finally { await writeFile(join(OUT, 'qa-task272-diag.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
