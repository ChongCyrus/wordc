#!/usr/bin/env node
/** 0.3.84 task-249②：串联对象列表默认排除rare/全选反选取消/空选禁用/只传勾选/重开重置。mock AI。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t249] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const bodies = []
await page.route('**/chat/completions', async (route) => {
  bodies.push(route.request().postData() ?? '')
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mnemonic: 'T249单条', text: 'T249串联预览' }) } }] }) })
})
const openPanel = async () => {
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const p = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await p.waitFor({ state: 'visible', timeout: 10_000 })
  return p
}
const objState = async (p) => p.evaluate((panel) => {
  const box = panel.querySelector('.sense-overview-targets')
  if (!box) return null
  const rows = Array.from(box.querySelectorAll('.sense-target-row')).map((r) => ({ text: r.textContent?.replace(/\s+/g, ' ').trim() ?? '', checked: r.querySelector('input')?.checked ?? false }))
  return { text: box.textContent?.replace(/\s+/g, ' ').trim() ?? '', rows, selected: box.querySelector('.mm-caption')?.textContent ?? '', disabled: (() => { const b = Array.from(panel.querySelectorAll('button')).find((x) => /仅生成串联记忆/.test(x.textContent ?? '')); return b ? b.disabled : null })() }
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const now = Date.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['packs', 'packItems', 'words', 'settings'], 'readwrite')
      tx.objectStore('packs').put({ id: 'fixture-core2', name: 'fixture second core', kind: 'semantics', formatVersion: 1, checksum: 'fixturecore2', source: 'builtin', status: 'applied', deckId: 'kaoyan-2027-dagang', promptVersion: 'v4.0-semantics-grouped', counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 }, createdAt: now, updatedAt: now })
      tx.objectStore('packItems').put({ id: 'fixture-core2:1', packId: 'fixture-core2', seq: 1, wordId: 'kaoyan-2027-dagang:denounce', headwordLower: 'denounce', payload: { headword: 'denounce', coreSenses: [{ index: 1, label: 'fixture第二本义', note: '第二本义 gloss' }], meaningMap: [] }, status: 'applied', createdAt: now, appliedAt: now })
      const get = tx.objectStore('words').get('kaoyan-2027-dagang:denounce')
      get.onsuccess = () => { const w = get.result; if (w) tx.objectStore('words').put({ ...w, rareCoreSenses: [{ coreSenseIndex: 1, label: 'fixture旧本义', updatedAt: now }], rareMeaningIds: [] }) }
      for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat', 'memory.weightedCoreSenseOnly': false })) tx.objectStore('settings').put({ key, value, updatedAt: now })
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  let panel = await openPanel()
  const def = await objState(panel)
  record('defaultExcludeRare', def)
  assert(def && def.rows.length >= 2 && def.rows.some((r) => r.text.includes('fixture旧本义') && !r.checked) && def.rows.some((r) => r.text.includes('fixture第二本义') && r.checked), `默认应排除rare、勾选非rare：${JSON.stringify(def)}`)
  const buttonsInfo = async (width, tag) => {
    await page.setViewportSize({ width, height: 844 }); await page.waitForTimeout(300)
    const info = await panel.evaluate((panelEl) => Array.from(panelEl.querySelectorAll('.sense-overview-targets .mm-btn-row, .sense-targets .mm-btn-row')).map((row) => ({ rowWidth: Math.round(row.getBoundingClientRect().width), rowHeight: Math.round(row.getBoundingClientRect().height), pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, buttons: Array.from(row.querySelectorAll('button')).map((b) => ({ text: (b.textContent ?? '').trim(), width: Math.round(b.getBoundingClientRect().width), height: Math.round(b.getBoundingClientRect().height), nowrap: getComputedStyle(b).whiteSpace })) })))
    record(`targetButtons${tag}${width}`, info)
    await page.screenshot({ path: join(OUT, `72-overview-target-buttons-${width}.png`) }).catch(() => {})
    for (const row of info) {
      assert(row.pageOverflow === false && row.buttons.length === 3 && row.buttons.every((b) => b.nowrap === 'nowrap' && b.height <= 40 && b.width > 0), `${width} [全选/反选/取消全选] 应一行不换行不溢出：${JSON.stringify(row)}`)
    }
  }
  await buttonsInfo(390, '390'); await buttonsInfo(360, '360'); await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  // 全选/取消/反选
  await panel.locator('.sense-overview-targets').getByRole('button', { name: '全选', exact: true }).click()
  const all = await objState(panel); record('all', all)
  assert(all.rows.every((r) => r.checked), `全选应全勾：${JSON.stringify(all)}`)
  await panel.locator('.sense-overview-targets').getByRole('button', { name: '取消全选', exact: true }).click()
  const none = await objState(panel); record('none', none)
  assert(none.rows.every((r) => !r.checked) && none.disabled === true, `取消全选应空选且禁用：${JSON.stringify(none)}`)
  await panel.locator('.sense-overview-targets').getByRole('button', { name: '反选', exact: true }).click()
  const inv = await objState(panel); record('inverse', inv)
  assert(inv.rows.every((r) => r.checked), `反选应全勾：${JSON.stringify(inv)}`)
  // 只勾选 core2 生成 overview，请求只传勾选 label
  await panel.locator('.sense-overview-targets').getByRole('button', { name: '取消全选', exact: true }).click()
  const core2Row = panel.locator('.sense-overview-targets .sense-target-row').filter({ hasText: 'fixture第二本义' }).first()
  await core2Row.locator('input').check()
  const before = bodies.length
  await panel.getByRole('button', { name: /仅生成串联记忆/ }).click()
  await page.waitForFunction(() => { const t = document.querySelector('textarea[aria-label="本义串联记忆"]'); return Boolean(t && t.value.includes('T249串联预览')) }, null, { timeout: 10_000 })
  const reqBody = bodies.slice(before).join('\n')
  record('overviewRequest', { count: bodies.length - before, includesSecond: reqBody.includes('fixture第二本义'), includesRare: reqBody.includes('fixture旧本义') })
  assert(bodies.length - before === 1 && reqBody.includes('fixture第二本义') && !reqBody.includes('fixture旧本义'), `overview 只应传勾选本义：${JSON.stringify({ count: bodies.length - before, includesSecond: reqBody.includes('fixture第二本义'), includesRare: reqBody.includes('fixture旧本义') })}`)
  await page.screenshot({ path: join(OUT, '71-overview-targets-390.png') }).catch(() => {})
  await panel.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.waitForTimeout(400)
  // 重开重置默认（rare 仍排除，core2 勾选）
  panel = await openPanel()
  const reopen = await objState(panel)
  record('reopenReset', reopen)
  assert(reopen.rows.some((r) => r.text.includes('fixture旧本义') && !r.checked) && reopen.rows.some((r) => r.text.includes('fixture第二本义') && r.checked), `重开应重置默认：${JSON.stringify(reopen)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t249] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t249] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '80-t249-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-t249.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
