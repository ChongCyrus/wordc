#!/usr/bin/env node
/** 0.4.0-B1 高级筛选：组内/组间 AND/OR、排序/分组、保存索引集 CRUD。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[b1] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const total = async () => { await page.getByRole('button', { name: /执行筛选|筛选中/ }).click(); await page.waitForTimeout(700); return (await page.locator('body').innerText()).match(/已选 \d+ \/ 筛选 (\d+)/)?.[1] ?? null }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/filter`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  if (await page.getByRole('button', { name: '列表', exact: true }).count()) { await page.getByRole('button', { name: '列表', exact: true }).click(); await page.waitForTimeout(500) }
  assert((await page.locator('.advanced-filter-group').count()) === 1, '默认应有1组')
  const single = await total()
  // 组2 learned=false；组间 AND→0，OR→全部
  await page.getByRole('button', { name: '+ 属性组' }).click(); await page.waitForTimeout(300)
  assert((await page.locator('.advanced-filter-group').count()) === 2, '应新增第2组')
  await page.getByLabel('值').nth(1).selectOption('false')
  await page.getByLabel('组间关系').selectOption('and').catch(async () => { await page.locator('select').first().selectOption('and') })
  const andTotal = await total()
  await page.getByLabel('组间关系').selectOption('or').catch(async () => { await page.locator('select').first().selectOption('or') })
  const orTotal = await total()
  record('groupLogic', { single, andTotal, orTotal })
  assert(andTotal === '0' && Number(orTotal) > Number(single), `组间 AND/OR 错误：${JSON.stringify({ single, andTotal, orTotal })}`)
  // 多值 chips（rare）
  await page.getByLabel('属性').nth(1).selectOption('rare'); await page.waitForTimeout(600)
  const chips = await page.locator('.advanced-filter-chip').allTextContents().catch(() => [])
  const chipBoxes = page.locator('.advanced-filter-chip input')
  const chipCount = await chipBoxes.count()
  if (chipCount >= 2) { await chipBoxes.nth(0).check(); await chipBoxes.nth(1).check(); await page.waitForTimeout(400) }
  record('chips', { chips, chipCount })
  assert(chips.length >= 3 && chipCount >= 2, `rare 多值 chips 缺失：${JSON.stringify({ chips, chipCount })}`)
  // 排序/分组
  await page.locator('select').filter({ hasText: '按单元分组' }).selectOption('chapter')
  await page.locator('select').filter({ hasText: '字母 A-Z' }).selectOption('alpha')
  await page.locator('select').filter({ hasText: '升序' }).selectOption('asc')
  const grouped = await total()
  const first = await page.locator('.advanced-filter-group + div .mm-row-title, .mm-list .mm-row-title').first().innerText().catch(() => '')
  record('sortGroup', { grouped, first })
  // 保存索引集
  await page.getByRole('button', { name: '保存索引集' }).first().click()
  const saveDlg = page.getByRole('dialog', { name: '保存索引集' }).first(); await saveDlg.waitFor({ state: 'visible', timeout: 5000 })
  await saveDlg.getByLabel('索引集名称').fill('QA索引')
  await saveDlg.getByRole('button', { name: '保存' }).click(); await page.waitForTimeout(800)
  const sets1 = (await page.locator('body').innerText()).match(/QA索引/g)?.length ?? 0
  // 同名保存覆盖
  await page.getByRole('button', { name: '保存索引集' }).first().click(); await saveDlg.waitFor({ state: 'visible', timeout: 5000 }); await saveDlg.getByLabel('索引集名称').fill('QA索引'); await saveDlg.getByRole('button', { name: '保存' }).click(); await page.waitForTimeout(700)
  const sets2 = (await page.locator('body').innerText()).match(/QA索引/g)?.length ?? 0
  record('savedSets', { sets1, sets2 })
  assert(sets1 >= 1 && sets2 === sets1, `同名保存不应重复：${sets1}→${sets2}`)
  // 索引集载入恢复 sort/groupBy/direction
  await page.locator('select').filter({ hasText: '按已学分组' }).selectOption('learned')
  await page.locator('select').filter({ hasText: '词库顺序' }).selectOption('order')
  await page.locator('select').filter({ hasText: '降序' }).selectOption('desc')
  await page.getByRole('button', { name: '载入' }).first().click(); await page.waitForTimeout(600)
  const restored = await page.evaluate(() => ({ groupBy: Array.from(document.querySelectorAll('select')).find((x) => Array.from(x.options).some((o) => o.textContent === '按单元分组'))?.value, sort: Array.from(document.querySelectorAll('select')).find((x) => Array.from(x.options).some((o) => o.textContent === '字母 A-Z'))?.value, direction: Array.from(document.querySelectorAll('select')).find((x) => Array.from(x.options).some((o) => o.textContent === '升序'))?.value }))
  record('loadRestore', restored)
  assert(restored.groupBy === 'chapter' && restored.sort === 'alpha' && restored.direction === 'asc', `载入未恢复排序/分组：${JSON.stringify(restored)}`)
  // 索引集行按钮同排/不重叠（390/360）
  const savedBtns390 = await page.evaluate(() => { const row = document.querySelector('.saved-filter-card'); if (!row) return []; return Array.from(row.querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); return { text: (b.textContent ?? '').trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }) })
  let savedOverlap = false
  for (let i = 0; i < savedBtns390.length; i += 1) for (let j = i + 1; j < savedBtns390.length; j += 1) { const a = savedBtns390[i]; const b = savedBtns390[j]; if (!(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y)) savedOverlap = true }
  record('savedRow390', { savedBtns390, savedOverlap })
  assert(savedBtns390.length >= 2 && Math.max(...savedBtns390.map((b) => b.y)) - Math.min(...savedBtns390.map((b) => b.y)) <= 8 && !savedOverlap, `索引集行按钮挤压：${JSON.stringify(savedBtns390)}`)
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const savedBtns360 = await page.evaluate(() => { const row = document.querySelector('.saved-filter-card'); if (!row) return []; return Array.from(row.querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); return { text: (b.textContent ?? '').trim(), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }) })
  record('savedRow360', savedBtns360)
  assert(savedBtns360.every((b) => b.w >= 40) && savedBtns360.every((b, i) => i === 0 || b.y >= savedBtns360[i - 1].y - 1), `360 索引集按钮异常：${JSON.stringify(savedBtns360)}`)
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  // 重命名
  page.once('dialog', async (d) => { await d.accept('QA索引2') })
  await page.getByRole('button', { name: '重命名' }).first().click(); await page.waitForTimeout(800)
  const renamed = (await page.locator('body').innerText()).includes('QA索引2')
  record('rename', { renamed }); assert(renamed, '重命名失败')
  // 删除
  const setRow = page.locator('.saved-filter-card').filter({ hasText: 'QA索引2' }).first()
  await setRow.getByRole('button', { name: '删除' }).click(); await page.waitForTimeout(1500)
  const deleted = (await page.locator('.saved-filter-card').filter({ hasText: 'QA索引2' }).count()) === 0
  record('delete', { deleted }); assert(deleted, '删除索引集失败')
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  await page.screenshot({ path: join(OUT, '133-b1-filter-360.png') }).catch(() => {})
  assert(!layout.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[b1] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[b1] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '52-b1-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-b1.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
