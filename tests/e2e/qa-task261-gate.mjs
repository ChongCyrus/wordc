#!/usr/bin/env node
/** 0.3.88 task-261：数量输入 clamp、词库单词全屏详情/无评分/编辑/删除、批量工具条、390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t261] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setCount = async (value) => {
  const inp = page.locator('#add-word-count')
  await inp.fill(value); await inp.blur(); await page.waitForTimeout(200)
  return inp.inputValue()
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000)
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  const addDlg = page.getByRole('dialog', { name: '添加今日新单词' }).first(); await addDlg.waitFor({ state: 'visible', timeout: 5000 })
  await addDlg.getByRole('button', { name: '随机选择' }).click()
  const c1 = await setCount('-5'); const c2 = await setCount('1200'); const c3 = await setCount(''); const c4 = await setCount('0')
  record('countClamp', { neg: c1, big: c2, empty: c3, zero: c4 })
  assert(c1 === '1' && c2 === '999' && c3 === '20' && c4 === '1', `数量 clamp 错误：${JSON.stringify({ c1, c2, c3, c4 })}`)
  // 批量工具条（手动模式）
  await addDlg.getByRole('button', { name: '手动筛选' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.add-word-candidates input[type=checkbox]').length > 0, null, { timeout: 20_000 })
  const toolbarText = (await addDlg.innerText()).replace(/\s+/g, ' ')
  const sortOpts = await addDlg.getByLabel('排序').locator('option').allTextContents()
  record('manualToolbar', { text: /\d+ \/ 筛选 \d+|已选 \d+/.test(toolbarText), sortOpts, selectAll: await addDlg.getByRole('button', { name: '全选', exact: true }).count(), invert: await addDlg.getByRole('button', { name: '反选', exact: true }).count(), clear: await addDlg.getByRole('button', { name: '取消全选', exact: true }).count() })
  assert(sortOpts.length === 4 && /已选 \d+/.test(toolbarText) && /筛选 \d+/.test(toolbarText), `手动工具条应有四档/已选/筛选：${JSON.stringify({ sortOpts, toolbarText: toolbarText.slice(0, 120) })}`)
  await addDlg.getByRole('button', { name: '全选', exact: true }).click(); await page.waitForTimeout(500)
  const selAll = (await addDlg.innerText()).match(/已选 (\d+) \/ 筛选 (\d+)/); record('selectAll', { selAll: selAll?.[0] })
  assert(selAll && Number(selAll[1]) > 0, `全选应选词：${selAll?.[0]}`)
  await addDlg.getByRole('button', { name: '取消全选', exact: true }).click(); await page.waitForTimeout(300)
  const selNone = (await addDlg.innerText()).match(/已选 (\d+) \/ 筛选 (\d+)/); record('selectNone', { selNone: selNone?.[0] })
  assert(selNone && Number(selNone[1]) === 0, `取消应0：${selNone?.[0]}`)
  await addDlg.getByRole('button', { name: '取消', exact: true }).click().catch(() => {})
  // 词库单词全屏详情
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/words/kaoyan-2027-dagang:denounce`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  const wdText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const ratingCount = await page.getByRole('button', { name: /^认识$|^模糊$|^不认识$/ }).count()
  record('wordDetail', { headword: /denounce/.test(wdText), phonetic: await page.locator('.word-phonetic, .phonetic, .annotation-phonetic').count(), meanings: await page.locator('.meaning-row').count(), ratingCount, edit: await page.getByRole('button', { name: '编辑', exact: true }).count(), del: await page.getByRole('button', { name: '删除', exact: true }).count() })
  assert(/denounce/.test(wdText) && ratingCount === 0 && (await page.getByRole('button', { name: '编辑', exact: true }).count()) === 1, `单词详情应展示且无评分：${JSON.stringify({ ratingCount })}`)
  await page.screenshot({ path: join(OUT, '82-word-detail-390.png') }).catch(() => {})
  await page.getByRole('button', { name: '编辑', exact: true }).click(); await page.waitForTimeout(700)
  const editDlg = page.getByRole('dialog', { name: '编辑单词' }).first()
  const editVisible = await editDlg.isVisible().catch(() => false)
  record('editRoute', { url: page.url(), editDialog: editVisible })
  assert(editVisible, `编辑应打开词库原表单：${page.url()}`)
  // 删除单词
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/words/kaoyan-2027-dagang:denounce`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const countBefore = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); return await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(!!r.result) }) })
  await page.getByRole('button', { name: '删除', exact: true }).click()
  await page.waitForFunction(() => /已删除单词|删除失败/.test(document.body.innerText), null, { timeout: 10_000 })
  const countAfter = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); return await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(!!r.result) }) })
  record('deleteWord', { countBefore, countAfter, toast: (await page.locator('body').innerText()).match(/已删除单词|删除失败[^\\n]*/)?.[0] ?? '' })
  assert(countBefore && !countAfter && /已删除单词/.test(await page.locator('body').innerText()), '删除应成功移出词库')
  // 排行/单元工具条
  await page.goto(`${BASE}#/stats/ranking`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  const rankTb = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const rankSort = await page.getByLabel('排序').locator('option').allTextContents().catch(() => [])
  record('rankingToolbar', { sort: rankSort, toolbar: /已选 \d+ \/ 筛选 \d+/.test(rankTb), selectAll: await page.getByRole('button', { name: '全选', exact: true }).count() })
  await page.screenshot({ path: join(OUT, '83-ranking-toolbar-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('layout360', layout)
  assert(!layout.overflow, '360 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t261] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t261] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '72-task261-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task261.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
