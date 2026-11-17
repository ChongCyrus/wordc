#!/usr/bin/env node
/** task-214：本义助记生成默认排除已标不常考本义；取消勾选包含 rare；全排除空态；批量候选。mock AI，不调真实 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[exclude] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
let requests = 0
await page.route('**/chat/completions', async (route) => {
  requests += 1
  await sleep(200)
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
  const checkbox = panel.getByRole('checkbox', { name: /排除已标记不常考的本义/ }).first()
  await checkbox.waitFor({ state: 'visible', timeout: 5000 })
  const defaultChecked = await checkbox.isChecked()
  record('defaultExcludeChecked', { checked: defaultChecked })
  assert(defaultChecked, '「排除已标记不常考的本义」应默认勾选')
  // 全排除空态：fixture denounce 唯一本义已标 rare
  await panel.getByRole('button', { name: 'AI 生成全部' }).click()
  await page.waitForFunction(() => /可生成本义为空|已排除不常考本义后无候选|全部已标记不常考/.test(document.body.innerText), null, { timeout: 8000 })
  const emptyText = (await panel.innerText()).match(/可生成本义为空[^\n]*|已排除不常考本义后无候选[^\n]*/)?.[0] ?? ''
  record('allExcludedEmpty', { emptyText, requests })
  assert(emptyText.length > 0, '全排除时应显示空态/提示')
  assert(requests === 0, `全排除时不应请求 AI，实际 ${requests}`)
  // 取消勾选 → 包含 rare，生成成功
  await checkbox.uncheck()
  await panel.getByRole('button', { name: 'AI 生成全部' }).click()
  await page.waitForFunction(() => /AI 已生成建议|AI 建议：/.test(document.body.innerText), null, { timeout: 10_000 })
  const included = await panel.innerText()
  record('includeRareGenerate', { requests, hasSuggestion: /AI 建议：|AI 已生成建议/.test(included) })
  assert(requests === 1, `取消勾选后应请求1次，实际 ${requests}`)
  assert(/AI 建议：|AI 已生成建议/.test(included), '取消勾选后应生成 rare 本义建议')
  // 批量候选
  await panel.getByRole('button', { name: /批量生成/ }).click()
  const batch = page.locator('[role="dialog"][aria-label="批量生成本义助记"]').first()
  await batch.waitFor({ state: 'visible', timeout: 10_000 })
  const batchCheckbox = batch.getByRole('checkbox', { name: /排除已标记不常考的本义/ }).first()
  const batchDefault = await batchCheckbox.isChecked()
  await page.waitForTimeout(400)
  const batchEmptyBefore = /已排除不常考本义后无候选|共 0 条本义候选/.test(await batch.innerText())
  record('batchDefaultExclude', { checked: batchDefault, emptyBefore: batchEmptyBefore, text: (await batch.innerText()).slice(-160) })
  assert(batchDefault, '批量面板排除勾选应默认开启')
  assert(batchEmptyBefore, '批量默认全排除应显示空态/0候选')
  await batchCheckbox.uncheck()
  await page.waitForTimeout(500)
  const batchAfter = await batch.innerText()
  record('batchIncludeRare', { text: batchAfter.slice(-200) })
  assert(/共 \d+ 条本义候选/.test(batchAfter), `取消勾选后批量应有候选：${batchAfter.slice(-160)}`)
  await page.screenshot({ path: join(OUT, '36-sense-exclude-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[exclude] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[exclude] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '93-exclude-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-sense-exclude.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
