#!/usr/bin/env node
/** 0.3.91 task-268：单元点词详情、词库行不熟度、升降序、选择前N、记住模式/数量、Unit1首帧。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t268] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.waitForTimeout(8000)
  const seeded = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); return await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('generated.defaultSeeded'); r.onsuccess = () => res(r.result?.value ?? null) }) })
  record('generatedSeed', seeded)
  // 单元点词 -> 详情
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/units`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  await page.locator('a.mm-row').first().click(); await page.waitForTimeout(900)
  const firstWord = page.locator('.mm-list .mm-row').first(); await firstWord.waitFor({ state: 'visible', timeout: 8000 })
  const wordText = (await firstWord.innerText()).trim()
  await firstWord.click(); await page.waitForTimeout(2500)
  if ((await page.locator('.annotation-stage').count()) === 0) await page.waitForTimeout(3000)
  const url = page.url()
  const ratings = await page.getByRole('button', { name: /^(认识|模糊|不认识|忘记)$/ }).count()
  record('unitWordDetail', { url, wordText: wordText.slice(0, 60), ratings, annotation: await page.locator('.annotation-stage').count() })
  assert(/detailWord=/.test(url) && ratings === 0 && (await page.locator('.annotation-stage').count()) > 0, `单元点词应进完整详情无评分：${JSON.stringify({ url, ratings })}`)
  await page.screenshot({ path: join(OUT, '94-unit-word-detail-390.png') }).catch(() => {})
  // 词库行不熟度
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1800)
  const search = page.locator('input[placeholder*="搜索英文"]').first(); await search.waitFor({ state: 'visible', timeout: 15000 }); await search.fill('denounce'); await page.waitForTimeout(900)
  const rowText = (await page.locator('.mm-list button.mm-row').first().innerText().catch(() => '')) || (await page.locator('body').innerText())
  record('deckRowFamiliarity', { hasPercent: /\d+%/.test(rowText), rowText: rowText.slice(0, 120) })
  assert(/\d+%/.test(rowText), `词库行应显示不熟悉度：${rowText.slice(0, 100)}`)
  await search.fill(''); await page.waitForTimeout(500)
  // 选择态升降序 + 选择前N
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(500)
  const firstAsc = (await page.locator('.mm-list button.mm-row .mm-row-title').first().innerText()).trim()
  await page.locator('.bulk-toolbar').getByLabel('排序', { exact: true }).selectOption('alpha'); await page.waitForTimeout(700)
  await page.locator('.bulk-toolbar').getByLabel('排序方向', { exact: true }).selectOption('desc'); await page.waitForTimeout(700)
  const firstDesc = (await page.locator('.mm-list button.mm-row .mm-row-title').first().innerText()).trim()
  record('sortDirection', { firstAsc, firstDesc, direction: await page.locator('.bulk-toolbar').getByLabel('排序方向', { exact: true }).inputValue() })
  assert(firstAsc !== firstDesc, `升降序首词应不同：${firstAsc}→${firstDesc}`)
  await page.getByLabel('选择前 N 个数量').fill('5'); await page.getByRole('button', { name: '选择前 N 个' }).click(); await page.waitForTimeout(700)
  const selCount = (await page.locator('body').innerText()).match(/已选 (\d+) \/ 筛选/)?.[1]
  record('selectFirstN', { selected: selCount })
  assert(selCount === '5', `选择前5应已选5：${selCount}`)
  await page.screenshot({ path: join(OUT, '95-deck-first-n-390.png') }).catch(() => {})
  await page.getByRole('button', { name: '完成', exact: true }).click(); await page.waitForTimeout(400)
  // 记住添加模式/数量
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000)
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  const addDlg = page.getByRole('dialog', { name: '添加今日新单词' }).first(); await addDlg.waitFor({ state: 'visible', timeout: 5000 })
  await addDlg.getByRole('button', { name: '随机选择' }).click(); await addDlg.locator('#add-word-count').fill('7'); await addDlg.locator('#add-word-count').blur(); await page.waitForTimeout(300)
  await addDlg.getByRole('button', { name: '取消', exact: true }).click(); await page.waitForTimeout(400)
  await page.getByText('添加今日新单词', { exact: true }).first().click(); await page.waitForTimeout(500)
  const addDlg2 = page.getByRole('dialog', { name: '添加今日新单词' }).first()
  const remembered = await addDlg2.locator('#add-word-count').inputValue().catch(() => '')
  const randomActive = (await addDlg2.getByRole('button', { name: '随机选择' }).getAttribute('class') ?? '').includes('primary')
  record('rememberAdd', { count: remembered, randomActive })
  assert(remembered === '7' && randomActive, `应记住模式/数量：${JSON.stringify({ remembered, randomActive })}`)
  await page.screenshot({ path: join(OUT, '96-add-remember-390.png') }).catch(() => {})
  await addDlg2.getByRole('button', { name: '取消', exact: true }).click()
  // Unit1 首帧无空态
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/units`, { waitUntil: 'domcontentloaded' })
  await page.locator('a.mm-row').first().click()
  await page.waitForTimeout(80)
  const early = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('unit1FirstFrame', { emptyFlash: /没有单词/.test(early), loading: /加载中|正在加载/.test(early), early: early.slice(0, 100) })
  await page.waitForTimeout(1200)
  assert(!/没有单词/.test(early), `Unit1 首帧不应闪空态：${early.slice(0, 100)}`)
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('layout360', layout)
  assert(!layout.overflow, '360 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t268] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t268] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '66-task268-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task268.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
