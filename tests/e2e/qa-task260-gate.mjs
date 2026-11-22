#!/usr/bin/env node
/** 0.3.87 task-259/260：添加新词/计划弹窗、单元列表详情、完整排行、抽词复习不改DHP、新词来源、360/390。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t260] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const dbEval = (fn) => page.evaluate(async (src) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const activeId = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
  const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(activeId); r.onsuccess = () => res(r.result) })
  const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').count(); r.onsuccess = () => res(r.result) })
  return { planLen: plan?.wordIds?.length ?? 0, index: plan?.index ?? 0, states }
}, fn)
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000)
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  const addDlg = page.getByRole('dialog', { name: '添加今日新单词' }).first()
  await addDlg.waitFor({ state: 'visible', timeout: 5000 })
  const addText = (await addDlg.innerText()).replace(/\s+/g, ' ')
  record('addDialog', { modes: ['手动筛选', '随机选择', '顺序选择'].every((x) => addText.includes(x)), search: await addDlg.getByLabel('搜索未学单词').count(), unit: await addDlg.getByLabel('选择单元').count() })
  assert(['手动筛选', '随机选择', '顺序选择'].every((x) => addText.includes(x)), '添加弹窗应有三模式')
  await addDlg.getByRole('button', { name: '随机选择' }).click()
  const countVal = await addDlg.locator('#add-word-count').inputValue(); record('defaultCount', { countVal })
  assert(countVal === '20', `随机默认20，实际 ${countVal}`)
  await addDlg.getByRole('button', { name: '手动筛选' }).click(); await page.waitForTimeout(400)
  const boxes = addDlg.locator('.add-word-candidates input[type=checkbox]')
  assert((await boxes.count()) > 0, '手动候选应有词')
  await boxes.first().check()
  await addDlg.getByRole('button', { name: '添加' }).click()
  const planDlg = page.getByRole('dialog', { name: '已有今日计划' }).first()
  const planVisible = await planDlg.isVisible().catch(() => false)
  record('planDialog', { visible: planVisible })
  if (planVisible) {
    const pt = (await planDlg.innerText()).replace(/\s+/g, ' ')
    assert(['保留今日计划并追加', '移除今天未学的自动新词后追加', '仅移除未学的自动新词', '取消'].every((x) => pt.includes(x)), `计划弹窗四选项：${pt}`)
    const before = await dbEval(); await planDlg.getByText('保留今日计划并追加', { exact: true }).click()
    await page.waitForFunction(() => /已追加/.test(document.body.innerText), null, { timeout: 10_000 })
    const after = await dbEval(); record('keepAppend', { before, after })
    assert(after.planLen > before.planLen, `保留追加后计划应增长：${before.planLen}→${after.planLen}`)
  } else {
    const after = await dbEval(); record('directAppend', after); assert(after.planLen >= 3, '添加后计划有词')
  }
  await page.screenshot({ path: join(OUT, '78-add-today-390.png') }).catch(() => {})
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/units`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const unitText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const unitRows = page.locator('a.mm-row')
  record('unitList', { title: /按单元/.test(unitText), current: /当前：Unit/.test(unitText), rows: await unitRows.count(), fields: /\d+ 词 · 已学 \d+ · 未学 \d+ · 到期 \d+/.test(unitText) })
  assert(/按单元/.test(unitText) && (await unitRows.count()) > 0 && /\d+ 词 · 已学 \d+ · 未学 \d+ · 到期 \d+/.test(unitText), '单元列表应有字段/行')
  await unitRows.first().click(); await page.waitForTimeout(900)
  const udText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  assert((await page.getByLabel('搜索单元单词').count()) === 1 && /全部/.test(udText) && /已学/.test(udText) && /未学/.test(udText) && /上一页/.test(udText), '单元详情应搜索/筛选/分页')
  const unitBoxes = page.locator('.mm-list input[type=checkbox]')
  assert((await unitBoxes.count()) > 0, '单元详情应有词')
  const totalBoxes = await unitBoxes.count(); for (let i = 0; i < Math.min(5, totalBoxes); i += 1) await unitBoxes.nth(i).check()
  const pickCount = Math.min(5, totalBoxes)
  await page.getByRole('button', { name: new RegExp(`抽这些词复习（${pickCount}）`) }).first().click()
  const confirm = page.getByRole('dialog', { name: '抽这些词复习？' }).first(); await confirm.waitFor({ state: 'visible', timeout: 5000 })
  const beforePick = await dbEval(); await confirm.getByRole('button', { name: new RegExp(`追加 ${pickCount} 词`) }).click()
  await page.waitForFunction(() => /已追加/.test(document.body.innerText), null, { timeout: 10_000 })
  const afterPick = await dbEval(); record('pickReview', { beforePick, afterPick })
  assert(afterPick.states === beforePick.states && afterPick.planLen > beforePick.planLen, `抽词复习不改DHP且计划增长：${JSON.stringify({ beforePick, afterPick })}`)
  await page.screenshot({ path: join(OUT, '79-unit-detail-390.png') }).catch(() => {})
  await page.goto(`${BASE}#/stats/ranking`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const rankText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('ranking', { title: /不熟悉度排行/.test(rankText), modes: /最不熟/.test(rankText) && /最熟/.test(rankText), top20: /最不熟前 20 一键/.test(rankText), search: await page.getByLabel('搜索排行单词').count(), rows: await page.locator('.mm-list .mm-row').count() })
  assert(/不熟悉度排行/.test(rankText) && /最不熟/.test(rankText) && /最熟/.test(rankText) && /最不熟前 20 一键/.test(rankText), '排行页应有模式/前20')
  await page.screenshot({ path: join(OUT, '80-ranking-390.png') }).catch(() => {})
  await page.goto(`${BASE}#/me/settings`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const setText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  assert(/新词来源/.test(setText) && /手动/.test(setText) && /自动/.test(setText), '设置应有新词来源')
  const manualBtn = page.getByRole('button', { name: '手动', exact: true }).first(); const autoBtn = page.getByRole('button', { name: '自动', exact: true }).first()
  await autoBtn.click(); await page.waitForTimeout(300); const autoOn = await autoBtn.getAttribute('class')
  await manualBtn.click(); await page.waitForTimeout(300)
  record('newWordSource', { autoClass: autoOn, manualClass: await manualBtn.getAttribute('class') })
  await page.goto(`${BASE}#/stats/ranking`, { waitUntil: 'domcontentloaded' }); await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(400)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('layout360', layout)
  assert(!layout.overflow, '360 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t260] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t260] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '74-task260-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task260.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
