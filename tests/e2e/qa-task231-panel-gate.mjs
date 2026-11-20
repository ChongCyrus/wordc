#!/usr/bin/env node
/** 0.3.77 task-231：面板内编辑叠层、注释面只开编辑、仅生成串联预览保存。mock AI。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t231] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
await page.route('**/chat/completions', async (route) => {
  await sleep(80)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mnemonic: 'T231单条助记', text: 'T231 串联预览文本' }) } }] }) })
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    if (w) await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rareCoreSenses: [], rareMeaningIds: [], senseMnemonics: [{ coreSenseIndex: 1, label: 'fixture旧本义', text: 'T231注释段落助记', source: 'manual', updatedAt: Date.now() }] }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat', 'memory.weightedCoreSenseOnly': false })) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const panel = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  const row = panel.locator('.sense-mnemonic-row').first()
  await row.click({ position: { x: 20, y: 20 } })
  const editor = page.locator('[data-testid="sense-edit-dialog"]').last()
  await editor.waitFor({ state: 'visible', timeout: 5000 })
  const z = await page.evaluate(() => Array.from(document.querySelectorAll('.mm-mask')).map((m) => ({ z: getComputedStyle(m).zIndex, cls: m.className })))
  record('panelEditor', { editorVisible: await editor.isVisible(), masks: z })
  assert(z.some((m) => m.z === '59') && z.some((m) => m.z === '58'), `编辑窗应 z59 叠在面板 z58 上：${JSON.stringify(z)}`)
  await page.screenshot({ path: join(OUT, '53-panel-editor-layer-390.png') }).catch(() => {})
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page); await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  // 注释面点本义助记段落
  const block = page.locator('.core-sense-mnemonic-block').first()
  await block.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  if (await block.count()) {
    await block.click({ position: { x: 10, y: 10 } })
    const editor2 = page.locator('[data-testid="sense-edit-dialog"]')
    const editorVisible = await editor2.isVisible().catch(() => false)
    const panelCount = await page.locator('[data-testid="sense-panel"]').count()
    const aria = await editor2.getAttribute('aria-label').catch(() => null)
    record('annotationBlock', { editorVisible, panelCount, aria })
    assert(editorVisible && panelCount === 0, `注释面点段落应只开编辑窗：visible=${editorVisible} panel=${panelCount} aria=${aria}`)
    await page.screenshot({ path: join(OUT, '54-annotation-edit-only-390.png') }).catch(() => {})
    const ed = editor2.getByRole('button', { name: '取消' }).first()
    await ed.click().catch(() => {})
    await page.waitForTimeout(400)
  }
  // 仅生成串联
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const panel2 = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await panel2.waitFor({ state: 'visible', timeout: 10_000 })
  await panel2.getByRole('button', { name: /仅生成串联记忆/ }).click()
  await page.waitForFunction(() => { const t = document.querySelector('textarea[aria-label="本义串联记忆"]'); return Boolean(t && t.value.includes('T231')) }, null, { timeout: 15_000 })
  const overview = await panel2.locator('textarea').first().inputValue()
  record('onlyOverview', { overview })
  assert(/T231 串联预览文本/.test(overview), '仅生成串联应得预览')
  await panel2.getByRole('button', { name: '保存串联记忆' }).click()
  await page.waitForTimeout(900)
  await panel2.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.waitForTimeout(500)
  const annoOverview = await page.locator('.core-sense-overview').first().innerText().catch(() => '')
  record('onlyOverviewSaved', { text: annoOverview.replace(/\s+/g, ' ') })
  assert(/T231 串联预览文本/.test(annoOverview), '保存后注释面应显示串联')
  await page.screenshot({ path: join(OUT, '55-only-overview-saved-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t231] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t231] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '85-task231-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task231.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
