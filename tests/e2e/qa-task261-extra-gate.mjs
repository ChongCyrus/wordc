#!/usr/bin/env node
/** 0.3.88 补充：单元详情批量工具条跨分页 + 词详情与注释面内容对照。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[t261x] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/units`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.locator('a.mm-row').first().click(); await page.waitForTimeout(1000)
  const tbText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  const sortOpts = await page.getByLabel('排序').locator('option').allTextContents()
  const statusOpts = await page.getByLabel('状态筛选').locator('option').allTextContents()
  const m0 = tbText.match(/已选 (\d+) \/ 筛选 (\d+)/)
  record('unitToolbar', { sortOpts, statusOpts, counts: m0?.[0], selectAll: await page.getByRole('button', { name: '全选', exact: true }).count(), invert: await page.getByRole('button', { name: '反选', exact: true }).count(), clear: await page.getByRole('button', { name: '取消全选', exact: true }).count(), pager: tbText.match(/\d+\/\d+/)?.[0] })
  assert(sortOpts.length === 4 && statusOpts.length >= 3 && m0, `单元工具条应有排序4/状态/已选筛选：${JSON.stringify({ sortOpts, statusOpts, m0: m0?.[0] })}`)
  const total = Number(m0[2])
  await page.getByRole('button', { name: '全选', exact: true }).click(); await page.waitForTimeout(800)
  const mAll = (await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/已选 (\d+) \/ 筛选 (\d+)/)
  record('unitSelectAll', { selected: mAll?.[1], total: mAll?.[2], expectedTotal: total, crossPage: Number(mAll?.[1]) > 50 })
  assert(mAll && Number(mAll[1]) === Math.min(total, 999) && Number(mAll[1]) > 50, `全选应跨分页选满并上限999：${JSON.stringify({ all: mAll?.[0], total })}`)
  await page.getByRole('button', { name: '反选', exact: true }).click(); await page.waitForTimeout(500)
  const mInv = (await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/已选 (\d+) \/ 筛选 (\d+)/)
  record('unitInvert', { selected: mInv?.[1] })
  await page.getByRole('button', { name: '取消全选', exact: true }).click(); await page.waitForTimeout(400)
  const mClear = (await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/已选 (\d+) \/ 筛选 (\d+)/)
  record('unitClear', { selected: mClear?.[1] })
  assert(mClear && mClear[1] === '0', `取消应0：${mClear?.[0]}`)
  await page.screenshot({ path: join(OUT, '83-unit-toolbar-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 }))
  record('unit360', layout)
  await page.screenshot({ path: join(OUT, '83-unit-toolbar-360.png') }).catch(() => {})
  assert(!layout.overflow, '单元360不应溢出')
  // 词详情内容对照
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/words/kaoyan-2027-dagang:denounce`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1000)
  const info = await page.evaluate(() => {
    const t = document.body.innerText.replace(/\s+/g, ' ')
    return {
      headword: /denounce/.test(t), coreCards: document.querySelectorAll('.core-sense-card').length,
      coreBadge: document.querySelectorAll('.core-sense-badge').length,
      meanings: document.querySelectorAll('.meaning-row').length,
      pos: /\[(?:n|vt|vi|adj|adv)\.\]/.test(t),
      familiarity: /不熟悉度/.test(t), examples: document.querySelectorAll('.meaning-example').length,
      phrases: document.querySelectorAll('.phrase-line, .meaning-phrase').length,
      aiMnemonic: /fixture AI助记/.test(t), userNote: /fixture我的笔记/.test(t), userMnemonic: /fixture我的助记/.test(t),
      aiContent: /AI 本义助记|AI 标记不常考/.test(t),
      ratings: Array.from(document.querySelectorAll('button')).filter((b) => /^(认识|模糊|不认识)$/.test((b.textContent ?? '').trim())).length,
      text: t.slice(0, 260),
    }
  })
  record('wordDetailCompare', info)
  assert(info.headword && info.coreCards > 0 && info.meanings >= 4 && info.pos && info.familiarity, `词详情应有本义/含义pos+cn+不熟：${JSON.stringify(info)}`)
  assert(info.ratings === 0, `词详情不应有评分按钮：${info.ratings}`)
  assert(info.aiMnemonic && info.userNote && info.userMnemonic, `词详情应显示AI助记/笔记/用户助记：${JSON.stringify({ ...info, text: undefined })}`)
  await page.screenshot({ path: join(OUT, '82b-word-detail-content-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[t261x] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[t261x] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '71-task261x-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-task261x.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
