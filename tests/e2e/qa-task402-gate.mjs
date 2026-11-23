#!/usr/bin/env node
/** 0.4.2 文案：README/Me/w-c 原用户文本逐字，无队友转述标题。不调 API。 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t402] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const S2 = '在“加权记忆”模块里，用 词根缀源 理解、联系、推导 出 各个含义/本义（一些难导出的可试图构造逻辑，实在不行则直接接纳式地记忆）。'
const S3 = '之后白板页复习也是根据 词根缀源 来推导、回忆含义/本义，通过 “加权记忆”模块来针对未能想到的映射或含义/本义针对性记忆、加强巩固。'
const forbidden = ['映射算法原理', '双向推导', '白板推导 + 针对性巩固', '白版推导 + 针对性巩固']
try {
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8')
  const readmePlain = readme.replace(/\*\*/g, '')
  const rm = { workflow: /推荐工作流/.test(readme), s2: readmePlain.includes(S2), s3: readmePlain.includes(S3), forbidden: forbidden.filter((x) => readme.includes(x)) }
  record('readme', rm)
  assert(rm.workflow && rm.s2 && rm.s3 && rm.forbidden.length === 0, `README 文案不符：${JSON.stringify(rm)}`)
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  await page.getByText(/怎么练：/).first().click().catch(() => {}); await page.waitForTimeout(400)
  const me = (await page.locator('body').innerText()).replace(/\s+/g, '')
  const noSpace = (x) => x.replace(/\s+/g, '')
  const meChecks = { workflow: /推荐工作流/.test(me), s2: me.includes(noSpace(S2)), s3: me.includes(noSpace(S3)), forbidden: forbidden.filter((x) => me.includes(x)) }
  record('me', meChecks)
  const meList = await page.evaluate(() => { const ol = Array.from(document.querySelectorAll('ol')).find((x) => (x.textContent ?? '').includes('加权记忆')); const li = ol?.querySelector('li'); return { tag: ol?.tagName ?? '', listStyle: ol ? getComputedStyle(ol).listStyleType : '', liStyle: li ? getComputedStyle(li).listStyleType : '', display: ol ? getComputedStyle(ol).display : '' } })
  record('meListStyle', meList)
  assert(meChecks.workflow && meChecks.s2 && meChecks.s3 && meChecks.forbidden.length === 0, `Me 文案不符：${JSON.stringify(meChecks)}`)
  assert(meList.tag === 'OL' && (meList.listStyle === 'decimal' || meList.liStyle === 'decimal') && meList.display !== 'none', `Me 列表序号不可见：${JSON.stringify(meList)}`)
  await page.screenshot({ path: join(OUT, '139-me-copy-390.png') }).catch(() => {})
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 120_000); await page.waitForTimeout(700)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click(); await page.waitForTimeout(1100)
  await openAnnotation(page); await page.waitForTimeout(300)
  await page.getByRole('button', { name: '记忆', exact: true }).first().click(); await page.waitForTimeout(900)
  const wcText = (await page.locator('.wc-root-process').innerText()).replace(/\s+/g, '')
  const wcChecks = { s1: /记忆“词根缀源→词根缀源的含义”，及整体拼接后的含义\/意象/.test(wcText), s2: wcText.includes(noSpace(S2)), s3: wcText.includes(noSpace(S3)), forbidden: forbidden.filter((x) => wcText.includes(x)) }
  const wcList = await page.evaluate(() => { const ol = document.querySelector('.wc-root-process-list'); const li = ol?.querySelector('li'); return { tag: ol?.tagName ?? '', listStyle: ol ? getComputedStyle(ol).listStyleType : '', liStyle: li ? getComputedStyle(li).listStyleType : '', display: ol ? getComputedStyle(ol).display : '' } })
  record('wcListStyle', wcList)
  record('wc', wcChecks)
  assert(wcChecks.s1 && wcChecks.s2 && wcChecks.s3 && wcChecks.forbidden.length === 0, `w-c 文案不符：${JSON.stringify(wcChecks)}`)
  assert(wcList.tag === 'OL' && (wcList.listStyle === 'decimal' || wcList.liStyle === 'decimal') && wcList.display !== 'none', `w-c 列表序号不可见：${JSON.stringify(wcList)}`)
  await page.screenshot({ path: join(OUT, '140-wc-copy-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', layout)
  assert(!layout.overflow, '360 溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[t402] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t402] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '47-task402-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task402.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
