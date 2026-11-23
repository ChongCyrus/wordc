#!/usr/bin/env node
/** 0.3.87：已有今日计划弹窗专项：选项唯一、仅取消 action、mask portal fullscreen 不透出；390/360。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[plandlg] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000)
  await page.getByText('添加今日新单词', { exact: true }).first().click()
  const addDlg = page.getByRole('dialog', { name: '添加今日新单词' }).first()
  await addDlg.waitFor({ state: 'visible', timeout: 5000 })
  const boxes = addDlg.locator('.add-word-candidates input[type=checkbox]')
  await page.waitForFunction(() => document.querySelectorAll('.add-word-candidates input[type=checkbox]').length >= 5, null, { timeout: 20_000 }).catch(() => {})
  const n = await boxes.count(); assert(n >= 5, `候选不足：${n}`)
  // 选第 5 个候选，避开已在当前计划的词
  await boxes.nth(4).check()
  await addDlg.getByRole('button', { name: '添加' }).click()
  const planDlg = page.getByRole('dialog', { name: '已有今日计划' }).first()
  await planDlg.waitFor({ state: 'visible', timeout: 8000 })
  await page.waitForTimeout(500)
  const info = await page.evaluate(() => {
    const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => (d.getAttribute('aria-label') ?? '') === '已有今日计划')
    if (!dlg) return null
    const mask = dlg.closest('.mm-mask')
    const text = dlg.innerText.replace(/\s+/g, ' ')
    const bodyText = dlg.querySelector('.mm-dialog-body')?.textContent?.replace(/\s+/g, ' ') ?? ''
    const actions = Array.from(dlg.querySelectorAll('.mm-dialog-actions button')).map((b) => (b.textContent ?? '').trim())
    const opts = ['保留今日计划并追加', '移除今天未学的自动新词后追加', '仅移除未学的自动新词']
    const counts = Object.fromEntries(opts.map((o) => [o, (text.match(new RegExp(o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length]))
    const m = mask?.getBoundingClientRect()
    const d = dlg.getBoundingClientRect()
    const homeTab = document.querySelector('.tabbar, .app-tabbar, nav')?.getBoundingClientRect()
    const cx = m ? Math.round(m.left + m.width / 2) : 0
    const cy = m ? Math.round(m.bottom - 12) : 0
    const hit = m ? document.elementFromPoint(cx, cy) : null
    return {
      maskParent: mask?.parentElement?.tagName ?? '', maskPosition: mask ? getComputedStyle(mask).position : '',
      maskRect: m ? { top: Math.round(m.top), left: Math.round(m.left), width: Math.round(m.width), height: Math.round(m.height) } : null,
      viewport: { w: innerWidth, h: innerHeight }, actions, counts, bodyText: bodyText.slice(0, 200),
      dialogBg: getComputedStyle(dlg).backgroundColor, dialogOpacity: getComputedStyle(dlg).opacity,
      hitTag: hit?.tagName ?? '', hitClass: hit?.className ?? '', hitInDialog: dlg.contains(hit),
      homeTabBottom: homeTab ? Math.round(homeTab.bottom) : null,
    }
  })
  record('planDialog', info)
  assert(info, '未找到计划弹窗')
  assert(info.maskParent === 'BODY' && info.maskPosition === 'fixed', `mask 应 portal 到 body 且 fixed：${JSON.stringify(info)}`)
  assert(info.maskRect.top === 0 && info.maskRect.left === 0 && info.maskRect.width >= info.viewport.w - 1 && info.maskRect.height >= info.viewport.h - 1, `mask 应全屏：${JSON.stringify(info.maskRect)}`)
  assert(info.actions.length === 1 && info.actions[0] === '取消', `actions 应仅取消，实际 ${JSON.stringify(info.actions)}`)
  assert(info.counts['保留今日计划并追加'] === 1 && info.counts['移除今天未学的自动新词后追加'] === 1 && info.counts['仅移除未学的自动新词'] === 1, `三选项应各1次：${JSON.stringify(info.counts)}`)
  assert(info.dialogOpacity === '1' && !/rgba\(0, 0, 0, 0\)|transparent/.test(info.dialogBg), `dialog 应不透明：${info.dialogBg}/${info.dialogOpacity}`)
  assert(info.hitInDialog || /mm-mask/.test(String(info.hitClass)) || /MASK/.test(info.hitTag), `底部应被遮罩覆盖而非首页 tabbar：${JSON.stringify(info)}`)
  await page.screenshot({ path: join(OUT, '81-plan-dialog-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const info360 = await page.evaluate(() => { const m = document.querySelector('.mm-mask')?.getBoundingClientRect(); const dlg = Array.from(document.querySelectorAll('[role="dialog"]')).find((d) => (d.getAttribute('aria-label') ?? '') === '已有今日计划'); return { mask: m ? { t: Math.round(m.top), l: Math.round(m.left), w: Math.round(m.width), h: Math.round(m.height) } : null, overflow: document.documentElement.scrollWidth > innerWidth + 1, actions: dlg ? Array.from(dlg.querySelectorAll('.mm-dialog-actions button')).map((b) => (b.textContent ?? '').trim()) : null } })
  record('planDialog360', info360)
  await page.screenshot({ path: join(OUT, '81-plan-dialog-360.png') }).catch(() => {})
  assert(info360.mask && !info360.overflow && info360.actions.length === 1, `360 应全屏/仅取消/不溢出：${JSON.stringify(info360)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[plandlg] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[plandlg] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '73-plan-dialog-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-plan-dialog.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
