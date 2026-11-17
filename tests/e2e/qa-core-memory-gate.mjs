#!/usr/bin/env node
/** 0.3.70 task-211/212：本义卡点击/不熟度、rare 不可点、加权「只记本义」开关持久/中途切换。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[core] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setSetting = async (key, value) => page.evaluate(async ({ key, value }) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, { key, value })
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  // 注入第二个非 rare 本义（索引2），与 fixture rare 本义1 并存
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const now = Date.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['packs', 'packItems'], 'readwrite')
      tx.objectStore('packs').put({ id: 'fixture-core2', name: 'fixture second core', kind: 'semantics', formatVersion: 1, checksum: 'fixturecore2', source: 'builtin', status: 'applied', deckId: 'kaoyan-2027-dagang', promptVersion: 'v4.0-semantics-grouped', counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 }, createdAt: now, updatedAt: now })
      tx.objectStore('packItems').put({ id: 'fixture-core2:1', packId: 'fixture-core2', seq: 1, wordId: 'kaoyan-2027-dagang:denounce', headwordLower: 'denounce', payload: { headword: 'denounce', coreSenses: [{ index: 1, label: 'fixture第二本义' }], meaningMap: [] }, status: 'applied', createdAt: now, appliedAt: now })
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    if (!w) return
    await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rareCoreSenses: [{ coreSenseIndex: 1, label: 'fixture旧本义', updatedAt: Date.now() }] }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await setSetting('study.hideRareBlocks', false)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  const cards = page.locator('.core-sense-card')
  await cards.first().waitFor({ state: 'visible', timeout: 10_000 })
  const cardCount = await cards.count()
  const rareCards = await page.locator('.core-sense-card.is-rare').count()
  const bars = await page.locator('.core-sense-stats .mm-familiarity, .core-sense-stats [aria-label^="不熟悉度"]').count()
  record('cards', { cardCount, rareCards, bars })
  assert(cardCount >= 2 && rareCards >= 1, `应有非rare+rare本义卡：${cardCount}/${rareCards}`)
  // 点击非 rare 卡 → core stats clicks 增加
  const nonRare = page.locator('.core-sense-card:not(.is-rare)').first()
  const ratioBefore = await nonRare.locator('.core-sense-stat-ratio').innerText().catch(() => '')
  await nonRare.click({ position: { x: 8, y: 8 } })
  await page.waitForTimeout(500)
  const ratioAfter = await page.locator('.core-sense-card:not(.is-rare) .core-sense-stat-ratio').first().innerText().catch(() => '')
  record('coreCardClick', { ratioBefore: ratioBefore.replace(/\s+/g, ' '), ratioAfter: ratioAfter.replace(/\s+/g, ' ') })
  assert(ratioBefore !== ratioAfter, `点击本义卡应更新不熟度计数：${ratioBefore}→${ratioAfter}`)
  // 点击 rare 卡不应改变（不可点）
  const rareCard = page.locator('.core-sense-card.is-rare').first()
  const rareBefore = await rareCard.locator('.core-sense-stat-ratio').innerText().catch(() => '')
  await rareCard.click({ position: { x: 8, y: 8 } })
  await page.waitForTimeout(400)
  const rareAfter = await page.locator('.core-sense-card.is-rare .core-sense-stat-ratio').first().innerText().catch(() => '')
  record('rareCoreClick', { rareBefore: rareBefore.replace(/\s+/g, ' '), rareAfter: rareAfter.replace(/\s+/g, ' ') })
  assert(rareBefore === rareAfter, 'rare 本义卡不应可点计数')
  // 加权记忆「只记本义」开关
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.weighted-core-only-toggle').waitFor({ state: 'visible', timeout: 10_000 })
  const toggle = page.locator('.weighted-core-only-toggle input')
  const defaultChecked = await toggle.isChecked()
  await toggle.check()
  await page.waitForTimeout(700)
  const dbOn = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const row = await new Promise((res) => { const r = db.transaction('settings', 'readonly').objectStore('settings').get('memory.weightedCoreSenseOnly'); r.onsuccess = () => res(r.result) }); return row?.value ?? null })
  record('weightedToggleOn', { defaultChecked, dbOn, checked: await toggle.isChecked() })
  assert(defaultChecked === false && (await toggle.isChecked()) === true && dbOn === true, '只记本义开关应可开启并持久化')
  const coreOnlyText = (await page.locator('.study-page').innerText()).replace(/\s+/g, ' ')
  const wcCn = (await page.locator('.wc-cn').first().innerText()).replace(/\s+/g, ' ')
  const wcAria = await page.locator('.memory-stage').first().getAttribute('aria-label')
  record('coreOnlyExcludesRare', { text: coreOnlyText.slice(0, 260), wcCn, wcAria, hasNonRare: /fixture第二本义/.test(coreOnlyText), hasRare: /fixture旧本义/.test(coreOnlyText), totalLine: coreOnlyText.match(/\d+ \/ \d+ 个含义/)?.[0] ?? '' })
  assert(/fixture第二本义/.test(wcCn) && !/fixture旧本义/.test(wcCn), `只记本义卡应只显示非rare本义：${wcCn}`)
  assert(!/fixture旧本义/.test(wcAria ?? ''), `页卡 aria 不应指向rare本义：${wcAria}`)
  assert(/0 \/ 1 个含义/.test(coreOnlyText), `只记本义总数应为1，实际 ${coreOnlyText.match(/\d+ \/ \d+ 个含义/)?.[0] ?? ''}`)
  await toggle.uncheck()
  await page.waitForTimeout(700)
  const dbOff = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const row = await new Promise((res) => { const r = db.transaction('settings', 'readonly').objectStore('settings').get('memory.weightedCoreSenseOnly'); r.onsuccess = () => res(r.result) }); return row?.value ?? null })
  record('weightedToggleOff', { dbOff, checked: await toggle.isChecked() })
  assert(dbOff === false && (await toggle.isChecked()) === false, '只记本义中途关闭应恢复')
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    if (!w) return
    await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rareCoreSenses: [{ coreSenseIndex: 1, label: 'fixture旧本义', updatedAt: Date.now() }, { coreSenseIndex: 2, label: 'fixture第二本义', updatedAt: Date.now() }] }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await setSetting('memory.weightedCoreSenseOnly', true)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.waitForFunction(() => /暂无可用本义|已回退普通加权/.test(document.body.innerText), null, { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(300)
  const fallback = await page.evaluate(() => ({ text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 260), hasMemory: !!document.querySelector('.memory-stage, .wc-card'), title: document.querySelector('.study-topbar-title')?.textContent ?? '' }))
  record('noUsableCoreFallback', fallback)
  assert(/该词暂无可用本义，已回退普通加权记忆/.test(fallback.text), `应提示回退普通加权：${fallback.text.slice(0, 180)}`)
  assert(fallback.hasMemory, '回退后应进入普通 c 加权，不黑屏/不空会话')
  await page.screenshot({ path: join(OUT, '37-core-memory-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[core] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[core] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '92-core-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-core-memory.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
