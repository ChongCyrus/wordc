#!/usr/bin/env node
/** 0.3.90 task-267：Deck/Unit 选择态仅一套 Bulk 工具条；AI 预选计数 N/共N；390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t267] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const counts = async () => page.evaluate(() => ({
  normalSearch: document.querySelectorAll('input[placeholder*="搜索英文"]').length,
  bulkSearch: document.querySelectorAll('input[aria-label="搜索词库单词"]').length,
  unitBulkSearch: document.querySelectorAll('input[aria-label="搜索单元单词"]').length,
  statusSelect: document.querySelectorAll('select[aria-label="状态筛选"]').length,
  sortSelect: document.querySelectorAll('select[aria-label="排序"]').length,
  segAll: Array.from(document.querySelectorAll('button')).filter((b) => (b.textContent ?? '').trim() === '全部').length,
  toolbar: document.querySelectorAll('.bulk-toolbar').length,
}))
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const normal = await counts(); record('deckNormal', normal)
  assert(normal.normalSearch === 1 && normal.toolbar === 0 && normal.segAll >= 1, `常态应保留原搜索/筛选且无 Bulk：${JSON.stringify(normal)}`)
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(600)
  const sel = await counts(); record('deckSelect', sel)
  assert(sel.normalSearch === 0 && sel.toolbar === 1 && sel.bulkSearch === 1 && sel.statusSelect === 1 && sel.sortSelect === 1 && sel.segAll === 0, `选择态应只一套 Bulk：${JSON.stringify(sel)}`)
  // 全选/取消仍可用
  await page.getByRole('button', { name: '全选', exact: true }).click(); await page.waitForTimeout(500)
  const allTxt = (await page.locator('body').innerText()).match(/已选 \d+ \/ 筛选 \d+/)?.[0] ?? ''
  await page.screenshot({ path: join(OUT, '91-deck-bulk-only-390.png') }).catch(() => {})
  await page.getByRole('button', { name: '取消全选', exact: true }).click(); await page.waitForTimeout(300)
  await page.getByRole('button', { name: '完成', exact: true }).click(); await page.waitForTimeout(500)
  const restored = await counts(); record('deckRestored', { restored, allTxt })
  assert(restored.normalSearch === 1 && restored.toolbar === 0 && restored.bulkSearch === 0, `完成应恢复原控件：${JSON.stringify(restored)}`)
  // Unit 选择态只一套
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/units`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  await page.locator('a.mm-row').first().click(); await page.waitForTimeout(800)
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(500)
  const unitSel = await counts(); record('unitSelect', unitSel)
  assert(unitSel.unitBulkSearch === 1 && unitSel.toolbar === 1 && unitSel.statusSelect === 1, `单元选择态应只一套 Bulk：${JSON.stringify(unitSel)}`)
  await page.screenshot({ path: join(OUT, '92-unit-bulk-only-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('unit360', layout)
  await page.screenshot({ path: join(OUT, '92-unit-bulk-only-360.png') }).catch(() => {})
  assert(!layout.overflow, '单元360不应溢出')
  // AI 预选计数：Deck 选无内容词
  await page.setViewportSize({ width: 390, height: 844 })
  const pick = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').getAll(); r.onsuccess = () => res(r.result) })
    const ids = new Set(states.map((s) => s.wordId))
    const w = words.find((x) => x.deckId === 'kaoyan-2027-dagang' && !ids.has(x.id) && !(x.examples?.length) && !(x.mnemonics?.length))
    return w ? { id: w.id, headword: w.headword } : null
  })
  record('aiPick', pick); assert(pick, '应有可生成词')
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(400)
  const bs = page.getByLabel('搜索词库单词').first(); await bs.fill(pick.headword); await page.waitForTimeout(900)
  await page.locator('.mm-list button.mm-row').first().click(); await page.waitForTimeout(300)
  await page.getByRole('button', { name: /AI 生成选中词（1）/ }).click(); await page.waitForTimeout(800)
  const aiText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const selectedLine = aiText.match(/已选 (\d+) \/ 共 (\d+)/)
  const target = aiText.match(/目标：(\d+) 个词\/含义/)?.[1] ?? null
  record('aiCount', { selectedLine: selectedLine?.[0] ?? '', selected: selectedLine?.[1], total: selectedLine?.[2], target })
  assert(selectedLine && Number(selectedLine[1]) === 1 && Number(selectedLine[2]) >= 1, `AI 预选计数应为 已选1/共≥1：${selectedLine?.[0]}`)
  assert(target != null && Number(target) > 0, `AI target 应>0：${target}`)
  await page.screenshot({ path: join(OUT, '93-ai-count-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t267] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t267] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '67-task267-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task267.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
