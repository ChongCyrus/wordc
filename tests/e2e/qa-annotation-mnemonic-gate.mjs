#!/usr/bin/env node
/** task-207 注释面 c 行 AI 助记：整行可点/Enter/Space 编辑、无遗留编辑按钮、徽标/类型/文字不裁切；我的笔记/助记按钮保留。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { fixture: FIXTURE || '', checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[c-mnemonic] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const closeDialog = async () => {
  const d = page.locator('.mm-dialog').first()
  if (!(await d.count())) return
  const b = d.getByRole('button', { name: /取消|关闭/ }).first()
  if (await b.count()) await b.click().catch(() => {})
  else await page.keyboard.press('Escape')
  await page.locator('.mm-dialog').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(200)
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  const row = page.locator('.meaning-mnemonic.is-editable').first()
  await row.waitFor({ state: 'visible', timeout: 10_000 })
  const info = await row.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return {
      role: el.getAttribute('role'),
      tabIndex: el.getAttribute('tabindex'),
      aria: el.getAttribute('aria-label'),
      text: el.innerText,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      width: Math.round(r.width),
      buttons: el.querySelectorAll('button').length,
    }
  })
  const allButtonsText = await page.locator('button').allInnerTexts()
  record('row', { ...info, hasLegacyEditButton: allButtonsText.some((t) => t.trim() === '编辑') })
  assert(info.role === 'button' && info.tabIndex === '0', 'AI 助记行应 role=button/tabIndex=0')
  assert(info.aria === '编辑含义谴责 的 AI 助记', `aria-label 不符：${info.aria}`)
  assert(info.text.includes('[词根]') && info.text.includes('depend'), `行内应有类型/文字：${info.text}`)
  assert(info.buttons === 0 && !info.hasLegacyEditButton, 'AI 助记行内/页面不应有遗留「编辑」按钮')
  assert(info.scrollWidth <= info.clientWidth + 1, `AI 助记行不应横向裁切：${info.scrollWidth}/${info.clientWidth}`)
  await page.screenshot({ path: join(OUT, '33-annotation-mnemonic-390.png') }).catch(() => {})
  // 点击整行 → dialog 回填
  await row.click()
  const dlg = page.locator('.mm-dialog').first()
  await dlg.waitFor({ state: 'visible', timeout: 5000 })
  const filled = (await dlg.innerText()).includes('depend') || (await dlg.locator('textarea').first().inputValue().catch(() => '')).includes('depend')
  record('clickOpensDialog', { visible: await dlg.isVisible(), filled })
  assert(await dlg.isVisible(), '点击行应打开编辑弹窗')
  await closeDialog()
  // Enter / Space 键盘
  for (const key of ['Enter', ' ']) {
    await row.focus()
    await page.keyboard.press(key)
    await page.locator('.mm-dialog').first().waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
    const ok = await page.locator('.mm-dialog').first().count()
    record(`key_${key === ' ' ? 'Space' : key}`, { opened: ok > 0 })
    assert(ok > 0, `${key} 应打开编辑弹窗`)
    await closeDialog()
  }
  // 笔记/我的助记按钮保留
  const noteBtn = page.getByRole('button', { name: /编辑含义 .* 的我的笔记/ }).first()
  const mineBtn = page.getByRole('button', { name: /编辑含义 .* 的我的助记/ }).first()
  record('userButtons', { notes: await noteBtn.count(), mnemonics: await mineBtn.count() })
  assert((await noteBtn.count()) > 0 && (await mineBtn.count()) > 0, '我的笔记/我的助记编辑按钮应保留')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[c-mnemonic] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[c-mnemonic] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '95-c-mnemonic-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-annotation-mnemonic.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
