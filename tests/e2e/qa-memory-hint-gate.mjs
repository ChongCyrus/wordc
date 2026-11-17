#!/usr/bin/env node
/** 0.3.74 task-225：memory 阶段顶部提示；注释/白板/生成式不显示；12px、位置、390 不溢出。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[hint] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setSettings = async (pairs) => page.evaluate(async (pairs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries(pairs)) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, pairs)
const exitMemory = async () => {
  await page.getByRole('button', { name: '退出记忆' }).first().click()
  const dlg = page.getByRole('dialog', { name: /退出记忆/ }).first()
  if (await dlg.count()) await dlg.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
  await page.waitForTimeout(700)
}
const enter = async () => { await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page); await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }) }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    if (!w) return
    await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rareCoreSenses: [], rareMeaningIds: [] }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await enter()
  const boardHint = await page.locator('.wc-memory-reminder').count()
  await openAnnotation(page)
  const annoHint = await page.locator('.wc-memory-reminder').count()
  record('nonMemory', { boardHint, annoHint })
  assert(boardHint === 0 && annoHint === 0, '白板/注释面不应显示记忆提示')
  // 普通记忆
  await page.getByRole('button', { name: '记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const normal = await page.evaluate(() => {
    const el = document.querySelector('.wc-memory-reminder')
    const card = document.querySelector('.wc-card')
    const topButtons = Array.from(document.querySelectorAll('.weighted-core-only-toggle, .core-sense-ai-btn'))
    const r = el?.getBoundingClientRect()
    const c = card?.getBoundingClientRect()
    const style = el ? getComputedStyle(el) : null
    const overlap = topButtons.some((b) => { const br = b.getBoundingClientRect(); return r && br.width > 0 && !(r.right <= br.left || br.right <= r.left || r.bottom <= br.top || br.bottom <= r.top) })
    return el ? { text: el.textContent?.trim(), fontSize: style?.fontSize, color: style?.color, width: Math.round(r.width), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, top: Math.round(r.top), cardTop: c ? Math.round(c.top) : null, overlapTopButtons: overlap, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 } : null
  })
  record('normalMemory', normal)
  await page.screenshot({ path: join(OUT, '47-memory-hint-normal-390.png') }).catch(() => {})
  assert(normal && /请记忆下述映射，并记忆一个相关词组及其意象/.test(normal.text ?? ''), '普通记忆应显示提示')
  assert(normal.fontSize === '12px', `提示字号应12px，实际 ${normal.fontSize}`)
  assert(normal.top < (normal.cardTop ?? 0), `提示应在卡片上方：${normal.top} < ${normal.cardTop}`)
  assert(normal.scrollWidth <= normal.clientWidth && !normal.pageOverflow && !normal.overlapTopButtons, `提示不应溢出/遮挡按钮：${JSON.stringify(normal)}`)
  // 普通内存退出→加权
  await exitMemory()
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const weightedHint = await page.locator('.wc-memory-reminder').count()
  record('weightedMemory', { hintCount: weightedHint })
  assert(weightedHint === 1, '加权记忆应显示提示')
  // 只记本义
  await exitMemory()
  await setSettings({ 'memory.weightedCoreSenseOnly': true })
  await enter(); await openAnnotation(page)
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(300)
  const coreOnly = await page.evaluate(() => {
    const el = document.querySelector('.wc-memory-reminder')
    const btn = document.querySelector('.core-sense-ai-btn')
    const r = el?.getBoundingClientRect(); const br = btn?.getBoundingClientRect()
    return { hintCount: document.querySelectorAll('.wc-memory-reminder').length, text: el?.textContent?.trim(), top: r ? Math.round(r.top) : null, aiBtnTop: br ? Math.round(br.top) : null, overlapAiBtn: r && br ? !(r.right <= br.left || br.right <= r.left || r.bottom <= br.top || br.bottom <= r.top) : false, overflow: document.documentElement.scrollWidth > innerWidth + 1 }
  })
  record('coreOnlyMemory', coreOnly)
  await page.screenshot({ path: join(OUT, '48-memory-hint-coreonly-390.png') }).catch(() => {})
  assert(coreOnly.hintCount === 1 && /请记忆下述映射/.test(coreOnly.text ?? ''), '只记本义应显示提示')
  assert(!coreOnly.overlapAiBtn && !coreOnly.overflow, `只记本义提示不应挡 AI 按钮/溢出：${JSON.stringify(coreOnly)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[hint] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[hint] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '87-hint-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-memory-hint.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
