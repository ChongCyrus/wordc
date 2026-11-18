#!/usr/bin/env node
/** task-177/197 批量不常考 mock 门禁（不调真实 API）：进度递增/并发/停止/只重试失败/结束 done=total。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { fixture: FIXTURE || '', checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[batch] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
let requests = 0
let failFirst = false
await page.route('**/chat/completions', async (route) => {
  requests += 1
  const n = requests
  await sleep(600)
  if (failFirst && n === 1) {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'mock fail' } }) })
    return
  }
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ choices: [{ message: { content: '{"rareMeaningIndexes":[1],"rareCoreSenseIndexes":[1]}' } }] }),
  })
})
try {
  console.log('[batch] goto')
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  console.log('[batch] fixture loaded')
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
    await new Promise((res, rej) => {
      const tx = db.transaction('words', 'readwrite')
      for (const w of words.filter((x) => ['denounce', 'technical', 'domain'].includes(String(x.headword).toLowerCase()))) { const next = { ...w }; delete next.rareCoreSenses; tx.objectStore('words').put(next) }
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    await new Promise((res, rej) => {
      const tx = db.transaction('settings', 'readwrite')
      for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat', 'study.markRareCoreSenses': true })) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() })
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  console.log('[batch] reload')
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  console.log('[batch] home ready')
  await clickStart(page)
  console.log('[batch] started')
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  const openBatch = async () => {
    await page.getByRole('button', { name: '更多' }).first().click()
    await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).click()
    await page.locator('.mm-dialog').first().waitFor({ state: 'visible', timeout: 10_000 })
    await page.getByRole('button', { name: '批量标记「不常考」含义' }).first().click()
    const batch = page.locator('[role="dialog"][aria-label="批量标记不常考含义"]').first()
    await batch.waitFor({ state: 'visible', timeout: 10_000 })
    return batch
  }
  let batch = await openBatch()
  await batch.getByRole('button', { name: '今日计划' }).click()
  let totalText = ''
  for (let i = 0; i < 40; i += 1) {
    totalText = await batch.locator('.mm-caption').first().innerText().catch(() => '')
    if (/共 \d+ 个词/.test(totalText)) break
    await page.waitForTimeout(250)
  }
  record('total', totalText)
  assert(/共 3 个词/.test(totalText), `今日计划应3词，实际 ${totalText}`)
  // 并发 1-4 控件存在
  const concurrency = batch.getByLabel('批量标记不常考并发数')
  record('concurrencyControl', { count: await concurrency.count() })
  assert((await concurrency.count()) > 0, '并发数控件应存在')
  // 完整跑 + 一次失败 + 重试
  failFirst = true
  await batch.getByRole('button', { name: '开始批量标记' }).click()
  const seq = []
  for (let i = 0; i < 40; i += 1) {
    await page.waitForTimeout(150)
    const t = await batch.innerText().catch(() => '')
    const m = t.match(/进行中 (\d+) \/ (\d+)/)
    if (m) seq.push(`${m[1]}/${m[2]}`)
    if (/重试失败（1）/.test(t)) break
  }
  record('progressSeq', seq.slice(0, 12))
  assert(seq.length > 0 && seq[0].startsWith('0/'), `进度应从0递增，实际 ${seq.slice(0, 3)}`)
  const retryBtn = batch.getByRole('button', { name: /重试失败（1）/ }).first()
  await retryBtn.waitFor({ state: 'visible', timeout: 15_000 })
  const reqBeforeRetry = requests
  await retryBtn.click()
  await page.waitForTimeout(2500)
  const afterRetry = await batch.innerText().catch(() => '')
  record('retry', { reqBeforeRetry, reqAfter: requests, text: afterRetry.match(/进行中 \d+ \/ \d+（[^）]+）/)?.[0] ?? '' })
  assert(requests === reqBeforeRetry + 1, `只应重试失败1项，实际新增 ${requests - reqBeforeRetry} 请求`)
  assert(/进行中 1 \/ 1/.test(afterRetry) && !/失败 [1-9]/.test(afterRetry), `重试应只处理失败1项且 done=total，实际 ${afterRetry.slice(0, 160)}`)
  const batchFullText = await batch.innerText(); record('coreAndSummary', { hasCore: /本义/.test(batchFullText), applyLabel: batchFullText.match(/应用已选[^\n]*/)?.[0] ?? '' }); assert(/本义/.test(batchFullText), '批量面板应包含本义内容/汇总')
  record('finalDoneTotal', true)
  // 停止 <2s 恢复（复用当前批量面板，不再关闭/重开避免遮罩）
  failFirst = false
  await batch.getByRole('button', { name: '开始批量标记' }).click()
  await page.waitForTimeout(500)
  const stop = batch.getByRole('button', { name: '停止' }).first()
  const t0 = Date.now()
  await stop.click()
  const startBtn = batch.getByRole('button', { name: '开始批量标记' }).first()
  await startBtn.waitFor({ state: 'visible', timeout: 2000 })
  const stopRecoverMs = Date.now() - t0
  record('stopRecoverMs', stopRecoverMs)
  assert(stopRecoverMs < 2000, `停止后UI应在2s内恢复，实际 ${stopRecoverMs}ms`)
  // ④ 应用汇总「含义 N · 本义 M」：切当前词（有 coreSenses），跑1词再应用
  await batch.getByRole('button', { name: '当前词' }).first().click()
  await page.waitForFunction(() => /共 1 个词/.test(document.body.innerText), null, { timeout: 10_000 })
  await batch.getByRole('button', { name: /开始批量标记/ }).click()
  await page.waitForFunction(() => /进行中 1 \/ 1/.test(document.body.innerText), null, { timeout: 15_000 })
  await page.waitForTimeout(500)
  const applyBtn = batch.getByRole('button', { name: /应用已选/ }).first()
  await applyBtn.waitFor({ state: 'visible', timeout: 5000 })
  await page.waitForFunction(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => /应用已选/.test(x.textContent ?? ''))
    return !!b && !b.disabled
  }, null, { timeout: 5000 }).catch(() => {})
  if (await applyBtn.count()) {
    record('applyBtnLabel', await applyBtn.innerText().catch(() => ''))
    await applyBtn.click()
    await page.waitForFunction(() => /已应用：含义 \d+ 条 · 本义 \d+ 条/.test(document.body.innerText), null, { timeout: 10_000 })
    const summary = (await page.locator('body').innerText()).match(/已应用：含义 \d+ 条 · 本义 \d+ 条/)?.[0] ?? ''
    record('applySummary', summary)
    assert(/含义 [1-9]\d* 条 · 本义 [1-9]\d* 条/.test(summary), `应用汇总数字应正确（含义/本义均>0），实际 ${summary}`)
    const coreRows = await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
      return w?.rareCoreSenses?.length ?? 0
    })
    record('rareCoreSensesAfterApply', coreRows)
    assert(coreRows >= 1, `应用后 DB rareCoreSenses 应≥1，实际 ${coreRows}`)
  }
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource|mock fail/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[batch] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[batch] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '97-batch-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-batch-gate.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
