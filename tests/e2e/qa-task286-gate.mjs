#!/usr/bin/env node
/** 0.3.94 task-286：临时复习 auto/practice/汇总应用、已学词重复加入、两维不熟度、390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t286] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const decode = (s) => decodeURIComponent(s)
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  const words = ['kaoyan-2027-dagang:denounce', 'kaoyan-2027-dagang:technical']
  // practice：三键逐词自评，无下一个；2词后 summary + 应用确认
  await page.goto(`${BASE}#/temp-review?words=${encodeURIComponent(words.join(','))}&recordMode=practice&returnTo=${encodeURIComponent('/decks/kaoyan-2027-dagang')}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(2000)
  const practiceBtns = await page.locator('.practice-assess-btn').count()
  const nextCount = await page.getByRole('button', { name: '下一个', exact: true }).count()
  record('practice', { practiceBtns, nextCount, url: page.url() })
  assert(practiceBtns === 3 && nextCount === 0, `practice 应三键无下一个：${JSON.stringify({ practiceBtns, nextCount })}`)
  await page.locator('.practice-assess-btn').first().click(); await page.waitForTimeout(1000)
  const after1 = await page.locator('.word-text').first().innerText().catch(() => '')
  await page.locator('.practice-assess-btn').nth(1).click(); await page.waitForTimeout(1200)
  const summaryText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const hasApply = /根据本批次调整日后复习计划/.test(summaryText)
  record('practiceSummary', { after1, hasApply, text: summaryText.slice(0, 220) })
  assert(/临时复习汇总/.test(summaryText) && hasApply, `practice 应到汇总且有应用按钮：${summaryText.slice(0, 160)}`)
  await page.getByRole('button', { name: '根据本批次调整日后复习计划' }).click()
  const applyDlg = page.getByRole('dialog', { name: '应用本批到日后复习计划？' }).first(); await applyDlg.waitFor({ state: 'visible', timeout: 5000 })
  const applyBtn = applyDlg.getByRole('button', { name: '应用' }).first()
  await applyBtn.click(); await page.waitForTimeout(800)
  const applyClosed = !(await applyDlg.isVisible().catch(() => false))
  record('apply', { applyClosed })
  assert(applyClosed, '应用确认应关闭')
  await page.screenshot({ path: join(OUT, '105-temp-practice-summary-390.png') }).catch(() => {})
  // autoRequeue rate：单词语气模糊后应再次出现
  await page.goto(`${BASE}#/temp-review?words=${encodeURIComponent(words[0])}&recordMode=rate&autoRequeue=1&returnTo=${encodeURIComponent('/decks/kaoyan-2027-dagang')}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1800)
  const w1 = await page.locator('.word-text').first().innerText().catch(() => '')
  if ((await page.locator('.board-stage').count()) > 0) await page.locator('.board-stage').first().click()
  await page.waitForTimeout(500)
  const vague = page.locator('.rating-btn--vague').first(); await vague.waitFor({ state: 'visible', timeout: 5000 })
  await vague.click(); await page.waitForTimeout(1500)
  const w2 = await page.locator('.word-text').first().innerText().catch(() => '')
  const body2 = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('autoRequeue', { w1, w2, summary: /临时复习汇总/.test(body2), occurrences: /本批出现/.test(body2), body: body2.slice(0, 180) })
  assert(w1 === w2 && !/临时复习汇总/.test(body2), `autoRequeue 模糊后应再出现同词：${JSON.stringify({ w1, w2 })}`)
  // 再评认识结束
  if ((await page.locator('.board-stage').count()) > 0) await page.locator('.board-stage').first().click()
  await page.waitForTimeout(400)
  const know = page.locator('.rating-btn--know').first()
  if (await know.isVisible().catch(() => false)) { await know.click(); await page.waitForTimeout(1200) }
  await page.screenshot({ path: join(OUT, '106-temp-autorequeue-390.png') }).catch(() => {})
  // 已学词重复加入今日计划
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(400)
  const search = page.getByLabel('搜索词库单词').first(); await search.fill('technical'); await page.waitForTimeout(800)
  await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(300)
  const planBefore = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) }); const p = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) }); return p?.wordIds ?? [] })
  await page.getByRole('button', { name: /抽这些词复习（1）/ }).click()
  const choice = page.getByRole('dialog', { name: '抽这些词复习（1）' }).first(); await choice.waitFor({ state: 'visible', timeout: 5000 })
  await choice.getByRole('button', { name: '加入今日计划' }).click(); await page.waitForTimeout(1000)
  const planAfter = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) }); const p = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) }); return p?.wordIds ?? [] })
  record('readdLearned', { beforeCount: planBefore.filter((id) => id.endsWith(':technical')).length, afterCount: planAfter.filter((id) => id.endsWith(':technical')).length, len: planAfter.length })
  assert(planAfter.filter((id) => id.endsWith(':technical')).length >= 1, '已学词应可加入今日计划')
  // 两维不熟度（词库选择态）
  const dim = page.getByLabel('不熟悉度维度').first()
  const dimVisible = await dim.isVisible().catch(() => false)
  let dimOptions = []
  if (dimVisible) dimOptions = await dim.locator('option').allTextContents()
  record('dimensionDeck', { visible: dimVisible, options: dimOptions })
  if (dimVisible) {
    const v1 = await dim.inputValue(); await dim.selectOption('coreSense'); await page.waitForTimeout(600)
    const v2 = await dim.inputValue()
    record('dimensionSwitch', { v1, v2 })
    assert(v2 === 'coreSense', '维度应可切到本义不熟悉度')
  }
  await page.screenshot({ path: join(OUT, '107-dimension-390.png') }).catch(() => {})
  // 排行/单元维度存在
  await page.goto(`${BASE}#/stats/ranking`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  await page.getByRole('button', { name: '选择', exact: true }).click().catch(() => {})
  const rankDim = await page.getByLabel('不熟悉度维度').count()
  record('dimensionOther', { rankingDim: rankDim })
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  assert(!layout.overflow, '360 不应溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t286] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t286] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '57-task286-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task286.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
