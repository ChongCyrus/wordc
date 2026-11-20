#!/usr/bin/env node
/** 0.3.89 补充2：详情标记不熟→列表已学同步；AI面板 custom words target>0；引申图预选1。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t263y] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  // 找无状态词 + 无内容词
  const picks = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').getAll(); r.onsuccess = () => res(r.result) })
    const stateIds = new Set(states.map((s) => s.wordId))
    const deck = words.filter((w) => w.deckId === 'kaoyan-2027-dagang')
    const noState = deck.find((w) => !stateIds.has(w.id) && w.headword.length >= 4)
    const noContent = deck.find((w) => !stateIds.has(w.id) && !(w.examples?.length) && !(w.mnemonics?.length) && !(w.phrases?.length))
    return { noState: noState ? { id: noState.id, headword: noState.headword } : null, noContent: noContent ? { id: noContent.id, headword: noContent.headword } : null, states: states.length }
  })
  record('picks', picks)
  assert(picks.noState, '应有未学词')
  // 1) 详情标记不熟 -> 返回列表已学同步
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  await page.evaluate(async (wid) => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const st = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').get(wid); r.onsuccess = () => res(r.result) })
    window.__beforeState = st ?? null
  }, picks.noState.id)
  await page.goto(`${BASE}#/study?detailWord=${encodeURIComponent(picks.noState.id)}&returnTo=%2Fdecks%2Fkaoyan-2027-dagang&deck=kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  const mark = page.locator('button[aria-label^="标记「"]').first()
  await mark.waitFor({ state: 'visible', timeout: 5000 })
  const markLabelBefore = await mark.getAttribute('aria-label')
  await mark.click(); await page.waitForTimeout(800)
  const markLabelAfter = await mark.getAttribute('aria-label')
  const stateAfter = await page.evaluate(async (wid) => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); return await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').get(wid); r.onsuccess = () => res(r.result) }) }, picks.noState.id)
  record('markUnfamiliar', { markLabelBefore, markLabelAfter, stateBefore: await page.evaluate(() => window.__beforeState), stateAfter })
  assert(stateAfter && stateAfter.meaningStats && Object.values(stateAfter.meaningStats).some((m) => m.clicks > 0), `标记不熟应写 state clicks：${JSON.stringify(stateAfter)}`)
  // 返回列表 -> 已学筛选应出现该词
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '全部', exact: true }).first().click().catch(() => {})
  await page.waitForTimeout(700)
  const normalSearch = page.locator('input[placeholder*="搜索英文"]').first()
  await normalSearch.waitFor({ state: 'visible', timeout: 8000 })
  await normalSearch.fill(picks.noState.headword); await page.waitForTimeout(1000)
  const rowText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const learnedRow = await page.locator('.mm-list button.mm-row').filter({ hasText: picks.noState.headword }).count()
  record('listSync', { headword: picks.noState.headword, learnedRow, rowText: rowText.slice(0, 200) })
  assert(learnedRow > 0, `全部筛选应返回 ${picks.noState.headword}`)
  assert(/\d+%/.test(markLabelAfter), `标记后详情不熟悉度应立即非 —：${markLabelAfter}`)
  await page.screenshot({ path: join(OUT, '90-detail-sync-all-390.png') }).catch(() => {})
  // 重新进入详情确认 live 不熟悉度
  await page.locator('.mm-list button.mm-row').filter({ hasText: picks.noState.headword }).first().click(); await page.waitForTimeout(1000)
  const reMarkLabel = await page.locator('button[aria-label^="标记「"]').first().getAttribute('aria-label')
  record('reopenDetail', { markLabelAfter, reMarkLabel })
  assert(/\d+%/.test(reMarkLabel), `重进详情不熟悉度应保持：${reMarkLabel}`)
  await page.screenshot({ path: join(OUT, '90b-detail-sync-reopen-390.png') }).catch(() => {})
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  // 2) AI 面板预选无内容词
  assert(picks.noContent, '应有无内容词')
  await page.getByRole('button', { name: '全部', exact: true }).first().click().catch(() => {}); await page.waitForTimeout(500)
  await page.locator('input[placeholder*="搜索英文"]').first().fill('').catch(() => {}); await page.waitForTimeout(500)
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(500)
  await page.locator('input[placeholder*="搜索"]').first().fill(picks.noContent.headword); await page.waitForTimeout(800)
  await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(300)
  await page.getByRole('button', { name: /AI 生成选中词（1）/ }).click(); await page.waitForTimeout(800)
  const aiText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const target = aiText.match(/目标：(\d+) 个词\/含义/)?.[1] ?? null
  record('aiPreselect', { noContent: picks.noContent, target, aiText: aiText.slice(-220) })
  assert(target != null && Number(target) > 0, `AI 面板 target 应>0：${target}`)
  await page.screenshot({ path: join(OUT, '88b-ai-preselected-390.png') }).catch(() => {})
  await page.getByRole('button', { name: '关闭', exact: true }).last().click().catch(() => {}); await page.waitForTimeout(500)
  await page.getByRole('button', { name: '生成引申图', exact: true }).click(); await page.waitForTimeout(800)
  const derivText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const cand = derivText.match(/候选 (\d+) 个 · 已选 (\d+) 个/)
  record('derivationPreselect', { cand: cand?.[0] ?? '' })
  assert(cand && Number(cand[2]) >= 1, `引申图应已选≥1：${cand?.[0]}`)
  await page.screenshot({ path: join(OUT, '88c-derivation-preselected-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('layout360', layout)
  assert(!layout.overflow, '360 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t263y] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t263y] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '68-task263y-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task263y.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
