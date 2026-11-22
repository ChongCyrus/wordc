#!/usr/bin/env node
/** 0.3.78 加权 B 公式：默认 min1/max10/k1/base3；f0→1、f.5→3、f1→10；k0→base；core-only 同步；设置文案。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[wb] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setSettings = async (pairs) => page.evaluate(async (pairs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries(pairs)) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, pairs)
const setF = async (f) => page.evaluate(async (f) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const wordId = 'kaoyan-2027-dagang:denounce'
  const word = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get(wordId); r.onsuccess = () => res(r.result) })
  const state = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').get(wordId); r.onsuccess = () => res(r.result) })
  if (!word || !state) return false
  const clicks = f === 0 ? 0 : f === 0.5 ? 1 : 2, encounters = 2
  const meaningStats = { ...(state.meaningStats ?? {}) }
  for (const m of word.meanings ?? []) { const id = m.id ?? m.meaningId; if (id) meaningStats[id] = { clicks, encounters, updatedAt: Date.now() } }
  const coreSenseStats = { ...(state.coreSenseStats ?? {}) }
  coreSenseStats[JSON.stringify(['fixture旧本义', 1])] = { clicks, encounters, updatedAt: Date.now() }
  await new Promise((res, rej) => { const tx = db.transaction(['states', 'meta'], 'readwrite'); tx.objectStore('states').put({ ...state, meaningStats, coreSenseStats, updatedAt: Date.now() }); tx.objectStore('meta').delete('session:' + wordId); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  return true
}, f)
const enter = async () => { await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page); await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page) }
const readTotal = async () => {
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(300)
  const text = (await page.locator('.wc-count').first().innerText()).replace(/\s+/g, ' ')
  const total = Number(text.split('/')[1]?.trim() ?? -1)
  const body = (await page.locator('.memory-stage').innerText()).replace(/\s+/g, ' ')
  return { text, total, body: body.slice(0, 120) }
}
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    if (w) await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rareCoreSenses: [], rareMeaningIds: [] }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries({ 'memory.totalRepeats': 3, 'memory.weightedMin': 1, 'memory.weightedMax': 10, 'memory.weightedK': 1, 'memory.weightedCoreSenseOnly': false })) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await enter() // 创建 state
  const cases = [
    [0, 1], [0.5, 3], [1, 10],
  ]
  for (const [f, expected] of cases) {
    await enter()
    await setF(f)
    const dump = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const st = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) }); return { stats: st?.meaningStats ?? null, core: st?.coreSenseStats ?? null } })
    record(`debugF${f}`, dump)
    const t = await readTotal()
    record(`f${f}`, { ...t, expected })
    assert(t.total === expected, `f=${f} 应 total=${expected}，实际 ${t.total}（${t.text}）`)
    await page.getByRole('button', { name: '退出记忆' }).first().click()
    const dlg = page.getByRole('dialog', { name: /退出记忆/ }).first()
    if (await dlg.count()) await dlg.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
    await page.waitForTimeout(500)
  }
  // k=0 → base
  await setSettings({ 'memory.weightedK': 0 }); await enter(); await setF(1); const k0 = await readTotal()
  record('k0', { ...k0, expected: 3 })
  assert(k0.total === 3, `k=0 应 base=3，实际 ${k0.total}`)
  await page.getByRole('button', { name: '退出记忆' }).first().click()
  const d2 = page.getByRole('dialog', { name: /退出记忆/ }).first(); if (await d2.count()) await d2.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
  await page.waitForTimeout(500)
  // core-only f=.5 → 3
  await setSettings({ 'memory.weightedK': 1, 'memory.weightedCoreSenseOnly': true })
  await enter(); await setF(0.5)
  const core = await readTotal()
  record('coreOnlyF05', { ...core, expected: 3 })
  assert(core.total === 3, `core-only f=.5 应3，实际 ${core.total}`)
  await page.screenshot({ path: join(OUT, '59-weighted-b-coreonly-390.png') }).catch(() => {})
  // 设置文案
  await page.goto(`${BASE}#/me/settings`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const settingsText = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('settingsLabels', { lower: /加权记忆下界（最熟）/.test(settingsText), upper: /加权记忆上界（最不熟）/.test(settingsText), neutral: /中性点/.test(settingsText), text: settingsText.match(/加权记忆[^。]{0,100}/gi)?.slice(0, 3) })
  assert(/加权记忆下界（最熟）/.test(settingsText) && /加权记忆上界（最不熟）/.test(settingsText) && /中性点/.test(settingsText), '设置应有下界/上界/中性点文案')
  await page.screenshot({ path: join(OUT, '60-weighted-b-settings-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[wb] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[wb] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '83-weightedb-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-weightedb.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
