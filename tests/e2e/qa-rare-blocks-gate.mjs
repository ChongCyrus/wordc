#!/usr/bin/env node
/** task-209/210：不常考本义/含义隐藏、徽标、二次取消、stale清理、AI预览含本义并应用回填、开关关闭全显示、390布局。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[rare] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
await page.route('**/chat/completions', (route) => route.fulfill({
  status: 200, contentType: 'application/json',
  body: JSON.stringify({ choices: [{ message: { content: '{"rareMeaningIndexes":[1],"rareCoreSenseIndexes":[1]}' } }] }),
}))
const setSetting = async (key, value) => page.evaluate(async ({ key, value }) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, { key, value })
const enter = async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  // AI Key/config（mock）
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat' })) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await enter()
  // 默认隐藏：含义1 + 本义1 = 2 条
  const hiddenBtn = page.locator('.annotation-hidden-rare').first()
  await hiddenBtn.waitFor({ state: 'visible', timeout: 10_000 })
  const hiddenText = await hiddenBtn.innerText()
  const hiddenState = await page.evaluate(() => ({
    rareMeaningRows: document.querySelectorAll('.rare-badge').length,
    coreCards: document.querySelectorAll('.core-sense-card').length,
    staleText: document.querySelector('.annotation-rare-stale')?.textContent ?? '',
  }))
  record('defaultHidden', { hiddenText, ...hiddenState })
  assert(/已隐藏 2 条不常考/.test(hiddenText), `默认应隐藏2条，实际 ${hiddenText}`)
  assert(hiddenState.rareMeaningRows === 0 && hiddenState.coreCards === 0, `默认应隐藏rare c/本义卡：${JSON.stringify(hiddenState)}`)
  assert(/本义已变化：1 条/.test(hiddenState.staleText), `应有stale提示：${hiddenState.staleText}`)
  // 临时显示/恢复
  await hiddenBtn.click()
  await page.waitForTimeout(200)
  const shown = await page.evaluate(() => ({
    text: document.querySelector('.annotation-hidden-rare')?.textContent ?? '',
    rareBadges: document.querySelectorAll('.rare-badge').length,
    coreCards: document.querySelectorAll('.core-sense-card').length,
    coreRareBadges: document.querySelectorAll('.core-sense-rare-badge').length,
  }))
  record('temporaryShow', shown)
  assert(/已临时显示 2 条/.test(shown.text) && shown.rareBadges > 0 && shown.coreCards > 0, `临时显示应出现徽标/本义卡：${JSON.stringify(shown)}`)
  await page.locator('.annotation-hidden-rare').click()
  await page.waitForTimeout(200)
  // stale 清理
  const clearBtn = page.getByRole('button', { name: '清理旧标记' }).first()
  await clearBtn.click()
  await page.waitForTimeout(500)
  const staleGone = await page.locator('.annotation-rare-stale').count()
  record('staleClean', { staleGone })
  assert(staleGone === 0, '清理后stale提示应消失')
  // 本义 badge 二次确认取消
  await hiddenBtn.click()
  await page.waitForTimeout(200)
  const coreBadge = page.locator('.core-sense-rare-badge').first()
  await coreBadge.click()
  const confirm = page.getByRole('dialog', { name: '取消本义不常考标记？' }).first()
  await confirm.waitFor({ state: 'visible', timeout: 5000 })
  const confirmText = (await confirm.innerText()).slice(0, 160)
  record('cancelConfirm', { visible: true, text: confirmText })
  await confirm.getByRole('button', { name: /取消/ }).first().click()
  await page.waitForTimeout(200)
  assert((await coreBadge.count()) > 0, '取消确认后本义不常考徽标应保留')
  await page.locator('.annotation-hidden-rare').click()
  await page.waitForTimeout(200)
  // AI 标记预览：含本义 + 应用回填
  await page.getByRole('button', { name: 'AI 标记不常考' }).first().click()
  const preview = page.locator('.mm-dialog').filter({ hasText: 'AI 标记不常考' }).first()
  await preview.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => /应用已选（含义 \d+ · 本义 \d+）/.test(document.body.innerText), null, { timeout: 15_000 }).catch(() => {})
  const previewText = await preview.innerText()
  const applyBtn = preview.getByRole('button', { name: /应用已选/ }).first()
  const applyLabel = await applyBtn.innerText().catch(() => '')
  record('aiPreview', { hasCoreSection: /本义建议/.test(previewText), applyLabel })
  assert(/本义建议/.test(previewText) && /本义 \d+/.test(applyLabel), `AI预览应含本义并回填：${previewText.slice(0, 180)} / ${applyLabel}`)
  await applyBtn.click()
  await page.waitForTimeout(800)
  const applied = await page.evaluate(() => ({ hidden: document.querySelector('.annotation-hidden-rare')?.textContent ?? '', rareBadges: document.querySelectorAll('.rare-badge').length, coreRareBadges: document.querySelectorAll('.core-sense-rare-badge').length }))
  record('aiAppliedBackfill', applied)
  assert(/已隐藏 \d+ 条|已临时显示 \d+ 条/.test(applied.hidden), `应用后应回填标记：${JSON.stringify(applied)}`)
  await page.screenshot({ path: join(OUT, '34-rare-preview-apply-390.png') }).catch(() => {})
  // 关闭隐藏开关：全部显示 + 徽标，无隐藏按钮
  await page.locator('.mm-dialog').first().getByRole('button', { name: /取消|关闭/ }).first().click().catch(() => {})
  await setSetting('study.hideRareBlocks', false)
  await enter()
  const offState = await page.evaluate(() => ({ hiddenBtn: document.querySelectorAll('.annotation-hidden-rare').length, rareBadges: document.querySelectorAll('.rare-badge').length, coreCards: document.querySelectorAll('.core-sense-card').length, coreRareBadges: document.querySelectorAll('.core-sense-rare-badge').length }))
  record('hideOff', offState)
  assert(offState.hiddenBtn === 0 && offState.rareBadges > 0 && offState.coreCards > 0 && offState.coreRareBadges > 0, `关闭隐藏后应全显示+徽标：${JSON.stringify(offState)}`)
  // 390 深色布局
  const layout = await page.evaluate(() => ({ pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, rareRows: Array.from(document.querySelectorAll('.core-sense-rare-badge,.rare-badge')).filter((el) => el.getBoundingClientRect().width > innerWidth).length }))
  record('layout390', layout)
  assert(!layout.pageOverflow && layout.rareRows === 0, `390布局不应溢出：${JSON.stringify(layout)}`)
  await page.screenshot({ path: join(OUT, '35-rare-shown-390.png') }).catch(() => {})
  // task-209 ⑦：先把带 AI 应用后的状态复位为「1 rare c + 1 nc c」，隔离验证阶段3
  const resetInfo = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    if (!w?.meanings?.[0]?.id || !w?.meanings?.[1]?.id) return { ok: false }
    const rareMeaningIds = [w.meanings[0].id]
    const ncMeaningIds = [w.meanings[1].id]
    await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rareMeaningIds, ncMeaningIds }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    return { ok: true, rareMeaningIds, ncMeaningIds, meanings: w.meanings.map((m) => m.cn) }
  })
  record('stage3FixtureReset', resetInfo)
  assert(resetInfo.ok, `阶段3 fixture 复位失败：${JSON.stringify(resetInfo)}`)
  await setSetting('study.hideRareBlocks', true)
  await enter()
  await page.getByRole('button', { name: '生成式记忆' }).first().click()
  await page.locator('.generative-stage').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.generative-scroll').getByRole('button', { name: '下一步' }).click()
  await page.locator('.generative-phase2').waitFor({ state: 'visible', timeout: 10_000 })
  for (let i = 0; i < 3; i += 1) { await page.locator('.generative-phase2').click({ position: { x: 10, y: 10 } }); await page.waitForTimeout(150) }
  await page.waitForFunction(() => /阶段 3\/4/.test(document.body.innerText), null, { timeout: 10_000 })
  await page.waitForTimeout(300)
  const stage3 = await page.evaluate(() => ({
    texts: Array.from(document.querySelectorAll('.generative-c')).map((el) => el.innerText.replace(/\s+/g, ' ')),
    ncBadges: document.querySelectorAll('.generative-c .nc-badge').length,
    countLine: Array.from(document.querySelectorAll('.mm-caption')).map((el) => el.textContent ?? '').find((t) => /已选 \d+ 个 nc/.test(t)) ?? '',
  }))
  record('stage3Filter', stage3)
  assert(stage3.texts.length > 0 && !stage3.texts.some((t) => t.includes('谴责')), `阶段3应过滤 rare c：${JSON.stringify(stage3.texts)}`)
  assert(stage3.texts.some((t) => t.includes('告发')), `阶段3应保留 nc c：${JSON.stringify(stage3.texts)}`)
  assert(stage3.ncBadges > 0 && /已选 1 个 nc/.test(stage3.countLine), `nc 应默认选中：${JSON.stringify(stage3)}`)
  const cButtons = page.locator('.generative-c')
  const selectedBefore = stage3.ncBadges
  await cButtons.filter({ hasText: '告发' }).first().click()
  await page.waitForTimeout(250)
  const afterToggle = await page.evaluate(() => ({ ncBadges: document.querySelectorAll('.generative-c .nc-badge').length, count: Array.from(document.querySelectorAll('.mm-caption')).map((el) => el.textContent ?? '').find((t) => /已选 \d+ 个 nc/.test(t)) ?? '' }))
  record('stage3NcToggle', { selectedBefore, ...afterToggle })
  assert(afterToggle.ncBadges === 0 && /已选 0 个 nc/.test(afterToggle.count), `nc c 应可取消勾选：${JSON.stringify(afterToggle)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[rare] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[rare] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '94-rare-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-rare-blocks.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
