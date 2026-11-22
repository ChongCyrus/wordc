#!/usr/bin/env node
/** 0.3.92 task-273：旧计划清理后首页待新学0、开始学习可进、顺序添加新词顺序正确。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t273] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const planSnap = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
  const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
  const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').getAll(); r.onsuccess = () => res(r.result) })
  return { id, plan: plan ? { wordIds: plan.wordIds, index: plan.index, keys: Object.keys(plan) } : null, stateIds: states.map((s) => s.wordId) }
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await page.waitForTimeout(1500)
  const home = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const before = await planSnap()
  record('homeOldPlan', { pendingNew: /待新学 0/.test(home), text: home.slice(0, 220), plan: before.plan })
  assert(/待新学 0/.test(home), `旧计划下首页待新学应为0：${home.slice(0, 160)}`)
  // 开始学习可进
  await page.getByText('开始学习', { exact: true }).first().click(); await page.waitForTimeout(1500)
  const board = await page.locator('.board-stage').count()
  const studyText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('startStudy', { url: page.url(), board, text: studyText.slice(0, 180) })
  assert(board > 0, `开始学习应进入 board：${studyText.slice(0, 160)}`)
  // 返回首页，顺序添加 3 个新词
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await page.waitForTimeout(800)
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  const dlg = page.getByRole('dialog', { name: '添加今日新单词' }).first(); await dlg.waitFor({ state: 'visible', timeout: 5000 })
  await dlg.getByRole('button', { name: '顺序选择' }).click()
  await dlg.locator('#add-word-count').fill('3'); await dlg.locator('#add-word-count').blur(); await page.waitForTimeout(300)
  const preAdd = await planSnap()
  await dlg.getByRole('button', { name: '添加' }).click()
  const planDlg = page.getByRole('dialog', { name: '已有今日计划' }).first()
  if (await planDlg.isVisible().catch(() => false)) await planDlg.getByRole('button', { name: '保留今日计划并追加' }).click()
  await page.waitForFunction(() => /已追加/.test(document.body.innerText), null, { timeout: 60_000 })
  await page.waitForTimeout(600)
  const after = await planSnap()
  const expected = await page.evaluate(async (existing) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').getAll(); r.onsuccess = () => res(r.result) })
    const learned = new Set(states.map((s) => s.wordId))
    const pool = words.filter((w) => w.deckId === 'kaoyan-2027-dagang' && !learned.has(w.id) && !existing.includes(w.id))
    pool.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id))
    return pool.slice(0, 3).map((w) => ({ id: w.id, order: w.order, headword: w.headword }))
  }, preAdd.plan?.wordIds ?? [])
  const added = (after.plan?.wordIds ?? []).slice((preAdd.plan?.wordIds ?? []).length)
  const addedWords = await page.evaluate(async (ids) => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const out = []; for (const id of ids) { const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get(id); r.onsuccess = () => res(r.result) }); out.push(w ? { id: w.id, order: w.order, headword: w.headword } : { id }) } return out }, added)
  record('orderAppend', { preLen: preAdd.plan?.wordIds?.length, added, expected, addedWords })
  assert(added.length === 3, `应追加3词：${JSON.stringify(added)}`)
  const addedIds = addedWords.map((w) => w.id)
  const expectedIds = expected.map((w) => w.id)
  assert(addedIds.join() === expectedIds.join(), `顺序添加应与未学词 order 前3一致：${JSON.stringify({ addedIds, expectedIds })}`)
  await page.screenshot({ path: join(OUT, '99-order-append-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('layout360', layout)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t273] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t273] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '64-task273-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task273.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
