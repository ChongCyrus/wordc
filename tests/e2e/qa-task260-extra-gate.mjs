#!/usr/bin/env node
/** 0.3.87 task-260 补充：完成计划追加继续、排行分页/最熟/词详情、抽词去重。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t260x] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  // 补 60 个状态便于排行分页
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').getAll(); r.onsuccess = () => res(r.result) })
    const base = states[0]
    if (!base) return
    await new Promise((res, rej) => {
      const tx = db.transaction('states', 'readwrite'); const st = tx.objectStore('states')
      words.filter((w) => w.deckId === 'kaoyan-2027-dagang').slice(0, 60).forEach((w, i) => st.put({ ...base, wordId: w.id, deckId: w.deckId, updatedAt: Date.now() - i * 1000 }))
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  // 把当前计划 index 推到末尾
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
    const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
    await new Promise((res, rej) => { const tx = db.transaction('plans', 'readwrite'); tx.objectStore('plans').put({ ...plan, index: plan.wordIds.length, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  // 单元页抽 3 词追加（计划已完成状态）
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/units`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  await page.locator('a.mm-row').first().click(); await page.waitForTimeout(800)
  const boxes = page.locator('.mm-list input[type=checkbox]')
  for (let i = 0; i < 3; i += 1) await boxes.nth(i).check()
  const before = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) }); const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) }); const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').count(); r.onsuccess = () => res(r.result) }); return { len: plan.wordIds.length, index: plan.index, ids: plan.wordIds.slice(0, 10), states } })
  await page.getByRole('button', { name: /抽这些词复习（3）/ }).click()
  await page.getByRole('dialog', { name: '抽这些词复习？' }).getByRole('button', { name: /追加 3 词/ }).click()
  await page.waitForFunction(() => /已追加/.test(document.body.innerText), null, { timeout: 10_000 })
  const after = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) }); const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) }); const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').count(); r.onsuccess = () => res(r.result) }); return { len: plan.wordIds.length, index: plan.index, ids: plan.wordIds.slice(0, 10), states } })
  record('completedPlanAppend', { before, after })
  assert(after.index === before.index && after.states === before.states && after.ids.slice(0, before.ids.length).join() === before.ids.join() && after.len > before.len, `已完成计划追加应不改 index/前缀/DHP：${JSON.stringify({ before, after })}`)
  // 去重：再追加同样 3 词
  for (let i = 0; i < 3; i += 1) await boxes.nth(i).check()
  await page.getByRole('button', { name: /抽这些词复习（3）/ }).click()
  await page.getByRole('dialog', { name: '抽这些词复习？' }).getByRole('button', { name: /追加 3 词/ }).click()
  await page.waitForTimeout(800)
  const afterDup = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) }); const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) }); return plan.wordIds.length })
  record('dedup', { afterLen: afterDup })
  assert(afterDup === after.len, `重复追加应去重：${after.len}→${afterDup}`)
  // 进入 /study 能继续（board）
  await page.goto(`${BASE}#/study`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const board = await page.locator('.board-stage').count()
  record('studyContinue', { board })
  assert(board > 0, '已完成计划追加后进入 /study 应能继续')
  await page.screenshot({ path: join(OUT, '78b-study-continue-390.png') }).catch(() => {})
  // 排行分页/最熟/详情
  await page.goto(`${BASE}#/stats/ranking`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const pagerText = (await page.locator('.unit-pager .mm-caption').first().innerText()).replace(/\s+/g, ' ')
  const firstWord = (await page.locator('.ranking-row .mm-row-title').first().innerText()).trim()
  const next = page.getByRole('button', { name: '下一页' }).first()
  record('rankingPage1', { pagerText, firstWord, nextDisabled: await next.isDisabled() })
  if (!(await next.isDisabled())) {
    await next.click(); await page.waitForTimeout(600)
    const page2 = (await page.locator('.unit-pager .mm-caption').first().innerText()).replace(/\s+/g, ' ')
    record('rankingPage2', { page2, rows: await page.locator('.ranking-row').count() })
    assert(page2.startsWith('2/') && page2.split('/')[1] === pagerText.split('/')[1], `第2页总数应不变：${pagerText}→${page2}`)
  }
  await page.getByRole('button', { name: '最熟' }).click(); await page.waitForTimeout(600)
  const familiarFirst = (await page.locator('.ranking-row .mm-row-title').first().innerText()).trim()
  record('rankingFamiliar', { firstWord, familiarFirst })
  assert(familiarFirst.length > 0, '最熟应可切换')
  await page.locator('.ranking-row').first().click(); await page.waitForTimeout(500)
  const detailDlg = page.locator('.mm-dialog').filter({ hasText: '关闭' }).last()
  const detailText = (await detailDlg.innerText()).replace(/\s+/g, ' ')
  record('rankingDetail', { title: await detailDlg.locator('.mm-row-title').first().innerText().catch(() => ''), lines: await detailDlg.locator('.mm-row').count(), text: detailText.slice(0, 160) })
  assert((await detailDlg.locator('.mm-row').count()) >= 2, `排行词详情应列全部含义：${detailText.slice(0, 120)}`)
  await page.screenshot({ path: join(OUT, '80b-ranking-detail-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t260x] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t260x] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '74-task260x-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task260x.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
