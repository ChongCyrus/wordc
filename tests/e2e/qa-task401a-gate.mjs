#!/usr/bin/env node
/** 0.4.1-A 文案：w-c 三步/具体而言、Me 使用说明、README；390/360。不调 API。 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t401a] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 120_000); await page.waitForTimeout(800)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1200)
  await openAnnotation(page); await page.waitForTimeout(400)
  await page.getByRole('button', { name: '记忆', exact: true }).first().click(); await page.waitForTimeout(900)
  const wc = await page.evaluate(() => ({
    step1: document.querySelector('.wc-root-process-list li')?.textContent ?? '',
    strong: document.querySelector('.wc-root-process-list li strong')?.textContent ?? '',
    details: document.querySelectorAll('.wc-root-process-list details, .wc-root-process details').length,
    summary: Array.from(document.querySelectorAll('summary')).map((s) => s.textContent ?? '').join('|'),
    body: document.querySelector('.wc-root-process')?.textContent ?? '',
  }))
  record('wc', wc)
  assert(/记忆.*“词根缀源 → 词根缀源的含义”.*及整体拼接后的含义\/意象/.test(wc.step1.replace(/\s+/g, ' ')), `w-c step1 文案不符：${wc.step1}`)
  assert(wc.strong.includes('“词根缀源 → 词根缀源的含义”'), `w-c step1 引号/加粗不符：${wc.strong}`)
  assert(/具体而言/.test(wc.body), `w-c 缺具体而言：${wc.body.slice(0,80)}`)
  await page.screenshot({ path: join(OUT, '136-wc-copy-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const wc360 = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, text: document.querySelector('.wc-root-process-list li')?.textContent ?? '' }))
  record('wc360', { overflow: wc360.overflow, text: wc360.text.slice(0, 80) })
  await page.screenshot({ path: join(OUT, '136b-wc-copy-360.png') }).catch(() => {})
  assert(!wc360.overflow, 'wc 360 溢出')
  // Me 使用说明
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  const sum = page.getByText(/怎么练：词根词缀法三步/).first(); await sum.click(); await page.waitForTimeout(400)
  const me = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('me', { step1: /记忆 “词根缀源 → 词根缀源的含义”，及整体拼接后的含义\/意象/.test(me), detail: /具体而言/.test(me), benefit: /另一个好处/.test(me), dict: /字典序/.test(me) })
  assert(/记忆 “词根缀源 → 词根缀源的含义”，及整体拼接后的含义\/意象/.test(me) && /具体而言/.test(me) && /另一个好处/.test(me) && /字典序/.test(me), `Me 文案缺失：${me.slice(0,300)}`)
  await page.screenshot({ path: join(OUT, '137-usage-copy-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const me360 = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('me360', me360)
  assert(!me360.overflow, 'Me 360 溢出')
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8')
  const rm = { step: readme.includes('记忆 “词根缀源 → 词根缀源的含义”'), detail: readme.includes('具体而言'), benefit: readme.includes('另一个好处'), dict: readme.includes('字典序') }
  record('readme', rm); assert(rm.step && rm.detail && rm.benefit && rm.dict, `README 文案缺失：${JSON.stringify(rm)}`)
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t401a] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t401a] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '49-task401a-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task401a.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
