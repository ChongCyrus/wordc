#!/usr/bin/env node
/** 0.3.79 task-237/238：目标复选框只串联/只单条、空选禁用；注释面串联编辑 dialog 保存/清空/重新生成/取消+双页同步。mock AI。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t238] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
let requests = 0
await page.route('**/chat/completions', async (route) => {
  requests += 1
  await sleep(100)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ mnemonic: 'T238单条助记', text: 'T238串联生成文本' }) } }] }) })
})
const exitMemory = async () => {
  await page.getByRole('button', { name: '退出记忆' }).first().click()
  const dlg = page.getByRole('dialog', { name: /退出记忆/ }).first()
  if (await dlg.count()) await dlg.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
  await page.waitForTimeout(600)
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    if (w) await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rareCoreSenses: [], rareMeaningIds: [], coreSenseOverview: { text: 'T238原有串联', source: 'manual', updatedAt: Date.now() } }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat', 'memory.weightedCoreSenseOnly': true })) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const panel = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  const targetState = async () => ({
    text: (await panel.innerText()).match(/已选 \d+ 项/)?.[0] ?? '',
    checked: await panel.locator('.sense-target-row input[type="checkbox"]').evaluateAll((els) => els.map((e) => e.checked)),
    disabled: await panel.getByRole('button', { name: 'AI 生成所选' }).isDisabled(),
  })
  const def = await targetState()
  record('targetsDefault', def)
  assert(def.checked[0] === true, `默认应包含串联：${JSON.stringify(def)}`)
  await panel.getByRole('button', { name: '全选', exact: true }).click()
  const all = await targetState(); record('targetsAll', all)
  assert(all.checked.every(Boolean) && /已选 2 项/.test(all.text), `全选应全部选中：${JSON.stringify(all)}`)
  await panel.getByRole('button', { name: '取消全选', exact: true }).click()
  const none = await targetState(); record('targetsNone', none)
  assert(none.checked.every((x) => !x) && none.disabled, `取消全选应0项且禁用生成：${JSON.stringify(none)}`)
  await panel.getByRole('button', { name: '反选', exact: true }).click()
  const inv = await targetState(); record('targetsInverse', inv)
  assert(inv.checked.every(Boolean), `反选应全选：${JSON.stringify(inv)}`)
  // 只选串联
  await panel.getByRole('button', { name: '取消全选', exact: true }).click()
  await panel.locator('.sense-target-row').first().locator('input').check()
  const beforeReq = requests
  await panel.getByRole('button', { name: 'AI 生成所选' }).click()
  await page.waitForFunction(() => { const t = document.querySelector('textarea[aria-label="本义串联记忆"]'); return Boolean(t && t.value.includes('T238串联生成文本')) }, null, { timeout: 10_000 })
  const onlyOverviewText = (await panel.innerText()).replace(/\s+/g, ' ')
  record('onlyOverview', { req: requests - beforeReq, hasMnemonicSuggestion: /AI 建议：T238单条助记/.test(onlyOverviewText) })
  assert(requests - beforeReq === 1 && !/AI 建议：T238单条助记/.test(onlyOverviewText), '只选串联应只请求 overview')
  await panel.getByRole('button', { name: '保存串联记忆' }).click()
  await page.waitForTimeout(800)
  await panel.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.waitForTimeout(500)
  const overviewSaved = (await page.locator('.core-sense-overview-text').first().innerText()).trim()
  record('overviewSaved', { overviewSaved })
  assert(/T238串联生成文本/.test(overviewSaved), '保存后注释面应更新')
  // 只选单条：不覆盖已保存 overview
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const panel2 = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await panel2.waitFor({ state: 'visible', timeout: 10_000 })
  await panel2.getByRole('button', { name: '取消全选', exact: true }).click()
  await panel2.locator('.sense-target-row').nth(1).locator('input').check()
  const req2 = requests
  await panel2.getByRole('button', { name: 'AI 生成所选' }).click()
  await page.waitForFunction(() => /AI 建议：T238单条助记/.test(document.body.innerText), null, { timeout: 10_000 })
  const overviewNow = await panel2.locator('textarea[aria-label="本义串联记忆"]').inputValue().catch(() => '')
  record('onlySense', { req: requests - req2, overviewNow })
  assert(requests - req2 === 1 && overviewNow.includes('T238串联生成文本'), '只选单条不应重生成/覆盖已有串联')
  await panel2.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.waitForTimeout(500)
  assert(/T238串联生成文本/.test((await page.locator('.core-sense-overview-text').first().innerText())), '单条生成后注释面串联不应变')
  // B：点击串联段落 → 编辑 dialog
  await page.locator('.core-sense-overview').first().click()
  const edit = page.locator('[data-testid="core-overview-edit-dialog"]')
  await edit.waitFor({ state: 'visible', timeout: 5000 })
  const editText = (await edit.innerText()).replace(/\s+/g, ' ')
  record('overviewEdit', { text: editText.slice(0, 180), hasSave: /保存/.test(editText), hasClear: /清空/.test(editText), hasRegen: /AI 重新生成/.test(editText), hasCancel: /取消/.test(editText) })
  assert(/保存/.test(editText) && /清空/.test(editText) && /AI 重新生成/.test(editText) && /取消/.test(editText), '编辑窗应有保存/清空/重新生成/取消')
  await page.screenshot({ path: join(OUT, '61-core-overview-edit-390.png') }).catch(() => {})
  const ta = edit.getByLabel('本义串联记忆内容')
  await ta.fill('T238编辑后串联')
  await edit.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(900)
  const saved2 = (await page.locator('.core-sense-overview-text').first().innerText()).trim()
  record('overviewEdited', { saved2 })
  assert(/T238编辑后串联/.test(saved2), '编辑保存后注释面应更新')
  // 只记本义页同步
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(400)
  const memoryOverview = (await page.locator('.wc-core-sense-overview').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
  record('memoryOverview', { text: memoryOverview })
  assert(/T238编辑后串联/.test(memoryOverview), '只记本义页应同步编辑后串联')
  await page.screenshot({ path: join(OUT, '62-core-overview-sync-390.png') }).catch(() => {})
  await exitMemory()
  // Enter 打开 + 清空
  await page.locator('.core-sense-overview').first().focus().catch(() => {})
  await page.keyboard.press('Enter')
  await edit.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  const enterOpened = await edit.isVisible().catch(() => false)
  record('overviewEnter', { enterOpened })
  if (enterOpened) {
    await edit.getByRole('button', { name: '清空' }).click()
    await page.waitForTimeout(800)
    const cleared = await page.locator('.core-sense-overview').count()
    record('overviewCleared', { cleared })
    assert(cleared === 0, '清空后注释面不应再显示串联')
  }
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t238] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t238] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '84-task238-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task238.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
