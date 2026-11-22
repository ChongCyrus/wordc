#!/usr/bin/env node
/** 0.3.99 批量不常考：4 词 mock AI 全 0 rare → 应用 checkedAt → 仅未检查候选0。不调真实 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t299] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
await page.route('**/chat/completions', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: '{"rareMeaningIndexes":[],"rareCoreSenseIndexes":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) })
})
const setAi = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = [
    ['ai.enabled', true], ['ai.provider', 'openai-compatible'], ['ai.baseUrl', 'https://api.deepseek.com'],
    ['ai.model', 'deepseek-chat'], ['ai.apiKey', 'sk-TEST'], ['ai.keyStorage', 'persistent'], ['ai.transport', 'auto'],
    ['ai.jsonMode', true], ['ai.maxCostPerRun', 3], ['study.markRareCoreSenses', true],
  ]
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of rows) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await setAi()
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '选择', exact: true }).click(); await page.waitForTimeout(400)
  const rows = page.locator('.mm-list button.mm-row'); for (let i = 0; i < 4; i += 1) await rows.nth(i).click()
  await page.getByRole('button', { name: /AI 生成选中词（4）/ }).click(); await page.waitForTimeout(900)
  await page.getByRole('button', { name: /批量标记「不常考」含义/ }).click(); await page.waitForTimeout(900)
  const panel = page.getByRole('dialog', { name: '批量标记不常考含义' }).first()
  const caption = (await panel.innerText()).replace(/\s+/g, ' ')
  record('before', { line: caption.match(/筛选后 \d+ 词[^；]*/)?.[0] ?? '' })
  const start = panel.getByRole('button', { name: /开始批量标记/ })
  await start.click({ force: true }); const confirm = page.getByRole('dialog', { name: '确认批量标记' }).first()
  await confirm.waitFor({ state: 'visible', timeout: 5000 })
  await page.evaluate(() => { const d = Array.from(document.querySelectorAll('[role="dialog"]')).find((x) => x.innerText.includes('确认批量标记')); const b = d ? Array.from(d.querySelectorAll('button')).find((x) => (x.textContent ?? '').includes('确认开始')) : null; b?.click() })
  await page.waitForFunction(() => /本批已检查 \d+ 词/.test(document.body.innerText), null, { timeout: 30_000 }).catch(async () => {
    const dbg = await page.evaluate(() => ({ text: document.body.innerText.replace(/\s+/g, ' ').slice(-300), buttons: Array.from(document.querySelectorAll('[aria-label="批量标记不常考含义"] button')).map((b) => ({ t: (b.textContent ?? '').trim(), d: b.disabled })) }))
    record('runTimeout', dbg)
    throw new Error('no preview')
  })
  const afterRun = (await panel.innerText()).replace(/\s+/g, ' ')
  const summary = afterRun.match(/本批已检查 \d+ 词[^；]*/)?.[0] ?? ''
  const apply = panel.getByRole('button', { name: /标记本批 \d+ 词为已检查/ }).first()
  record('afterRun', { summary, apply: await apply.count() })
  assert(/本批已检查 4 词/.test(summary), `应4词全成功：${summary}`)
  await page.screenshot({ path: join(OUT, '121-rare-batch-preview-390.png') }).catch(() => {})
  await apply.click({ force: true }); await page.waitForTimeout(2000)
  const checked = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const ids = ['embrace','embed','embody','embryo'].map((x) => `kaoyan-2027-dagang:${x}`)
    return ids.map((id) => { const w = words.find((x) => x.id === id); return { id, checkedAt: w?.rareMarkCheckedAt ?? null, version: w?.rareMarkVersion ?? null, rareIds: w?.rareMeaningIds ?? null } })
  })
  record('checkedAt', checked)
  assert(checked.every((x) => x.checkedAt != null), `应用后应写 checkedAt：${JSON.stringify(checked)}`)
  await page.screenshot({ path: join(OUT, '122-rare-batch-applied-390.png') }).catch(() => {})
  // 再开，仅未检查候选0
  await panel.getByRole('button', { name: '关闭' }).click().catch(() => {}); await page.waitForTimeout(400)
  await page.getByRole('button', { name: /批量标记「不常考」含义/ }).click(); await page.waitForTimeout(900)
  const panel2 = page.getByRole('dialog', { name: '批量标记不常考含义' }).first()
  await page.waitForTimeout(2000)
  const line2 = (await panel2.innerText()).replace(/\s+/g, ' ').match(/筛选后 \d+ 词[^；]*/)?.[0] ?? ''
  record('reopen', { line2 })
  assert(/筛选后 0 词/.test(line2), `应用后仅未检查应0：${line2}`)
  await page.screenshot({ path: join(OUT, '123-rare-batch-reopen-360.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t299] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t299] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '54-task299-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task299.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
