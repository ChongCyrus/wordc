#!/usr/bin/env node
/** 0.3.97 批量不常考 mock/Web：来源预选、筛选、批次、确认、预览勾选；不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t297] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(400)
  const rows = page.locator('.mm-list button.mm-row'); const n = await rows.count(); assert(n >= 4, `词库行不足：${n}`)
  for (let i = 0; i < 4; i += 1) await rows.nth(i).click()
  await page.getByRole('button', { name: /AI 生成选中词（4）/ }).click(); await page.waitForTimeout(900)
  await page.getByRole('button', { name: /批量标记「不常考」含义/ }).click(); await page.waitForTimeout(900)
  const panel = page.getByRole('dialog', { name: '批量标记不常考含义' }).first(); await panel.waitFor({ state: 'visible', timeout: 5000 })
  const text = (await panel.innerText()).replace(/\s+/g, ' ')
  const sources = ['已选 4 词', '当前词', '今日计划', '当前词库', '当前筛选']
  const batchOpts = await panel.getByLabel('批次大小').locator('option').allTextContents().catch(() => [])
  const statusOpts = await panel.getByLabel('检查状态').locator('option').allTextContents().catch(() => [])
  record('panel', { text: text.slice(0, 260), sources, batchOpts, statusOpts, candidateLine: text.match(/筛选后 \d+ 词[^；]*/)?.[0] ?? '', start: await panel.getByRole('button', { name: /开始批量标记/ }).count() })
  assert(sources.slice(0, 2).every((x) => text.includes(x)), `默认来源/按钮缺失：${text.slice(0, 160)}`)
  assert(batchOpts.length === 5 && statusOpts.length === 4, `批次/状态选项异常：${JSON.stringify({ batchOpts, statusOpts })}`)
  assert(/筛选后 \d+ 词/.test(text), '应显示筛选后候选数')
  // 筛选交互
  await panel.getByLabel('检查状态').selectOption('all'); await page.waitForTimeout(500)
  await panel.getByLabel('不熟悉度维度').selectOption('coreSense'); await page.waitForTimeout(500)
  await panel.getByLabel('已学筛选').selectOption('all'); await page.waitForTimeout(500)
  await panel.getByLabel('筛选不常考关键词').fill('ab'); await page.waitForTimeout(700)
  const afterFilter = (await panel.innerText()).replace(/\s+/g, ' ')
  record('filtered', { line: afterFilter.match(/筛选后 \d+ 词[^；]*/)?.[0] ?? '' })
  await page.screenshot({ path: join(OUT, '114-rare-batch-panel-390.png') }).catch(() => {})
  // 开始确认（不确认，避免 API）
  const startBtn = panel.getByRole('button', { name: /开始批量标记/ })
  if (await startBtn.isEnabled().catch(() => false)) {
    await startBtn.click(); await page.waitForTimeout(500)
    const confirm = page.getByRole('dialog', { name: '确认批量标记' }).first(); await confirm.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
    const confirmText = (await confirm.innerText().catch(() => '')).replace(/\s+/g, ' ')
    record('confirm', { visible: await confirm.isVisible().catch(() => false), text: confirmText.slice(0, 200) })
    assert(await confirm.isVisible().catch(() => false) && /本批 \d+ 个词/.test(confirmText) && /费用/.test(confirmText), `确认弹窗应含本批/费用：${confirmText.slice(0, 150)}`)
    await page.screenshot({ path: join(OUT, '115-rare-batch-confirm-390.png') }).catch(() => {})
    await confirm.getByRole('button', { name: '取消' }).click().catch(() => {})
  } else record('confirm', { disabled: true })
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  await page.screenshot({ path: join(OUT, '116-rare-batch-360.png') }).catch(() => {})
  assert(!layout.overflow, '360 不应溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t297] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t297] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '55-task297-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task297.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
