#!/usr/bin/env node
/** 0.5.0 筛选→AI/临时/索引集快照/任务续跑。不调真实 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t500] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const ids = Array.from({ length: 5 }, (_, i) => (i === 0 ? 'embrace' : i === 1 ? 'embed' : i === 2 ? 'embody' : i === 3 ? 'embryo' : 'elicit')).map((w) => `kaoyan-2027-dagang:${w}`)
const seedJob = () => page.evaluate(async (wordIds) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const now = Date.now()
  const job = { id: 'qa_job_resume', name: 'QA续跑任务', kind: 'examples', source: 'custom', targets: wordIds.map((wordId) => ({ wordId })), cursor: 2, results: wordIds.slice(0, 2).map((wordId) => ({ wordId, at: now })), failed: [], status: 'paused', filter: { deckId: 'kaoyan-2027-dagang' }, createdAt: now, updatedAt: now }
  const old = { id: 'qa_job_old', name: 'QA旧任务', kind: 'examples', source: 'custom', cursor: 0, results: [], failed: [], status: 'paused', createdAt: now - 1000, updatedAt: now - 1000 }
  await new Promise((res, rej) => { const tx = db.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ key: 'ai.generationJobs', value: [job, old], updatedAt: now }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, ids)
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/filter`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  await page.getByRole('button', { name: '列表', exact: true }).click(); await page.waitForTimeout(400)
  await page.locator('select[aria-label="值"]').last().selectOption('false'); await page.getByRole('button', { name: /执行筛选/ }).click(); await page.waitForTimeout(900)
  const boxes = page.locator('.mm-list label.mm-row input[type=checkbox]')
  await boxes.nth(0).check({ force: true }); await boxes.nth(1).check({ force: true }); await page.waitForTimeout(400)
  const actionText = ((await page.locator('.filter-actions').innerText().catch(() => '')) || (await page.locator('body').innerText())).match(/AI 生成数据（\d+）[^\n]*/)?.[0] ?? ''
  const bar = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => /AI 生成数据|临时复习/.test(b.textContent ?? '')).map((b) => b.textContent?.trim()))
  record('bar', { bar, actionText })
  assert(bar.some((t) => t.includes('AI 生成数据（2）')) && bar.some((t) => t.includes('临时复习（2）')), `底部条数量错误：${JSON.stringify(bar)}`)
  // 保存 2 词快照
  await page.getByRole('button', { name: '保存索引集' }).first().click(); await page.waitForTimeout(400)
  const saveDlg = page.getByRole('dialog', { name: '保存索引集' }).first(); const saveTip = await saveDlg.innerText()
  record('saveDialog', { saveTip: saveTip.replace(/\s+/g, ' ') }); assert(/2 个词/.test(saveTip), `保存弹窗未提示2词快照：${saveTip}`)
  await saveDlg.getByLabel('索引集名称').fill('QA快照集'); await saveDlg.getByRole('button', { name: '保存' }).click(); await page.waitForTimeout(700)
  const cardText = await page.locator('.saved-filter-card').filter({ hasText: 'QA快照集' }).innerText().catch(() => '')
  record('savedCard', { cardText: cardText.replace(/\s+/g, ' ') }); assert(/2 词快照/.test(cardText), `索引集未显示2词快照：${cardText}`)
  // AI 生成页来源2，关闭回筛选
  await page.getByRole('button', { name: 'AI 生成数据（2）' }).click(); await page.waitForTimeout(1000)
  const genUrl = page.url(); const genBody = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('generatePage', { genUrl, source2: /来源[^\n]{0,30}2 词|高级筛选 2 词/.test(genBody), body: genBody.slice(0, 120) })
  assert(genUrl.includes('/generate') && /高级筛选 2 词|来源.*2/.test(genBody), `生成页来源错误：${genUrl} ${genBody.slice(0, 120)}`)
  const targetText = (await page.locator('body').innerText()).match(/目标：[^\n·]*/)?.[0] ?? ''
  const rareToggle = page.locator('label').filter({ hasText: '仅未标记不常考' }).locator('input').first()
  const rareBefore = await rareToggle.isChecked().catch(() => null)
  if (await rareToggle.count()) { await rareToggle.check({ force: true }); await page.waitForTimeout(500) }
  const targetAfter = (await page.locator('body').innerText()).match(/目标：[^\n·]*/)?.[0] ?? ''
  record('typeFilter', { targetText, rareBefore, targetAfter })
  await page.screenshot({ path: join(OUT, '152-filter-generate-390.png') }).catch(() => {})
  await page.getByRole('button', { name: '关闭', exact: true }).last().click(); await page.waitForTimeout(800)
  assert(page.url().includes('/filter'), `关闭未回筛选：${page.url()}`)
  const restored = await page.evaluate(() => ({ rows: document.querySelectorAll('.mm-list label.mm-row').length, checked: document.querySelectorAll('.mm-list label.mm-row input[type=checkbox]:checked').length, value: Array.from(document.querySelectorAll('select')).filter((x) => Array.from(x.options).some((o) => o.textContent === '是'))[0]?.value ?? '' }))
  record('restoredAfterGenerate', restored)
  assert(restored.rows > 0 && restored.checked === 2, `关闭生成页后结果/已选丢失：${JSON.stringify(restored)}`)
  // 改条件重跑→载入仍快照
  await page.locator('select[aria-label="值"]').last().selectOption('true'); await page.getByRole('button', { name: /执行筛选/ }).click(); await page.waitForTimeout(700)
  await page.locator('.saved-filter-card').filter({ hasText: 'QA快照集' }).getByRole('button', { name: '载入' }).click(); await page.waitForTimeout(800)
  const afterLoad = await page.evaluate(() => Array.from(document.querySelectorAll('button')).filter((b) => /AI 生成数据/.test(b.textContent ?? '')).map((b) => b.textContent?.trim()))
  record('loadSnapshot', { afterLoad }); assert(afterLoad.some((t) => t.includes('（2）')), `载入快照后不是2词：${JSON.stringify(afterLoad)}`)
  // 临时复习 words=2
  const beforeTemp = await page.evaluate(() => ({ rows: document.querySelectorAll('.mm-list label.mm-row').length, checked: document.querySelectorAll('.mm-list label.mm-row input[type=checkbox]:checked').length }))
  await page.getByRole('button', { name: '临时复习（2）' }).click(); await page.waitForTimeout(900)
  const tempUrl = page.url(); const tempBody = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('tempReview', { tempUrl, body: tempBody.slice(0, 100) })
  const tempWords = decodeURIComponent(tempUrl).match(/tempWords=([^&]+)/)?.[1]?.split(',') ?? []
  assert(/tempWords=/.test(tempUrl) && tempWords.length === 2, `临时复习未带2词：${tempUrl}`)
  await page.getByRole('button', { name: '退出临时复习' }).click(); await page.waitForTimeout(900)
  record('tempReturnUrl', { url: page.url() })
  const tempRestored = await page.evaluate(() => ({ rows: document.querySelectorAll('.mm-list label.mm-row').length, checked: document.querySelectorAll('.mm-list label.mm-row input[type=checkbox]:checked').length }))
  record('restoredAfterTemp', tempRestored)
  assert(tempRestored.rows > 0 && tempRestored.checked === beforeTemp.checked, `临时复习返回后结果/已选丢失：before=${JSON.stringify(beforeTemp)} after=${JSON.stringify(tempRestored)}`)
  // 种子 job 续跑
  await seedJob(); await page.goto(`${BASE}#/me/jobs`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  await page.getByRole('button', { name: '继续' }).first().click(); await page.waitForTimeout(1200)
  const resumeUrl = page.url(); const resumeBody = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('resume', { resumeUrl, remaining: /剩余\s*3\s*词/.test(resumeBody), body: resumeBody.slice(0, 160) })
  assert(/generate\?jobId=qa_job_resume/.test(resumeUrl) && /剩余\s*3\s*词/.test(resumeBody), `续跑未只带剩余3词：${resumeUrl} ${resumeBody.slice(0, 120)}`)
  await page.screenshot({ path: join(OUT, '153-generate-resume-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const small = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', small); assert(!small.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t500] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t500] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '41-task500-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task500.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
