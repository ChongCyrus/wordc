#!/usr/bin/env node
/** 0.3.76 task-228：本义助记导出/导入（范围/统计/JSON/预览/合并/覆盖确认/错误不清空/390）。不调 API。 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[coreio] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
let exportFile = ''
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000).catch(() => {})
  await page.waitForTimeout(800)
  // 导出弹层
  await page.getByText('导出本义助记', { exact: true }).first().click()
  const exportDlg = page.getByRole('dialog', { name: '导出本义助记' }).first()
  await exportDlg.waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForTimeout(2000)
  const dbg = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const count = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').count(); r.onsuccess = () => res(r.result) }); return { words: count, text: document.body.innerText.replace(/\s+/g, ' ').slice(-200) } })
  record('exportDebug', dbg)
  await page.waitForFunction(() => /词数 \d+/.test(document.body.innerText), null, { timeout: 90000 })
  const scope = await exportDlg.evaluate((d) => ({
    allDisabled: Array.from(d.querySelectorAll('button')).find((b) => /全部词库/.test(b.textContent ?? ''))?.disabled,
    deckDisabled: Array.from(d.querySelectorAll('button')).find((b) => /当前词库/.test(b.textContent ?? ''))?.disabled,
    stats: (d.textContent ?? '').match(/词数 \d+ · 本义 \d+ · 已有助记 \d+ · 待生成 \d+/)?.[0] ?? '',
  }))
  record('exportScope', scope)
  const wordsAll = Number(scope.stats.match(/词数 (\d+)/)?.[1] ?? -1)
  assert(scope.stats.length > 0 && wordsAll > 0, `导出全部统计词数应>0（无overview候选本义场景）：${scope.stats}`)
  await exportDlg.getByRole('button', { name: '当前词库' }).click()
  await page.waitForTimeout(500)
  await page.waitForFunction(() => /词数 \d+ · 本义 \d+ · 已有助记 \d+ · 待生成 \d+/.test(document.body.innerText), null, { timeout: 90000 })
  const deckStats = (await exportDlg.innerText()).match(/词数 \d+ · 本义 \d+ · 已有助记 \d+ · 待生成 \d+/)?.[0] ?? ''
  const wordsDeck = Number(deckStats.match(/词数 (\d+)/)?.[1] ?? -1)
  record('exportScopeDeck', { stats: deckStats, words: wordsDeck })
  assert(deckStats.length > 0 && wordsDeck > 0, `当前词库导出统计词数应>0：${deckStats}`)
  await exportDlg.getByRole('button', { name: '全部词库' }).click()
  await page.waitForFunction(() => /词数 \d+ · 本义 \d+/.test(document.body.innerText), null, { timeout: 90000 })
  await page.waitForFunction(() => { const b = Array.from(document.querySelectorAll('button')).find((x) => /导出 JSON/.test(x.textContent ?? '')); return !!b && !b.disabled }, null, { timeout: 90000 })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60_000 }),
    exportDlg.getByRole('button', { name: '导出 JSON' }).click(),
  ])
  exportFile = join(OUT, 'core-sense-mnemonics-export.json')
  await download.saveAs(exportFile)
  const exported = JSON.parse(await readFile(exportFile, 'utf8'))
  record('exportJson', { fileName: download.suggestedFilename(), bytes: (await readFile(exportFile)).length, keys: Object.keys(exported), senses: Array.isArray(exported.senses) ? exported.senses.length : null, words: Array.isArray(exported.words) ? exported.words.length : null })
  assert(Array.isArray(exported.senses) && exported.senses.length > 0, '导出 JSON 应含 senses')
  // 导入：选文件 → 预览
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.getByText('导入本义助记', { exact: true }).first().click()])
  await chooser.setFiles(exportFile)
  const importDlg = page.getByRole('dialog', { name: '导入本义助记' }).first()
  await importDlg.waitFor({ state: 'visible', timeout: 8000 })
  const previewText = (await importDlg.innerText()).replace(/\s+/g, ' ')
  record('importPreview', { text: previewText.slice(0, 260), mergeButton: /确认导入（合并）/.test(previewText) })
  assert(/默认合并/.test(previewText) && /stale \d+ 条/.test(previewText), `导入预览应含 counts/stale/跳过：${previewText.slice(0, 200)}`)
  // 默认合并应用
  await importDlg.getByRole('button', { name: '确认导入（合并）' }).click()
  const resultDlg = page.getByRole('dialog', { name: '导入结果' }).first()
  await resultDlg.waitFor({ state: 'visible', timeout: 10_000 })
  const doneText = (await resultDlg.innerText()).replace(/\s+/g, ' ')
  record('mergeResult', { text: doneText.slice(0, 260) })
  assert(/本义助记 \d+ 条/.test(doneText), `合并后应有结果报告：${doneText.slice(0, 200)}`)
  await page.screenshot({ path: join(OUT, '50-core-io-import-result-390.png') }).catch(() => {})
  await resultDlg.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.waitForTimeout(400)
  // 覆盖策略：未勾选二次确认时应用按钮 disabled
  const [chooser2] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.getByText('导入本义助记', { exact: true }).first().click()])
  await chooser2.setFiles(exportFile)
  const dlg2 = page.getByRole('dialog', { name: '导入本义助记' }).first()
  await dlg2.waitFor({ state: 'visible', timeout: 8000 })
  await dlg2.getByText('覆盖（会覆盖已有 AI/手动助记）').click()
  const applyBtn = dlg2.getByRole('button', { name: /确认覆盖导入/ }).first()
  const disabledBefore = await applyBtn.isDisabled()
  record('overwriteGuard', { disabledBefore })
  assert(disabledBefore, '覆盖策略未二次确认时按钮应禁用')
  // 错误文件：格式错误 → toast，已有数据不清空
  await dlg2.getByRole('button', { name: '取消' }).click().catch(() => {})
  const bad = join(OUT, 'bad-core-import.json')
  await writeFile(bad, '{"schema": "not-core", "foo": 1}')
  const [chooser3] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.getByText('导入本义助记', { exact: true }).first().click()])
  await chooser3.setFiles(bad)
  await page.waitForTimeout(800)
  const errText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('badFile', { hasError: /校验失败|格式|版本|导入失败|错误/.test(errText) })
  assert(/校验失败|格式|版本|导入失败|错误/.test(errText), '坏文件应有错误提示')
  // 再打开正常导入确认已有数据仍在
  const [chooser4] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), page.getByText('导入本义助记', { exact: true }).first().click()])
  await chooser4.setFiles(exportFile)
  const dlg3 = page.getByRole('dialog', { name: '导入本义助记' }).first()
  await dlg3.waitFor({ state: 'visible', timeout: 8000 })
  const afterBad = (await dlg3.innerText()).replace(/\s+/g, ' ')
  record('afterBadStillHasData', { text: afterBad.slice(0, 180) })
  assert(/本义助记 \d+ 条/.test(afterBad), '错误导入后已有数据应仍在')
  await page.screenshot({ path: join(OUT, '51-core-io-preview-390.png') }).catch(() => {})
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 }))
  record('layout390', layout)
  assert(!layout.overflow, '390 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[coreio] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[coreio] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '86-coreio-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-core-io.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
