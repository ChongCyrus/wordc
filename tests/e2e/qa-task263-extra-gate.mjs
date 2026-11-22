#!/usr/bin/env node
/** 0.3.89 补充：Deck选择工具条跨页/排序、批量AI/引申预选、rate-only 不改调度。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t263x] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const dbSnap = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
  const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
  const st = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').get('kaoyan-2027-dagang:technical'); r.onsuccess = () => res(r.result) })
  const logs = await new Promise((res) => { const r = db.transaction('reviewLogs', 'readonly').objectStore('reviewLogs').getAll(); r.onsuccess = () => res(r.result) })
  return { planLen: plan?.wordIds?.length ?? 0, dueAt: st?.dueAt ?? null, stability: st?.stability ?? null, difficulty: st?.difficulty ?? null, phase: st?.phase ?? null, logCount: logs.length, lastLog: logs.sort((a, b) => (b.createdAt ?? b.at ?? 0) - (a.createdAt ?? a.at ?? 0))[0] ?? null }
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(600)
  const tbText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const sortOpts = await page.getByLabel('排序').locator('option').allTextContents()
  const statusOpts = await page.getByLabel('状态筛选').locator('option').allTextContents()
  const m0 = tbText.match(/已选 (\d+) \/ 筛选 (\d+)/)
  record('deckToolbar', { sortOpts, statusOpts, counts: m0?.[0], search: await page.getByLabel('搜索词库单词').count(), selectAll: await page.getByRole('button', { name: '全选', exact: true }).count() })
  assert(sortOpts.length === 4 && statusOpts.length >= 3 && m0 && (await page.getByLabel('搜索词库单词').count()) === 1, `Deck工具条不完整：${JSON.stringify({ sortOpts, statusOpts, m0: m0?.[0] })}`)
  const total = Number(m0[2])
  const firstOrder = (await page.locator('.mm-list button.mm-row .mm-row-title').first().innerText()).trim()
  await page.getByRole('button', { name: '全选', exact: true }).click(); await page.waitForTimeout(800)
  const mAll = (await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/已选 (\d+) \/ 筛选 (\d+)/)
  record('deckSelectAll', { selected: mAll?.[1], total: mAll?.[2], expected: Math.min(total, 999), crossPage: Number(mAll?.[1]) > 50, limitToast: /999/.test((await page.locator('body').innerText())) })
  assert(mAll && Number(mAll[1]) === Math.min(total, 999) && Number(mAll[1]) > 50, `Deck全选跨页/999上限失败：${JSON.stringify({ all: mAll?.[0], total })}`)
  await page.getByRole('button', { name: '取消全选', exact: true }).click(); await page.waitForTimeout(400)
  await page.getByLabel('排序').selectOption('alpha'); await page.waitForTimeout(700)
  const firstAlpha = (await page.locator('.mm-list button.mm-row .mm-row-title').first().innerText()).trim()
  record('deckSort', { firstOrder, firstAlpha })
  assert(firstAlpha !== firstOrder, `排序 alpha 首词应变化：${firstOrder}→${firstAlpha}`)
  await page.screenshot({ path: join(OUT, '87-deck-select-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('deck360', layout)
  await page.screenshot({ path: join(OUT, '87-deck-select-360.png') }).catch(() => {})
  assert(!layout.overflow, 'Deck选择360不应溢出')
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  // 选1词 -> 批量AI/引申图入口
  await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(300)
  record('bulkButtons', { ai: await page.getByRole('button', { name: /AI 生成选中词（1）/ }).count(), derivation: await page.getByRole('button', { name: '生成引申图', exact: true }).count() })
  await page.getByRole('button', { name: /AI 生成选中词（1）/ }).click(); await page.waitForTimeout(800)
  const aiText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const aiVisible = /AI 生成/.test(aiText) && /已选|选中|1/.test(aiText)
  record('aiPanel', { visible: aiVisible, text: aiText.slice(-220) })
  await page.screenshot({ path: join(OUT, '88-ai-selected-390.png') }).catch(() => {})
  assert(aiVisible, 'AI 面板应打开且预选1词')
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click().catch(async () => { await page.getByRole('button', { name: '关闭', exact: true }).last().click() }); await page.waitForTimeout(500)
  await page.getByRole('button', { name: '生成引申图', exact: true }).click(); await page.waitForTimeout(800)
  const derivText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('derivationPanel', { visible: /引申图/.test(derivText), text: derivText.slice(-200) })
  assert(/引申图/.test(derivText), '引申图面板应打开')
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).last().click().catch(async () => { await page.getByRole('button', { name: '关闭', exact: true }).last().click() }); await page.waitForTimeout(500)
  // rate-only：取已有 state 的词（无 state 会创建，不适用）
  const existing = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').getAll(); r.onsuccess = () => res(r.result) })
    return states.find((s) => s.dueAt != null) ?? states[0] ?? null
  })
  record('rateOnlyWord', { wordId: existing?.wordId, dueAt: existing?.dueAt, stability: existing?.stability, difficulty: existing?.difficulty })
  assert(existing, 'fixture 应有 state 词')
  const wid = existing.wordId
  const snap = () => page.evaluate(async (wordId) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
    const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
    const st = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').get(wordId); r.onsuccess = () => res(r.result) })
    const logs = await new Promise((res) => { const r = db.transaction('reviewLogs', 'readonly').objectStore('reviewLogs').getAll(); r.onsuccess = () => res(r.result) })
    const sorted = logs.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))
    return { planLen: plan?.wordIds?.length ?? 0, dueAt: st?.dueAt ?? null, stability: st?.stability ?? null, difficulty: st?.difficulty ?? null, phase: st?.phase ?? null, logCount: logs.length, lastLog: sorted[0] ?? null }
  }, wid)
  const before = await snap()
  await page.goto(`${BASE}#/temp-review?words=${encodeURIComponent(wid)}&recordMode=rate-only&returnTo=%2Fdecks%2Fkaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  const rateBtn = page.locator('.temp-review-actions button').first(); await rateBtn.waitFor({ state: 'visible', timeout: 5000 }); await rateBtn.click(); await page.waitForTimeout(1000)
  const after = await snap()
  record('rateOnly', { before, after })
  assert(after.dueAt === before.dueAt && after.stability === before.stability && after.difficulty === before.difficulty && after.phase === before.phase && after.planLen === before.planLen && after.logCount > before.logCount, `rate-only 应不改调度/plan、仅写 log：${JSON.stringify({ before, after })}`)
  assert(String(after.lastLog?.scheduleMode ?? '') === 'skip', `reviewLog 应 scheduleMode=skip：${JSON.stringify(after.lastLog)}`)
  await page.screenshot({ path: join(OUT, '89-temp-rate-only-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t263x] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t263x] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '69-task263x-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task263x.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
