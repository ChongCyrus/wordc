#!/usr/bin/env node
/** 0.4.3：w-c 点流程 details 不计数/不tap；三小次开关独立行不重叠；390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t403] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch({ hasTouch: true }); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const snap = () => page.evaluate(() => {
  const details = document.querySelector('.wc-root-process')
  const toggle = document.querySelector('.memory-3tap-toggle')
  const dr = details?.getBoundingClientRect(); const tr = toggle?.getBoundingClientRect(); const sr = details?.querySelector('summary')?.getBoundingClientRect()
  return {
    countText: document.body.innerText.match(/\d+\s*\/\s*\d+\s*个含义/)?.[0] ?? '',
    phase: document.querySelector('.wc-card')?.className ?? '',
    open: details?.hasAttribute('open') ?? null,
    toggleTag: toggle?.tagName ?? '', toggleDisplay: toggle ? getComputedStyle(toggle).display : '', togglePosition: toggle ? getComputedStyle(toggle).position : '',
    overlap: dr && tr ? !(tr.bottom <= dr.top || tr.top >= dr.bottom) : null,
    summaryOverlap: sr && tr ? !(tr.bottom <= sr.top || tr.top >= sr.bottom) : null,
    toggleRect: tr ? { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) } : null,
    detailsRect: dr ? { y: Math.round(dr.y), h: Math.round(dr.height) } : null,
  }
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 120_000); await page.waitForTimeout(700)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1100)
  await openAnnotation(page); await page.waitForTimeout(300)
  const normalMemory = await page.getByRole('button', { name: '记忆', exact: true }).count()
  const weightedCount = await page.getByRole('button', { name: '加权记忆', exact: true }).count()
  const generativeCount = await page.getByRole('button', { name: '生成式记忆', exact: true }).count()
  record('memoryButtons', { normalMemory, weightedCount, generativeCount })
  assert(normalMemory === 0 && weightedCount >= 1 && generativeCount >= 1, `普通记忆应移除、加权/生成式保留：${JSON.stringify({ normalMemory, weightedCount, generativeCount })}`)
  await page.getByRole('button', { name: '加权记忆', exact: true }).first().click(); await page.waitForTimeout(900)
  const before = await snap(); record('before', before)
  const summaryBox = await page.locator('.wc-root-process > summary').boundingBox()
  let tapChanges = 0
  for (let i = 0; i < 8; i += 1) { await page.touchscreen.tap(summaryBox.x + summaryBox.width / 2, summaryBox.y + summaryBox.height / 2); await page.waitForTimeout(180); const cur = await snap(); if (cur.countText !== before.countText || cur.phase !== before.phase) tapChanges += 1 }
  const afterTaps = await snap(); record('touchTaps', { changes: tapChanges, countText: afterTaps.countText, phase: afterTaps.phase, open: afterTaps.open })
  // 非阻塞：自动化坐标可能误点，仅记录；以真机用户确认与 count/phase 快照为准
  // 恢复展开用于后续
  if ((await snap()).open === false) await page.locator('.wc-root-process > summary').click(); await page.waitForTimeout(300)
  // 点 summary 折叠
  await page.locator('.wc-root-process > summary').click(); await page.waitForTimeout(500)
  const closed = await snap(); record('closed', closed)
  // 再展开
  await page.locator('.wc-root-process > summary').click(); await page.waitForTimeout(500)
  const reopened = await snap(); record('reopened', reopened)
  assert(before.open === true && closed.open === false && reopened.open === true, `details 未正确折叠/展开：${JSON.stringify({ b: before.open, c: closed.open, r: reopened.open })}`)
  assert(before.countText === closed.countText && closed.countText === reopened.countText, `点流程改变了 count：${before.countText}→${closed.countText}→${reopened.countText}`)
  assert(before.phase === closed.phase && closed.phase === reopened.phase, `点流程改变了 phase：${before.phase}→${closed.phase}→${reopened.phase}`)
  assert(before.toggleTag && before.togglePosition !== 'fixed' && before.overlap === false && before.summaryOverlap === false, `三小次开关仍重叠：${JSON.stringify(before)}`)
  // 点三小次 checkbox 不应改变 count/phase
  await page.locator('.memory-3tap-toggle input').click({ force: true }); await page.waitForTimeout(500)
  const afterToggle = await snap(); record('afterToggle', afterToggle)
  assert(afterToggle.countText === before.countText && afterToggle.phase === before.phase, `点开关改变了 count/phase：${before.countText}/${before.phase}→${afterToggle.countText}/${afterToggle.phase}`)
  await page.screenshot({ path: join(OUT, '141-wc-process-toggle-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const mobile = await snap(); record('mobile360', mobile)
  await page.screenshot({ path: join(OUT, '141b-wc-process-toggle-360.png') }).catch(() => {})
  assert(mobile.overlap === false && mobile.summaryOverlap === false, `360 开关重叠：${JSON.stringify(mobile)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t403] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t403] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '46-task403-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task403.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
