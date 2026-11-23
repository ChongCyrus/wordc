#!/usr/bin/env node
/** 0.5.2 前N/切批/索引集批次/ReviewChoice 三模式/返回恢复。不调真实 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t502] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/filter`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  await page.getByRole('button', { name: '列表', exact: true }).click(); await page.waitForTimeout(300)
  await page.locator('select[aria-label="值"]').last().selectOption('false'); await page.getByRole('button', { name: /执行筛选/ }).click(); await page.waitForTimeout(800)
  // 前3
  const topInput = page.locator('.filter-batch-field').filter({ hasText: '选择前 N 个' }).locator('input')
  await topInput.fill('3'); await page.locator('.filter-batch-field').filter({ hasText: '选择前 N 个' }).getByRole('button', { name: '选择' }).click(); await page.waitForTimeout(400)
  const selected3 = await page.evaluate(() => ({ checked: document.querySelectorAll('.mm-list label.mm-row input[type=checkbox]:checked').length, caption: document.body.innerText.match(/已选 \d+ \/ 筛选 \d+/)?.[0] ?? '' }))
  record('topN', selected3); assert(selected3.checked === 3, `选择前3失败：${JSON.stringify(selected3)}`)
  // 每批2，划分
  const batchInput = page.locator('.filter-batch-field').filter({ hasText: '每批词数' }).locator('input')
  await batchInput.fill('2'); await page.locator('.filter-batch-field').filter({ hasText: '每批词数' }).getByRole('button', { name: '划分所选' }).click(); await page.waitForTimeout(400)
  const chipsText = await page.locator('.filter-batch-chips button').allTextContents().catch(() => [])
  record('batchChips', chipsText); assert(chipsText.length === 2 && chipsText[0].includes('第 1 批') && chipsText[0].includes('2 词') && chipsText[1].includes('1 词'), `切批chips错误：${JSON.stringify(chipsText)}`)
  // 保存批次
  await page.getByRole('button', { name: '保存索引集' }).first().click(); await page.waitForTimeout(300)
  const dlg = page.getByRole('dialog', { name: '保存索引集' }).first(); await dlg.getByLabel('索引集名称').fill('QA批次集'); await dlg.getByRole('button', { name: '保存' }).click(); await page.waitForTimeout(700)
  const card = await page.locator('.saved-filter-card').filter({ hasText: 'QA批次集' }).innerText().catch(() => '')
  record('savedBatchCard', card.replace(/\s+/g, ' ')); assert(/3 词快照 · 2 批/.test(card), `保存批次卡片错误：${card}`)
  // 点第2批 → AI 来源 第2批1词
  await page.locator('.filter-batch-chips button').nth(1).click(); await page.waitForTimeout(300)
  const batch2Bar = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => /AI 生成数据|临时复习/.test(b.textContent ?? '')).map((b) => b.textContent?.trim()))
  record('batch2Bar', batch2Bar); assert(batch2Bar.some((t) => t.includes('第2批 1词')), `第2批来源错误：${JSON.stringify(batch2Bar)}`)
  // 载入恢复批次
  await page.locator('.saved-filter-card').filter({ hasText: 'QA批次集' }).getByRole('button', { name: '载入' }).click(); await page.waitForTimeout(700)
  const loadChips = await page.locator('.filter-batch-chips button').allTextContents().catch(() => [])
  record('loadBatches', loadChips); assert(loadChips.length === 2, `载入未恢复批次：${JSON.stringify(loadChips)}`)
  // 临时复习 ReviewChoiceDialog 三模式
  await page.locator('.filter-batch-chips button').nth(1).click(); await page.waitForTimeout(300)
  await page.getByRole('button', { name: /临时复习/ }).click(); await page.waitForTimeout(500)
  const choice = page.getByRole('dialog', { name: /抽这些词复习/ }).first(); const choiceText = (await choice.innerText()).replace(/\s+/g, ' ')
  record('choiceDialog', { choiceText: choiceText.slice(0, 240) })
  assert(/只练不记录/.test(choiceText) && /评分并记录/.test(choiceText) && /评分但不改复习时间/.test(choiceText), `三模式缺失：${choiceText}`)
  const modes = {}
  for (const label of ['只练不记录（不显示评分）', '评分但不改复习时间', '评分并记录（不改变今日计划）']) {
    await page.getByText(label, { exact: true }).locator('input').check({ force: true }).catch(async () => { await page.getByText(label, { exact: true }).click() })
    await page.waitForTimeout(200)
    await choice.getByRole('button', { name: '立即复习' }).click(); await page.waitForTimeout(800)
    const url = page.url(); const body = (await page.locator('body').innerText()).slice(0, 60)
    const checkedMode = await page.evaluate(() => Array.from(document.querySelectorAll('input[name="temp-record-mode"]')).map((x) => ({ checked: x.checked, label: x.closest('label')?.innerText.trim() }))).catch(() => [])
    modes[label] = { full: url, url: decodeURIComponent(url).match(/tempRecordMode=([^&]+)/)?.[1] ?? '', checkedMode, body }
    await page.getByRole('button', { name: '退出临时复习' }).click().catch(() => {}); await page.waitForTimeout(700)
    if (await page.getByRole('button', { name: /临时复习/ }).count()) { await page.getByRole('button', { name: /临时复习/ }).click(); await page.waitForTimeout(400) }
  }
  record('tempModes', modes)
  assert(modes['只练不记录（不显示评分）']?.url === 'practice', 'practice 模式未生效')
  assert(modes['评分但不改复习时间']?.url === 'rate-only', 'rate-only 模式未生效')
  // 返回恢复
  const restoredRows = await page.evaluate(() => ({ rows: document.querySelectorAll('.mm-list label.mm-row').length })); record('restoreRows', restoredRows); assert(restoredRows.rows > 0, '返回筛选结果丢失')
  await page.screenshot({ path: join(OUT, '154-batch-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const small = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', small); assert(!small.overflow, '360 溢出')
  await page.screenshot({ path: join(OUT, '154b-batch-360.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t502] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t502] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '40-task502-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task502.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
