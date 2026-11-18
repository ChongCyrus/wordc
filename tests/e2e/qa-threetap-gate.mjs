#!/usr/bin/env node
/** 0.3.80 task-241/242：记忆三小次 full→hidden→verify→+1；第3拍计数；final-hidden→summary→回注释；开关关闭旧行为；390。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[3tap] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setSettings = async (pairs) => page.evaluate(async (pairs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries(pairs)) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, pairs)
const tap = async () => { await page.locator('.memory-stage').evaluate((el) => el.click()); await page.waitForTimeout(400) }
const snapshot = async () => page.evaluate(() => {
  const vis = (sel) => { const n = document.querySelector(sel); if (!n) return false; const r = n.getBoundingClientRect(); const st = getComputedStyle(n); return r.width > 0 && r.height > 0 && st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0' }
  const el = document.querySelector('.memory-stage')
  const count = document.querySelector('.wc-count')?.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  const dots = document.querySelectorAll('.wc-dot').length
  const filled = document.querySelectorAll('.wc-dot.is-filled').length
  return {
    cls: el?.className ?? '', aria: el?.getAttribute('aria-label') ?? '', count,
    hasCn: vis('.wc-cn'), hasRoot: vis('.wc-root-row'),
    hasDerivation: vis('.derivation-chain, .wc-derivation'), hasExamples: vis('.wc-info-example'),
    hasMnemonic: vis('.wc-info-mnemonic, .wc-info-core-mnemonic'), hasPhrases: vis('.wc-phrases'), hasNotes: vis('.user-note-line, .wc-info-note'), hasGloss: vis('.wc-core-sense-gloss'), hasOverview: vis('.wc-core-sense-overview'), hasCurrentLine: vis('.wc-cn-line'), hasFamiliarity: vis('.wc-familiarity'),
    hasSummary: !!document.querySelector('.wc-final-summary'), posText: Array.from(document.querySelectorAll('.memory-stage .wc-hidden-pos-item')).map((n) => n.textContent?.trim()).join(' '), hiddenArrow: !!document.querySelector('.memory-stage .wc-hidden-arrow'), hiddenQuestion: !!document.querySelector('.memory-stage .wc-hidden-question'), questionFont: document.querySelector('.memory-stage .wc-hidden-question') ? getComputedStyle(document.querySelector('.memory-stage .wc-hidden-question')).fontSize : '', order: (() => { const w = document.querySelector('.memory-stage .wc-word')?.getBoundingClientRect(); const a = document.querySelector('.memory-stage .wc-hidden-arrow')?.getBoundingClientRect(); const q = document.querySelector('.memory-stage .wc-hidden-question')?.getBoundingClientRect(); return w && a && q ? { wordBottom: Math.round(w.bottom), arrowTop: Math.round(a.top), arrowBottom: Math.round(a.bottom), questionTop: Math.round(q.top) } : null })(), visibleText: el ? el.innerText.replace(/\s+/g, ' ').trim() : '', summaryText: document.querySelector('.wc-final-summary')?.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    dots, filled, overflow: document.documentElement.scrollWidth > innerWidth + 1,
  }
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await setSettings({ 'memory.threeTapRecall': true, 'memory.weightedCoreSenseOnly': false, 'memory.totalRepeats': 3 })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.getByRole('button', { name: '记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const p0 = await snapshot()
  record('phase0', p0)
  assert(/memory-stage--normal/.test(p0.cls) && p0.hasCn && p0.count === '0 / 3' && p0.dots === 3 && p0.filled === 0, `初始完整卡/0/3：${JSON.stringify(p0)}`)
  await page.screenshot({ path: join(OUT, '63-three-tap-full-390.png') }).catch(() => {})
  await tap(); const p1 = await snapshot()
  record('phase1Hidden', p1)
  assert(/memory-stage--hidden/.test(p1.cls) && [p1.hasCn,p1.hasRoot,p1.hasDerivation,p1.hasExamples,p1.hasMnemonic,p1.hasPhrases,p1.hasNotes,p1.hasGloss,p1.hasOverview,p1.hasCurrentLine,p1.hasFamiliarity].every((v) => !v) && p1.count === '0 / 3', `第1拍hidden不应有任何注释元素：${JSON.stringify(p1)}`)
  assert(/\[vt\.\]/.test(p1.posText) && p1.hiddenArrow && p1.hiddenQuestion && p1.questionFont === '38px' && p1.order && p1.order.wordBottom <= p1.order.arrowTop && p1.order.arrowBottom <= p1.order.questionTop && /↓/.test(p1.visibleText) && /\?/.test(p1.visibleText), `hidden 应显示 pos + 大↓大?(38px,竖直序)：${JSON.stringify(p1)}`)
  assert(!/[\u4e00-\u9fa5]/.test(p1.visibleText.replace('denounce', '')), `hidden 文本不应含中文：${p1.visibleText}`)
  assert(!/谴责|告发|本义|词根|步骤|vt\./.test(p1.aria) && !/fixture|本义|告发|词根|步骤/.test(p1.visibleText), `hidden aria/text 不应泄露：${p1.aria} | ${p1.visibleText}`)
  await page.screenshot({ path: join(OUT, '64-three-tap-hidden-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const p1_360 = await snapshot(); record('hidden360', p1_360)
  await page.screenshot({ path: join(OUT, '64b-three-tap-hidden-360.png') }).catch(() => {})
  assert(!p1_360.overflow && /\[vt\.\]/.test(p1_360.posText) && !/[\u4e00-\u9fa5]/.test(p1_360.visibleText.replace('denounce', '')), `360 hidden 不应溢出且 pos+↓?:${JSON.stringify(p1_360)}`)
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  await tap(); const p2 = await snapshot()
  record('phase2Verify', p2)
  assert(/memory-stage--verify/.test(p2.cls) && p2.hasCn && p2.count === '0 / 3', `第2拍应verify且未+1：${JSON.stringify(p2)}`)
  await page.screenshot({ path: join(OUT, '65-three-tap-verify-390.png') }).catch(() => {})
  await tap(); const p3 = await snapshot()
  record('phase3Increment', p3)
  assert(/memory-stage--normal/.test(p3.cls) && p3.count === '1 / 3' && p3.filled === 1, `第3拍才+1：${JSON.stringify(p3)}`)
  // 完成所有 c 的每个次数（每轮3拍），直到 final-hidden
  for (let i = 0; i < 80; i += 1) { const s = await snapshot(); if (/final-hidden|final-summary/.test(s.cls)) break; await tap() }
  const p4 = await snapshot()
  record('finalHidden', p4)
  assert(/memory-stage--final-hidden/.test(p4.cls) && p4.dots === 3 && p4.filled === 3 && [p4.hasCn,p4.hasRoot,p4.hasDerivation,p4.hasExamples,p4.hasMnemonic,p4.hasPhrases,p4.hasGloss,p4.hasOverview,p4.hasCurrentLine].every((v) => !v), `全完成应 final-hidden 仅w+满圈：${JSON.stringify(p4)}`)
  assert(p4.posText.length > 0 && p4.hiddenArrow && p4.hiddenQuestion && p4.questionFont === '38px' && p4.order && p4.order.wordBottom <= p4.order.arrowTop && p4.order.arrowBottom <= p4.order.questionTop && !/[\u4e00-\u9fa5]/.test(p4.visibleText.replace('denounce', '')), `final-hidden 应有去重 pos+大↓大?(38px,竖直序) 无中文：${JSON.stringify(p4)}`)
  await page.screenshot({ path: join(OUT, '66-three-tap-final-hidden-390.png') }).catch(() => {})
  await tap(); const p5 = await snapshot()
  record('finalSummary', p5)
  assert(/memory-stage--final-summary/.test(p5.cls) && p5.hasSummary && /\[vt\.\]/.test(p5.summaryText) && /告发|公然抨击|通告废除/.test(p5.summaryText), `summary 应含 c pos+cn：${JSON.stringify(p5)}`)
  await page.screenshot({ path: join(OUT, '67-three-tap-summary-390.png') }).catch(() => {})
  await tap(); await page.waitForTimeout(700)
  const backToAnnotation = await page.locator('.annotation-stage').count()
  record('backToAnnotation', { backToAnnotation, memory: await page.locator('.memory-stage').count() })
  assert(backToAnnotation > 0 && (await page.locator('.memory-stage').count()) === 0, 'summary 点击应回注释面')
  // 开关关闭 → 一拍 +1（旧行为）
  await setSettings({ 'memory.threeTapRecall': false })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.getByRole('button', { name: '记忆' }).first().click(); await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const off0 = await snapshot(); await tap(); const off1 = await snapshot()
  record('offOldBehavior', { off0: off0.count, off1: off1.count, cls: off1.cls })
  assert(off1.count === '1 / 3' && !/memory-stage--hidden/.test(off1.cls), `关闭三小次后一拍+1：${JSON.stringify(off1)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[3tap] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[3tap] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '82-threetap-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-threetap.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
