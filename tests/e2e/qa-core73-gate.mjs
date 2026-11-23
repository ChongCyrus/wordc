#!/usr/bin/env node
/** 0.3.73 task-223：gloss 小字、本义串联记忆共用入口/预览/保存/清空/双端同步、无建议态；mock AI。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[core73] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
let requests = 0
await page.route('**/chat/completions', async (route) => {
  requests += 1
  const body = route.request().postData() ?? ''
  const content = { mnemonic: 'CORE73单条助记', text: 'CORE73 本义串联预览' }
  await sleep(120)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }) })
})
const setSettings = async (pairs) => page.evaluate(async (pairs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries(pairs)) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, pairs)
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const now = Date.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['packs', 'packItems', 'words', 'settings'], 'readwrite')
      tx.objectStore('packs').put({ id: 'fixture-gloss', name: 'fixture gloss', kind: 'semantics', formatVersion: 1, checksum: 'fixturegloss', source: 'builtin', status: 'applied', deckId: 'kaoyan-2027-dagang', promptVersion: 'v4.0-semantics-grouped', counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 }, createdAt: now, updatedAt: now })
      tx.objectStore('packItems').put({ id: 'fixture-gloss:1', packId: 'fixture-gloss', seq: 1, wordId: 'kaoyan-2027-dagang:denounce', headwordLower: 'denounce', payload: { headword: 'denounce', coreSenses: [{ index: 1, label: 'fixture旧本义', note: 'CORE73 本义小字 gloss' }], meaningMap: [] }, status: 'applied', createdAt: now, appliedAt: now })
      const get = tx.objectStore('words').get('kaoyan-2027-dagang:denounce')
      get.onsuccess = () => { const w = get.result; if (w) tx.objectStore('words').put({ ...w, rareCoreSenses: [], rareMeaningIds: [] }) }
      for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat', 'memory.weightedCoreSenseOnly': true, 'memory.coreSenseExampleCount': 2, 'memory.coreSensePhraseCount': 2 })) tx.objectStore('settings').put({ key, value, updatedAt: now })
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  // ① gloss 小字（只记本义页）
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.wc-core-sense-gloss').first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(300)
  const gloss = await page.locator('.wc-core-sense-gloss').first().innerText().catch(() => '')
  record('gloss', { text: gloss.replace(/\s+/g, ' ') })
  assert(/CORE73 本义小字 gloss/.test(gloss), `只记本义页应显示 gloss 小字：${gloss}`)
  await page.screenshot({ path: join(OUT, '43-core-gloss-390.png') }).catch(() => {})
  // 回注释面，打开本义助记面板
  await page.getByRole('button', { name: '退出记忆' }).first().click()
  const exitDlg = page.getByRole('dialog', { name: /退出记忆/ }).first()
  if (await exitDlg.count()) await exitDlg.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const panel = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await panel.waitFor({ state: 'visible', timeout: 10_000 })
  const before = (await panel.innerText()).replace(/\s+/g, ' ')
  record('beforeGenerate', { hasSuggestion: /AI 建议：/.test(before), hasOverview: /本义串联记忆/.test(before), text: before.slice(0, 220) })
  assert(!/AI 建议：/.test(before), `未生成时不应有建议态：${before.slice(0, 160)}`)
  await panel.getByRole('button', { name: 'AI 生成全部' }).click()
  await page.waitForTimeout(1200)
  record('afterGenerateClick', { requests, overview: await panel.locator('textarea').first().inputValue().catch(() => ''), text: (await panel.innerText()).replace(/\s+/g, ' ').slice(0, 400) })
  await page.waitForFunction(() => { const t = document.querySelector('textarea[aria-label="本义串联记忆"]'); return Boolean(t && t.value.includes('CORE73')) }, null, { timeout: 15_000 })
  const generated = { text: (await panel.innerText()).replace(/\s+/g, ' '), overview: await panel.locator('textarea').first().inputValue() }
  record('generated', { requests, hasOverviewSuggestion: /本义串联记忆（AI 建议）/.test(generated.text), hasMnemonicSuggestion: /AI 建议：CORE73单条助记/.test(generated.text), overview: generated.overview, text: generated.text.slice(0, 300) })
  assert(/CORE73 本义串联预览/.test(generated.overview), '生成全部应同时出现串联记忆预览')
  assert(/AI 建议：CORE73单条助记/.test(generated.text), '应出现单条助记建议')
  await page.screenshot({ path: join(OUT, '44-core-overview-preview-390.png') }).catch(() => {})
  const bottomButtons = await panel.evaluate((dialog) => {
    const vh = window.innerHeight
    const rect = dialog.getBoundingClientRect()
    const btns = Array.from(dialog.querySelectorAll('button')).filter((b) => /^(关闭|应用 AI 建议)$/.test((b.textContent ?? '').trim()))
    return {
      dialogBottom: Math.round(rect.bottom),
      viewportHeight: vh,
      buttons: btns.map((b) => {
        const r = b.getBoundingClientRect()
        const cx = r.left + r.width / 2
        const cy = r.top + r.height / 2
        const hit = document.elementFromPoint(cx, cy)
        return { label: (b.textContent ?? '').trim(), top: Math.round(r.top), bottom: Math.round(r.bottom), inViewport: r.top >= 0 && r.bottom <= vh, hitOk: Boolean(hit && (hit === b || b.contains(hit))), hitTag: hit?.tagName ?? '', hitClass: hit?.className ?? '' }
      }),
    }
  })
  record('bottomButtons', bottomButtons)
  assert(bottomButtons.buttons.length >= 2 && bottomButtons.buttons.every((b) => b.inViewport && b.hitOk), `面板底部按钮应在视口内且可点击、不被评分栏覆盖：${JSON.stringify(bottomButtons)}`)
  // 保存串联记忆 → 注释面顶部同步
  await panel.getByRole('button', { name: '保存串联记忆' }).click()
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '关闭' }).first().click().catch(() => {})
  await page.waitForTimeout(500)
  const annoOverview = await page.locator('.core-sense-overview').first().innerText().catch(() => '')
  record('annotationOverview', { text: annoOverview.replace(/\s+/g, ' ').slice(0, 180) })
  assert(/CORE73 本义串联预览/.test(annoOverview), `保存后注释面应显示串联记忆：${annoOverview}`)
  await page.screenshot({ path: join(OUT, '45-core-overview-annotation-390.png') }).catch(() => {})
  // 只记本义页同步
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(500)
  const memoryOverview = await page.locator('.wc-core-sense-overview').first().innerText().catch(() => '')
  record('memoryOverview', { text: memoryOverview.replace(/\s+/g, ' ').slice(0, 180) })
  assert(/CORE73 本义串联预览/.test(memoryOverview), `只记本义页应同步串联记忆：${memoryOverview}`)
  await page.screenshot({ path: join(OUT, '46-core-overview-memory-390.png') }).catch(() => {})
  // 清空 → 双端消失
  await page.getByRole('button', { name: '退出记忆' }).first().click()
  const exitDlg2 = page.getByRole('dialog', { name: /退出记忆/ }).first()
  if (await exitDlg2.count()) await exitDlg2.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: 'AI 本义助记' }).first().click()
  const panel2 = page.locator('.mm-dialog').filter({ hasText: '本义助记 · ' }).first()
  await panel2.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => { const t = document.querySelector('textarea[aria-label="本义串联记忆"]'); return Boolean(t && t.value.includes('CORE73')) }, null, { timeout: 5000 })
  const reopenedOverview = await panel2.locator('textarea').first().inputValue()
  record('reopenedOverview', { value: reopenedOverview })
  assert(/CORE73 本义串联预览/.test(reopenedOverview), `重开面板应回填已保存串联记忆：${reopenedOverview}`)
  await panel2.getByRole('button', { name: /^清空$/ }).click()
  await page.waitForTimeout(900)
  await page.getByRole('button', { name: '关闭' }).first().click().catch(() => {})
  await page.waitForTimeout(500)
  const cleared = await page.locator('.core-sense-overview').count()
  record('cleared', { overviewCount: cleared })
  assert(cleared === 0, '清空后注释面不应再显示串联记忆')
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 }))
  record('layout390', layout)
  assert(!layout.overflow, '390 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[core73] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[core73] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '88-core73-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-core73.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
