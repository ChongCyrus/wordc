#!/usr/bin/env node
/**
 * task-177 补充边界（0.3.61）：轻量导出真实下载、完整备份确认流（不真导大包）、
 * 批量不常考面板可见 + 范围切换（当前词/今日/词库≤200）。
 * 运行：QA_FIXTURE=... QA_BASE=http://127.0.0.1:4173/ node tests/e2e/qa-boundary-gate.mjs
 */
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation,
  openPanelByButton, panelInfo, closePanel, sleep, watchErrors, assert,
} from './qa-gate-lib.mjs'

const started = Date.now()
const result = { fixture: FIXTURE || '(fresh)', checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[boundary] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
await page.route('**/chat/completions', (route) =>
  route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: '{"mnemonics":[{"text":"AI候选映射助记"}]}' } }] }),
  }),
)
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)

  // 轻量导出：真实下载文件
  await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' })
  await page.getByText('导出学习进度', { exact: true }).waitFor({ state: 'visible', timeout: 30_000 })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByText('导出学习进度', { exact: true }).click(),
  ])
  const dlPath = join('/tmp', `qa-light-export-${download.suggestedFilename()}`)
  await download.saveAs(dlPath)
  const dlSize = (await stat(dlPath)).size
  record('lightExport', { filename: download.suggestedFilename(), size: dlSize, path: dlPath })
  assert(dlSize > 100, `轻量导出文件应非空，实际 ${dlSize}B`)

  // 完整备份确认流：打开确认弹窗，不真导大包
  await page.getByText('完整备份（含引申图/内容包，体积大）', { exact: true }).click()
  const dlg = page.locator('.mm-dialog').filter({ hasText: '完整备份包含全量引申图与内容包' }).first()
  await dlg.waitFor({ state: 'visible', timeout: 10_000 })
  const dlgText = (await dlg.innerText()).replace(/\s+/g, ' ').slice(0, 200)
  record('completeBackupConfirm', { visible: await dlg.isVisible(), text: dlgText })
  const cancel = dlg.getByRole('button', { name: /取消|关闭/ }).first()
  assert(await cancel.count(), '完整备份确认弹窗应有取消按钮')
  await cancel.click()
  await page.waitForTimeout(300)
  assert((await dlg.isVisible().catch(() => false)) === false, '完整备份确认弹窗应可取消关闭')

  // task-198：完整备份超限立即取消并提示，不生成文件、不崩溃
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    const w = words.find((x) => String(x.headword).toLowerCase() === 'denounce') ?? words[0]
    if (!w) throw new Error('no word')
    await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, derivationMap: { rootLabel: 'x', text: 'x'.repeat(21 * 1024 * 1024), mermaid: '', source: 'manual', updatedAt: Date.now() } }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  let downloads = 0
  page.on('download', () => { downloads += 1 })
  await page.getByText('完整备份（含引申图/内容包，体积大）', { exact: true }).click()
  const dlg2 = page.locator('.mm-dialog').filter({ hasText: '完整备份包含全量引申图与内容包' }).first()
  await dlg2.waitFor({ state: 'visible', timeout: 10_000 })
  const tLimit = Date.now()
  await dlg2.getByRole('button', { name: '仍要完整备份' }).click()
  await page.waitForFunction(() => /超过安全上限|已取消导出|不会生成文件/.test(document.body.innerText), null, { timeout: 5000 })
  const limitMs = Date.now() - tLimit
  const limitText = (await page.locator('body').innerText()).match(/迁移包预计[^\n]*/)?.[0] ?? ''
  record('completeBackupOverLimit', { limitMs, downloads, text: limitText.slice(0, 180) })
  assert(limitMs < 5000, `超限应快速取消，实际 ${limitMs}ms`)
  assert(downloads === 0, `超限不应生成文件，实际 downloads=${downloads}`)

  // 超限数据存在时轻量导出仍成功
  const [download2] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    page.getByText('导出学习进度', { exact: true }).click(),
  ])
  const dl2 = join('/tmp', `qa-light-after-big-${download2.suggestedFilename()}`)
  await download2.saveAs(dl2)
  const dl2Size = (await stat(dl2)).size
  record('lightExportAfterBig', { filename: download2.suggestedFilename(), size: dl2Size })
  assert(dl2Size > 100, '超限数据下轻量导出仍应非空')

  // 批量不常考面板：从学习页 AI 面板进入
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  // 注释面 AI 本义助记：入口/空态/保存（不调 AI）
  const rootBtn = page.getByRole('button', { name: 'AI助记·生成元映射' }).first()
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat' })) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await rootBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await rootBtn.click()
  const rootDlg = page.locator('.mm-dialog').filter({ hasText: '生成元映射助记' }).first()
  await rootDlg.waitFor({ state: 'visible', timeout: 10_000 })
  const textarea = rootDlg.getByLabel('生成元映射助记')
  const emptyText = await textarea.inputValue()
  record('rootMnemonicEntry', { visible: await rootDlg.isVisible(), emptyText })
  assert(emptyText === '', `新词本义助记应为空态，实际 ${JSON.stringify(emptyText)}`)
  await textarea.fill('QA手改助记未被覆盖')
  await rootDlg.getByRole('button', { name: 'AI 生成助记' }).click()
  const candidate = rootDlg.getByRole('button', { name: 'AI候选映射助记' }).first()
  await candidate.waitFor({ state: 'visible', timeout: 10_000 })
  const beforeCandidate = await textarea.inputValue()
  record('rootMnemonicAiPreview', { candidates: 1, manualPreserved: beforeCandidate })
  assert(beforeCandidate === 'QA手改助记未被覆盖', `AI 预览前不应覆盖手改内容，实际 ${beforeCandidate}`)
  await candidate.click()
  const afterCandidate = await textarea.inputValue()
  assert(afterCandidate === 'AI候选映射助记', `点候选应填入，实际 ${afterCandidate}`)
  await textarea.fill('QA保存本义助记')
  await rootDlg.getByRole('button', { name: '保存' }).click()
  await page.waitForTimeout(600)
  const savedMnemonic = await page.locator('.annotation-root-mnemonic').first().innerText().catch(() => '')
  record('rootMnemonicSaved', { savedMnemonic })
  assert(savedMnemonic.includes('QA保存本义助记'), `保存后注释面应显示本义助记，实际 ${savedMnemonic}`)
  const rootClose = rootDlg.getByRole('button', { name: /取消|关闭/ }).first()
  if (await rootClose.count()) await rootClose.click().catch(() => {})
  await page.locator('.mm-dialog').filter({ hasText: '生成元映射助记' }).first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(300)

  await page.getByRole('button', { name: '更多' }).first().click()
  await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).click()
  await page.locator('.mm-dialog').first().waitFor({ state: 'visible', timeout: 10_000 })
  const batchBtn = page.getByRole('button', { name: '批量标记「不常考」含义' }).first()
  await batchBtn.waitFor({ state: 'visible', timeout: 10_000 })
  await batchBtn.click()
  const batch = page.locator('[role="dialog"][aria-label="批量标记不常考含义"]').first()
  await batch.waitFor({ state: 'visible', timeout: 10_000 })
  const opts = await batch.getByRole('button', { name: /当前词|今日计划|今日单词|当前词库/ }).allInnerTexts().catch(() => [])
  record('rareBatchPanel', { visible: await batch.isVisible(), scopeOptions: opts })
  assert(await batch.isVisible(), '批量不常考面板应可见')
  assert(opts.length >= 3, `批量范围应有当前词/今日/词库，实际 ${JSON.stringify(opts)}`)
  const today = batch.getByRole('button', { name: /今日计划|今日单词/ }).first()
  if (await today.count()) { await today.click(); await page.waitForTimeout(200) }
  record('rareBatchScopeSwitch', { clickedToday: await today.count() > 0 })
  const closeBatch = batch.getByRole('button', { name: /关闭|取消|退出/ }).first()
  if (await closeBatch.count()) await closeBatch.click().catch(() => {})

  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[boundary] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[boundary] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '98-boundary-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-boundary-gate.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
