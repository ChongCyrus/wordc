#!/usr/bin/env node
/** 0.3.67 本义助记控制面：并发2–4/逐项状态/取消立即/整行点击编辑/loading回填（mock AI，不调真实 API）。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { fixture: FIXTURE || '', checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[sense] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
let requests = 0
await page.route('**/chat/completions', async (route) => {
  requests += 1
  await sleep(900)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{"mnemonic":"AI本义助记候选"}' } }] }) })
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat' })) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const panel = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  const rows = panel.locator('.sense-mnemonic-row--clickable')
  let rowCount = 0
  for (let i = 0; i < 40; i += 1) {
    rowCount = await rows.count()
    if (rowCount > 0) break
    await page.waitForTimeout(250)
  }
  const concurrency = panel.getByLabel('本义助记生成并发')
  const panelText = await panel.innerText(); record('open', { rowCount, concurrencyControl: await concurrency.count(), loadingText: /正在加载本义助记/.test(panelText), panelText: panelText.slice(0,300) })
  await page.screenshot({ path: join(OUT, '31-sense-panel-390.png') }).catch(() => {})
  const layout390 = await page.evaluate(() => {
    const d = document.querySelector('.mm-dialog')
    const r = d?.getBoundingClientRect()
    return { width: r ? Math.round(r.width) : 0, viewport: innerWidth, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, dialogOverflow: d ? d.scrollWidth > d.clientWidth + 1 : true, rows: document.querySelectorAll('.sense-mnemonic-row--clickable').length }
  })
  record('senseLayout390', layout390)
  assert(!layout390.pageOverflow && !layout390.dialogOverflow, `本义助记面板不应横向溢出：${JSON.stringify(layout390)}`)
  const dbg = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const items = await new Promise((res) => { const r = db.transaction('packItems', 'readonly').objectStore('packItems').index('wordId').getAll('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
    const packs = await new Promise((res) => { const r = db.transaction('packs', 'readonly').objectStore('packs').getAll(); r.onsuccess = () => res(r.result.filter((p) => p.id === 'fixture-old-v3-semantics')) })
    return { packItems: items.map((i) => ({ packId: i.packId, wordId: i.wordId, status: i.status, coreSenses: i.payload?.coreSenses })), packs: packs.map((p) => ({ id: p.id, kind: p.kind, status: p.status })) }
  })
  record('fixturePackDbg', dbg)
  assert(rowCount > 0, '应有本义行')
  assert((await concurrency.count()) > 0, '应有并发控件（2–4）')
  // 生成全部 → 逐项运行态 → 取消立即恢复
  await panel.getByRole('button', { name: 'AI 生成全部' }).click()
  await page.waitForTimeout(250)
  const during = await panel.innerText()
  const genState = { hasProgress: /生成中 0 \/|生成中 1 \/|生成中 \d+ \/ \d+/.test(during), hasRowRunning: /生成中…/.test(during) }
  const tCancel = Date.now()
  await panel.getByRole('button', { name: '取消生成' }).click()
  const startBtn = panel.getByRole('button', { name: 'AI 生成全部' }).first()
  await startBtn.waitFor({ state: 'visible', timeout: 2000 })
  const cancelMs = Date.now() - tCancel
  record('afterCancelText', (await panel.innerText()).slice(-260))
  record('generateCancel', { ...genState, cancelMs, requests })
  assert(genState.hasProgress || genState.hasRowRunning, '生成时应显示逐项/总进度')
  assert(cancelMs < 2000, `取消应立即恢复，实际 ${cancelMs}ms`)
  // 重新生成，等待逐项成功 → 整行点开编辑 → 保存 → 重开回填
  await startBtn.click()
  await page.waitForTimeout(600)
  record('afterSecondStart', { requests, text: (await panel.innerText()).slice(-260) })
  await page.waitForFunction(() => /AI 已生成建议|AI 建议：/.test(document.body.innerText), null, { timeout: 10_000 })
  await page.waitForTimeout(300)
  const suggestionText = await panel.innerText()
  record('generateAll', { hasSuggestion: /AI 建议：/.test(suggestionText), hasRowOk: /AI 已生成建议/.test(suggestionText), requests })
  await rows.first().click()
  const editor = page.locator('.mm-dialog').filter({ hasText: '本义助记 · 本义1' }).last()
  await editor.waitFor({ state: 'visible', timeout: 10_000 })
  await page.screenshot({ path: join(OUT, '32-sense-editor-390.png') }).catch(() => {})
  const input = editor.getByLabel('本义助记内容')
  const prefilled = await input.inputValue()
  record('rowClickEditor', { prefilled })
  assert(prefilled.includes('AI本义助记候选'), `整行点击应回填 AI 候选，实际 ${prefilled}`)
  await input.fill('手改本义助记')
  await editor.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(700)
  await panel.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.waitForTimeout(300)
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const panel2 = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await panel2.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  const reloaded = await panel2.innerText()
  record('loadingBackfill', { hasManual: /手改本义助记/.test(reloaded) })
  assert(/手改本义助记/.test(reloaded), '重开后应回填已保存本义助记')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[sense] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[sense] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '96-sense-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-sense-gate.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
