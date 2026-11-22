#!/usr/bin/env node
/** 0.4.6 w-c：流程默认收起、提示、只卡片推进、96vw；390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[wc406] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch({ hasTouch: true }); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const snap = () => page.evaluate(() => {
  const d = document.querySelector('.wc-root-process'); const card = document.querySelector('.wc-card'); const hint = document.querySelector('.memory-tap-hint'); const tap = document.querySelector('.memory-stage-tap')
  const cr = card?.getBoundingClientRect(); const hr = hint?.getBoundingClientRect(); const tr = tap?.getBoundingClientRect()
  const aria = document.querySelector('.memory-stage-tap')?.getAttribute('aria-label') ?? ''; const stack = document.querySelector('.memory-top-stack'); const sr = stack?.getBoundingClientRect(); const sum = document.querySelector('.wc-root-process > summary')?.getBoundingClientRect(); const overlap = sr && sum ? !(sr.bottom <= sum.top || sr.top >= sum.bottom || sr.right <= sum.left || sr.left >= sum.right) : null; return { stack: sr ? { x: Math.round(sr.x), y: Math.round(sr.y), w: Math.round(sr.width), h: Math.round(sr.height) } : null, summary: sum ? { x: Math.round(sum.x), y: Math.round(sum.y), w: Math.round(sum.width), h: Math.round(sum.height) } : null, stackSummaryOverlap: overlap, count: aria.match(/已记 (\d+)/)?.[1] ?? '', aria, open: d?.hasAttribute('open') ?? null, hintText: hint?.textContent ?? '', hintVisible: hint ? getComputedStyle(hint).display !== 'none' : false, card: cr ? { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) } : null, tap: tr ? { x: Math.round(tr.x), y: Math.round(tr.y), w: Math.round(tr.width), h: Math.round(tr.height) } : null, hintRect: hr ? { y: Math.round(hr.y), h: Math.round(hr.height) } : null, vw: innerWidth }
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 120_000); await page.waitForTimeout(700)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1100)
  await openAnnotation(page); await page.waitForTimeout(300)
  await page.getByRole('button', { name: '加权记忆', exact: true }).first().click(); await page.waitForTimeout(900)
  const before = await snap(); record('before', before)
  assert(before.open === false, '流程默认应收起')
  record('topStack', { stack: before.stack, summary: before.summary, overlap: before.stackSummaryOverlap })
  assert(before.stack && before.stackSummaryOverlap === false, `top-stack 与 summary 重叠：${JSON.stringify({ stack: before.stack, summary: before.summary })}`)
  assert(before.hintVisible && /轻触卡片，进入下一页/.test(before.hintText), `提示不可见：${before.hintText}`)
  const hintGeom = await page.evaluate(() => { const h = document.querySelector('.memory-tap-hint')?.getBoundingClientRect(); const c = document.querySelector('.wc-card')?.getBoundingClientRect(); return { y: Math.round(h?.y ?? -1), h: Math.round(h?.height ?? 0), cardY: Math.round(c?.y ?? -1), vh: innerHeight } })
  record('hintFirstScreen', hintGeom)
  assert(hintGeom.y >= 0 && hintGeom.y + hintGeom.h <= hintGeom.vh && hintGeom.y < hintGeom.cardY, `提示不在首屏或不在卡片上方：${JSON.stringify(hintGeom)}`)
  assert(before.card && before.card.w >= before.vw * 0.9, `卡片宽度不足 96vw：${JSON.stringify(before.card)}`)
  // 点 workflow 不计数，仅展开
  await page.locator('.wc-root-process > summary').click(); await page.waitForTimeout(400)
  const afterWorkflow = await snap(); record('afterWorkflow', afterWorkflow)
  assert(afterWorkflow.count === before.count && afterWorkflow.open === true, `workflow 点击改变了 count：${before.count}→${afterWorkflow.count}`)
  // 点提示不计数
  await page.locator('.memory-tap-hint').click({ force: true }); await page.waitForTimeout(400)
  const afterHint = await snap(); record('afterHint', afterHint); assert(afterHint.count === before.count, '点提示改变了 count')
  // 点空白/卡片外不计数（workflow 区域）
  await page.locator('.wc-memory-reminder').click({ position: { x: 5, y: 5 }, force: true }); await page.waitForTimeout(400)
  const afterBlank = await snap(); record('afterBlank', afterBlank); assert(afterBlank.count === before.count, '点空白/卡片外改变了 count')
  // 点卡片推进
  const tap = await page.locator('.memory-stage-tap').boundingBox()
  const tapArias = []
  for (let i = 0; i < 4; i += 1) { await page.touchscreen.tap(tap.x + tap.width / 2, tap.y + tap.height / 2); await page.waitForTimeout(500); tapArias.push((await snap()).aria) }
  const afterCard = await snap(); record('afterCard', { afterCard, tapArias })
  assert(tapArias.some((a) => a !== before.aria), `点卡片未推进 phase/aria：${JSON.stringify(tapArias)}`)
  await page.screenshot({ path: join(OUT, '148-wc-406-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(400)
  const small = await snap(); record('mobile360', small)
  record('topStack360', { stack: small.stack, summary: small.summary, overlap: small.stackSummaryOverlap })
  assert(small.stackSummaryOverlap === false, `360 top-stack 与 summary 重叠`)
  assert(small.card && small.card.w >= small.vw * 0.9 && small.card.w <= small.vw + 1, `360 卡片宽度异常：${JSON.stringify(small.card)}`)
  assert(small.hintVisible, '360 提示不可见')
  await page.screenshot({ path: join(OUT, '148b-wc-406-360.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[wc406] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[wc406] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '44-wc406-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-wc406.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
