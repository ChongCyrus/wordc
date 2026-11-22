#!/usr/bin/env node
/** 0.4.0 B2 AI 生成任务中心：列表/状态/重命名/删除/清理/重启持久。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[b2] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const seed = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const now = Date.now()
  const jobs = [
    { id: 'qa_job_failed', name: 'QA失败任务', kind: 'examples', source: 'deck', cursor: 3, targetTotal: 10, results: [], failed: [{ message: 'mock fail' }], budget: { spentYuan: 0.12, maxCostPerRun: 3 }, concurrency: 2, status: 'paused', error: 'mock error', createdAt: now - 3000, updatedAt: now - 2000 },
    { id: 'qa_job_completed', name: 'QA完成任务', kind: 'mnemonics', source: 'deck', cursor: 5, targetTotal: 5, results: [{ at: now }], failed: [], status: 'completed', createdAt: now - 5000, updatedAt: now - 4000 },
  ]
  await new Promise((res, rej) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key: 'ai.generationJobs', value: jobs, updatedAt: now }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await seed()
  await page.goto(`${BASE}#/me/jobs`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('list', { failed: /QA失败任务/.test(text), completed: /QA完成任务/.test(text), progress: /进度 3\/10/.test(text), spent: /已花费 ¥0.12/.test(text), concurrency: /并发 2/.test(text), error: /mock error/.test(text), resume: await page.getByRole('button', { name: '继续' }).count() })
  assert(/QA失败任务/.test(text) && /QA完成任务/.test(text) && /进度 3\/10/.test(text) && /已花费 ¥0.12/.test(text), `任务列表字段缺失：${text.slice(0, 200)}`)
  const btnLayout = await page.evaluate(() => { const row = Array.from(document.querySelectorAll('.mm-list > .mm-row')).find((r) => (r.textContent ?? '').includes('QA失败任务')); const btns = row ? Array.from(row.querySelectorAll('button')) : []; const rects = btns.map((b) => { const r = b.getBoundingClientRect(); return { text: (b.textContent ?? '').trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }); return rects })
  record('buttonLayout', btnLayout)
  assert(btnLayout.length >= 2 && (Math.max(...btnLayout.map((b) => b.y)) - Math.min(...btnLayout.map((b) => b.y))) <= 8, `任务按钮竖排：${JSON.stringify(btnLayout)}`)
  // 重命名（prompt）
  page.once('dialog', async (d) => d.accept('QA改名任务'))
  await page.getByRole('button', { name: '重命名' }).first().click(); await page.waitForTimeout(700)
  const renamed = (await page.locator('body').innerText()).includes('QA改名任务')
  // 重启后仍可见
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  const persisted = (await page.locator('body').innerText()).includes('QA改名任务')
  record('renamePersist', { renamed, persisted })
  assert(renamed && persisted, `重命名/重启持久失败：${JSON.stringify({ renamed, persisted })}`)
  // 删除失败任务
  const rows = page.locator('.mm-list > .mm-row')
  const beforeRows = await rows.count()
  const failedRow = rows.filter({ hasText: 'QA改名任务' }).first()
  await failedRow.getByRole('button', { name: '删除' }).click(); await page.waitForTimeout(700)
  const afterRows = await rows.count()
  record('delete', { beforeRows, afterRows })
  assert(afterRows === beforeRows - 1, `删除任务失败：${beforeRows}→${afterRows}`)
  // 清理已完成
  await page.getByRole('button', { name: '清理已完成' }).click(); await page.waitForTimeout(700)
  const cleared = !(await page.locator('body').innerText()).includes('QA完成任务')
  record('clear', { cleared })
  assert(cleared, '清理已完成失败')
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  await page.screenshot({ path: join(OUT, '134-b2-jobs-360.png') }).catch(() => {})
  assert(!layout.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[b2] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[b2] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '51-b2-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-b2.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
