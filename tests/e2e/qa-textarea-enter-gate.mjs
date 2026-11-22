#!/usr/bin/env node
/** 0.4.6 textarea Enter 换行/保存保留/IME composing 不误插。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[ta] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const openEditor = async () => { await page.evaluate(() => { const b = document.querySelector('.root-etymology-card button'); if (b) b.click() }); await page.waitForTimeout(600); const dlg = page.getByRole('dialog', { name: /编辑词根词缀词源/ }).first(); await dlg.waitFor({ state: 'visible', timeout: 5000 }); return dlg }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 120_000); await page.waitForTimeout(700)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1100)
  await openAnnotation(page); await page.waitForTimeout(300)
  let dlg = await openEditor()
  // 点「添加部分」保证有 textarea 可测；词源说明 textarea 第1个
  await dlg.getByRole('button', { name: /添加部分/ }).click().catch(() => {})
  const ta = dlg.locator('textarea').first()
  await ta.click(); await page.keyboard.press('Control+A'); await page.keyboard.type('QA第一行')
  await page.keyboard.press('Enter'); await page.waitForTimeout(200); await page.keyboard.insertText('QA第二行'); await page.waitForTimeout(200)
  const val1 = await ta.inputValue(); record('enter', { val1 })
  assert(val1.includes('\n') && val1.includes('QA第一行') && val1.includes('QA第二行'), `Enter 未换行：${JSON.stringify(val1)}`)
  const caret = await ta.evaluate((el) => el.selectionStart === el.value.length)
  record('caretAtEnd', { caret })
  // IME composing 模拟：composition 期间 Enter 不应插入额外换行（记录实际值）
  await page.evaluate(() => { const el = document.querySelector('[role=dialog] textarea'); if (!el) return; el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true, bubbles: true })); el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })) })
  await page.waitForTimeout(300)
  const valComposing = await ta.inputValue(); record('composing', { valComposing })
  await dlg.getByRole('button', { name: '保存', exact: true }).click(); await page.waitForTimeout(900)
  dlg = await openEditor()
  const val2 = await dlg.locator('textarea').first().inputValue(); record('reopen', { val2 })
  assert(val2.includes('\n') && val2.includes('QA第一行') && val2.includes('QA第二行'), `保存后换行丢失：${JSON.stringify(val2)}`)
  await page.screenshot({ path: join(OUT, '149-textarea-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout); assert(!layout.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[ta] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[ta] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '43-textarea-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-textarea.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
