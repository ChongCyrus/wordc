#!/usr/bin/env node
/** 0.6.0 GeneratePage 10 类型/属性组/批次并发预算/统一 job/任务按钮。不调真实 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t600] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/filter`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  await page.getByRole('button', { name: '列表', exact: true }).click(); await page.waitForTimeout(300)
  await page.locator('select[aria-label="值"]').last().selectOption('false'); await page.getByRole('button', { name: /执行筛选/ }).click(); await page.waitForTimeout(800)
  const boxes = page.locator('.mm-list label.mm-row input[type=checkbox]'); await boxes.nth(0).check({ force: true }); await boxes.nth(1).check({ force: true }); await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'AI 生成数据（2）' }).click(); await page.waitForTimeout(1200)
  const gen = await page.evaluate(() => ({ title: document.querySelector('.page-title')?.textContent ?? document.body.innerText.match(/AI 生成数据/)?.[0] ?? '', rows: Array.from(document.querySelectorAll('.mm-list label.mm-row')).filter((l) => /目标/.test(l.innerText)).map((l) => ({ label: l.querySelector('.mm-row-title')?.textContent ?? '', sub: l.querySelector('.mm-row-sub')?.textContent ?? '', checked: l.querySelector('input')?.checked })), caption: document.body.innerText.match(/已选类型[^\n]*/)?.[0] ?? '', source: document.body.innerText.match(/来源：[^\n]*/)?.[0] ?? '' }))
  record('types', gen)
  assert(gen.rows.length === 10, `类型数非10：${gen.rows.length}`)
  assert(gen.rows.every((r) => /目标 \d+ 个/.test(r.sub)), `目标数缺失：${JSON.stringify(gen.rows)}`)
  // 取消所有勾选再只选例句，观察合计变化
  for (const cb of await page.locator('.mm-list label.mm-row input[type=checkbox]').all()) { if (await cb.isChecked()) await cb.uncheck({ force: true }) }
  await page.waitForTimeout(300)
  const rowExample = page.locator('.mm-list label.mm-row').filter({ hasText: '例句' }).first(); await rowExample.locator('input').check({ force: true }); await page.waitForTimeout(300)
  const sum = await page.evaluate(() => ({ caption: document.body.innerText.match(/已选类型[^\n]*/)?.[0] ?? '', counts: Array.from(document.querySelectorAll('.mm-list label.mm-row')).filter((l) => /目标/.test(l.innerText)).map((l) => l.innerText.replace(/\s+/g, ' ')) }))
  record('selectExamples', sum); assert(/已选类型 1/.test(sum.caption), `已选类型合计未更新：${sum.caption}`)
  // 属性组筛选
  await page.locator('details').filter({ hasText: '每类型属性组筛选' }).locator('summary').click(); await page.waitForTimeout(300)
  await page.getByRole('button', { name: '+ 属性组' }).click(); await page.waitForTimeout(600)
  const propText = await page.locator('details').filter({ hasText: '每类型属性组筛选' }).innerText()
  record('propertyFilter', { propText: propText.replace(/\s+/g, ' ').slice(0, 220) })
  assert(/属性筛选后 \d+ 词|未筛选，seed 2 词/.test(propText), `属性筛选状态缺失：${propText.slice(0, 160)}`)
  await page.waitForTimeout(500)
  const zeroState = await page.evaluate(() => ({ counts: Array.from(document.querySelectorAll('.mm-list label.mm-row')).filter((l) => /目标/.test(l.innerText)).map((l) => l.querySelector('.mm-row-sub')?.textContent ?? ''), caption: document.body.innerText.match(/已选类型[^\n]*/)?.[0] ?? '', unified: Array.from(document.querySelectorAll('button')).find((b) => /统一生成|无可生成目标/.test(b.textContent ?? '')) ? { text: Array.from(document.querySelectorAll('button')).find((b) => /统一生成|无可生成目标/.test(b.textContent ?? ''))?.textContent?.trim(), disabled: Array.from(document.querySelectorAll('button')).find((b) => /统一生成|无可生成目标/.test(b.textContent ?? ''))?.disabled } : null, next: Array.from(document.querySelectorAll('button')).filter((b) => (b.textContent ?? '').includes('下一步')).length }))
  record('zeroTargets', zeroState)
  assert(zeroState.counts.length === 10 && zeroState.counts.every((t) => /目标 0 个/.test(t)) && /最终目标 0 个/.test(zeroState.caption) && zeroState.unified?.disabled === true && zeroState.next === 0, `0词目标/按钮状态错误：${JSON.stringify(zeroState)}`)
  // 批次/并发/预算 clamp
  const inputs = page.locator('.filter-batch-field input'); await inputs.nth(0).fill('100'); await inputs.nth(1).fill('10'); await inputs.nth(2).fill('5'); await page.waitForTimeout(300)
  const clamped = { batch: await inputs.nth(0).inputValue(), concurrency: await inputs.nth(1).inputValue(), budget: await inputs.nth(2).inputValue() }
  record('clamp', clamped); assert(clamped.batch === '50' && clamped.concurrency === '8' && clamped.budget === '5', `批次/并发/预算未 clamp：${JSON.stringify(clamped)}`)
  await page.screenshot({ path: join(OUT, '155-generate-types-390.png') }).catch(() => {})
  // 任务中心 seed
  await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const now = Date.now(); const jobs = [{ id: 'qa_running', name: 'QA运行任务', kind: 'examples', kinds: ['examples', 'phrases'], source: 'custom', cursor: 2, targetTotal: 10, results: [], failed: [], batchSize: 5, concurrency: 3, budget: { maxCostPerRun: 2 }, status: 'running', createdAt: now, updatedAt: now }, { id: 'qa_queued', name: 'QA排队任务', kind: 'examples', kinds: ['mnemonics'], source: 'custom', cursor: 0, targetTotal: 4, results: [], failed: [], batchSize: 2, concurrency: 1, status: 'queued', createdAt: now, updatedAt: now }]; await new Promise((res, rej) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key: 'ai.generationJobs', value: jobs, updatedAt: now }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) }) })
  await page.goto(`${BASE}#/me/jobs`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  const jobs = await page.evaluate(() => Array.from(document.querySelectorAll('.mm-list > .mm-row')).map((r) => { const btns = Array.from(r.querySelectorAll('button')).map((b) => { const x = b.getBoundingClientRect(); return { t: b.textContent?.trim(), y: Math.round(x.y), x: Math.round(x.x), w: Math.round(x.width) } }); return { text: r.innerText.replace(/\s+/g, ' '), buttons: btns } }))
  record('jobs', jobs)
  const running = jobs.find((j) => j.text.includes('QA运行任务'))
  assert(running && /类型 examples\/phrases/.test(running.text) && /批次 5/.test(running.text) && /并发 3/.test(running.text), `任务元信息缺失：${JSON.stringify(running)}`)
  assert(running.buttons.some((b) => b.t === '暂停') && running.buttons.some((b) => b.t === '取消'), `运行任务缺暂停/取消：${JSON.stringify(running.buttons)}`)
  assert(Math.max(...running.buttons.map((b) => b.y)) - Math.min(...running.buttons.map((b) => b.y)) <= 8, `任务按钮竖排：${JSON.stringify(running.buttons)}`)
  const row = page.locator('.mm-list > .mm-row').filter({ hasText: 'QA运行任务' }).first(); await row.getByRole('button', { name: '暂停' }).click(); await page.waitForTimeout(700)
  const paused = await row.innerText().catch(() => ''); record('paused', paused.replace(/\s+/g, ' ')); assert(/已暂停/.test(paused), `暂停未生效：${paused}`)
  await row.getByRole('button', { name: '取消' }).click(); await page.waitForTimeout(700)
  const canceled = await row.innerText().catch(() => ''); record('canceled', canceled.replace(/\s+/g, ' ')); assert(/已取消/.test(canceled), `取消未生效：${canceled}`)
  await page.screenshot({ path: join(OUT, '156-jobs-390.png') }).catch(() => {})
  // 360
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const small = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', small); assert(!small.overflow, '360 溢出')
  await page.screenshot({ path: join(OUT, '156b-jobs-360.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t600] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t600] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '39-task600-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task600.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
