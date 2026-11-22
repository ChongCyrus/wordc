#!/usr/bin/env node
/** 0.3.72 task-217/218：core-only 内容展示/数量0隐藏/普通不显示/AI三动作保存/设置两项/390；encounters 同session一次/新session+1。mock AI。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[core72] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
let requests = 0
await page.route('**/chat/completions', async (route) => {
  requests += 1
  const body = route.request().postData() ?? ''
  const payload = body.includes('例句')
    ? { examples: [{ en: 'CORE72 example sentence', cn: '本义例句一' }, { en: 'CORE72 second example', cn: '本义例句二' }, { en: 'CORE72 third example', cn: '本义例句三' }] }
    : body.includes('词组')
      ? { phrases: [{ en: 'CORE72 phrase', cn: '本义词组一' }, { en: 'CORE72 phrase two', cn: '本义词组二' }, { en: 'CORE72 phrase three', cn: '本义词组三' }] }
      : { mnemonic: 'CORE72本义助记文本' }
  await sleep(150)
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(payload) } }] }) })
})
const setSettings = async (pairs) => page.evaluate(async (pairs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries(pairs)) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, pairs)
const dbStats = async () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const state = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
  const core = state?.coreSenseStats ?? {}
  const coreVals = Object.values(core).map((v) => ({ clicks: v?.clicks ?? 0, encounters: v?.encounters ?? 0 }))
  const meaningVals = Object.values(state?.meaningStats ?? {}).map((v) => ({ clicks: v?.clicks ?? 0, encounters: v?.encounters ?? 0 }))
  return { coreVals, meaningVals }
})
const enter = async () => { await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page); await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page) }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const now = Date.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['packs', 'packItems', 'words', 'settings'], 'readwrite')
      tx.objectStore('packs').put({ id: 'fixture-core2', name: 'fixture second core', kind: 'semantics', formatVersion: 1, checksum: 'fixturecore2', source: 'builtin', status: 'applied', deckId: 'kaoyan-2027-dagang', promptVersion: 'v4.0-semantics-grouped', counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 }, createdAt: now, updatedAt: now })
      tx.objectStore('packItems').put({ id: 'fixture-core2:1', packId: 'fixture-core2', seq: 1, wordId: 'kaoyan-2027-dagang:denounce', headwordLower: 'denounce', payload: { headword: 'denounce', coreSenses: [{ index: 1, label: 'fixture第二本义' }], meaningMap: [] }, status: 'applied', createdAt: now, appliedAt: now })
      const get = tx.objectStore('words').get('kaoyan-2027-dagang:denounce')
      get.onsuccess = () => { const w = get.result; if (w) { const next = { ...w, rareCoreSenses: [] }; tx.objectStore('words').put(next) } }
      for (const [key, value] of Object.entries({ 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-TEST', 'ai.model': 'deepseek-chat', 'memory.weightedCoreSenseOnly': true, 'memory.coreSenseExampleCount': 2, 'memory.coreSensePhraseCount': 2 })) tx.objectStore('settings').put({ key, value, updatedAt: now })
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  const pre = await dbStats()
  await openAnnotation(page)
  const first = await dbStats()
  const coreDelta = first.coreVals.map((v, i) => v.encounters - (pre.coreVals[i]?.encounters ?? 0)).filter((d) => d > 0)
  const meaningDelta = first.meaningVals.map((v, i) => v.encounters - (pre.meaningVals[i]?.encounters ?? 0)).filter((d) => d > 0)
  record('firstEncounters', { pre, first, coreDelta, meaningDelta })
  assert(coreDelta.length > 0 && coreDelta.every((d) => d === 1), `首次注释 core encounters 应+1：${JSON.stringify(coreDelta)}`)
  assert(meaningDelta.length > 0 && meaningDelta.every((d) => d === 1), `c encounters 也应按进入+1（同机制）：${JSON.stringify(meaningDelta)}`)
  // 同 session 退出记忆回注释：不再 +1
  await page.getByRole('button', { name: '记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.getByRole('button', { name: '退出记忆' }).first().click()
  const confirm = page.getByRole('dialog', { name: /退出记忆/ }).first()
  if (await confirm.count()) await confirm.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
  await page.waitForTimeout(800)
  const same = await dbStats()
  const coreSame = same.coreVals.filter((v) => v.encounters > 0)
  record('sameSessionReenter', { core: coreSame })
  assert(coreSame.length > 0 && coreSame[0].encounters === 1, `同 session 再进注释不应+1：${JSON.stringify(coreSame)}`)
  // 新 session（回首页再进学习）：再 +1
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page); await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  const next = await dbStats()
  const coreNext = next.coreVals.filter((v) => v.encounters > 1)
  record('newSession', { core: coreNext })
  assert(coreNext.length > 0, `新 session 应再+1：${JSON.stringify(next.coreVals)}`)
  // task-217：只记本义页内容与 AI 三动作
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const beforeContent = (await page.locator('.memory-stage').innerText()).replace(/\s+/g, ' ')
  const titleBefore = await page.locator('.study-topbar-title').innerText()
  record('coreOnlyBeforeContent', { text: beforeContent.slice(0, 220), title: titleBefore })
  const unitsExpected = 2
  assert(new RegExp(`0 / ${unitsExpected} 个含义`).test(titleBefore), `只记本义 total 应为可用本义数 ${unitsExpected}，实际 ${titleBefore}`)
  await page.screenshot({ path: join(OUT, '39-core-before-save-390.png') }).catch(() => {})
  let aiPanelShot = false
  for (const [btn, saveLabel] of [['AI 生成本义助记', '保存本义助记'], ['AI 生成本义例句', '保存本义例句'], ['AI 生成本义词组', '保存本义词组']]) {
    await page.getByRole('button', { name: 'AI 本义内容' }).first().click()
    const dlg = page.locator('.mm-dialog').filter({ hasText: '本义 AI' }).first()
    await dlg.waitFor({ state: 'visible', timeout: 10_000 })
    if (!aiPanelShot) { await page.waitForTimeout(700); await page.screenshot({ path: join(OUT, '40-core-ai-panel-390.png') }).catch(() => {}); aiPanelShot = true }
    await dlg.getByRole('button', { name: btn }).click()
    await dlg.getByRole('button', { name: saveLabel }).waitFor({ state: 'visible', timeout: 10_000 })
    await dlg.getByRole('button', { name: saveLabel }).click()
    await page.waitForTimeout(800)
  }
  await page.waitForFunction(() => /CORE72本义助记文本/.test(document.body.innerText), null, { timeout: 5000 })
  const content = (await page.locator('.memory-stage').innerText()).replace(/\s+/g, ' ')
  record('coreOnlyContent', { text: content.slice(0, 400), hasMnemonic: /CORE72本义助记文本/.test(content), hasExample: /CORE72 example sentence/.test(content), hasPhrase: /CORE72 phrase/.test(content), requests })
  assert(/CORE72本义助记文本/.test(content), '只记本义页应显示本义助记')
  assert(/CORE72 example sentence/.test(content) && /CORE72 phrase/.test(content), `只记本义页应显示代表例句/词组：${content.slice(0, 300)}`)
  const contrast = await page.evaluate(() => {
    const el = document.querySelector('.wc-info-core-mnemonic')
    if (!el) return null
    const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b] = m[1].split(',').map(Number); return { r, g, b } }
    const lum = ({ r, g, b }) => { const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
    const fg = parse(getComputedStyle(el).color)
    let bgEl = el
    let bg = null
    while (bgEl && !bg) { const c = getComputedStyle(bgEl).backgroundColor; if (c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent') bg = parse(c); bgEl = bgEl.parentElement }
    if (!fg || !bg) return null
    const l1 = lum(fg), l2 = lum(bg); const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
    return { color: getComputedStyle(el).color, background: getComputedStyle(bgEl ?? el).backgroundColor, ratio: Math.round(ratio * 100) / 100 }
  })
  record('coreMnemonicContrast', contrast)
  assert(contrast && contrast.ratio >= 4.5, `本义助记对比度应≥4.5，实际 ${JSON.stringify(contrast)}`)
  await page.screenshot({ path: join(OUT, '39-core-after-save-390.png') }).catch(() => {})
  await page.getByRole('button', { name: '退出记忆' }).first().click()
  const exitDlg = page.getByRole('dialog', { name: /退出记忆/ }).first()
  if (await exitDlg.count()) await exitDlg.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
  await page.waitForTimeout(700)
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => /CORE72本义助记文本/.test(document.body.innerText), null, { timeout: 5000 })
  const reentered = (await page.locator('.memory-stage').innerText()).replace(/\s+/g, ' ')
  record('reenterPersists', { hasMnemonic: /CORE72本义助记文本/.test(reentered), hasExample: /CORE72 example sentence/.test(reentered), hasPhrase: /CORE72 phrase/.test(reentered) })
  assert(/CORE72本义助记文本/.test(reentered) && /CORE72 example sentence/.test(reentered) && /CORE72 phrase/.test(reentered), `重进只记本义仍应显示保存内容：${reentered.slice(0, 260)}`)
  await page.screenshot({ path: join(OUT, '39-core-reenter-390.png') }).catch(() => {})
  // fixture 兜底：reload 前清 rareCoreSenses/rareMeaningIds，避免默认排除 rare 回退普通加权
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
    const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
    const target = plan?.wordIds?.indexOf('kaoyan-2027-dagang:denounce') ?? -1
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    await new Promise((res, rej) => { const tx = db.transaction(['words', 'plans', 'settings'], 'readwrite'); if (w) tx.objectStore('words').put({ ...w, rareCoreSenses: [], rareMeaningIds: [] }); if (plan && target >= 0) tx.objectStore('plans').put({ ...plan, index: target }); tx.objectStore('settings').put({ key: 'memory.weightedCoreSenseOnly', value: true, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page); await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.getByRole('button', { name: '加权记忆' }).first().click(); await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => /CORE72本义助记文本/.test(document.body.innerText), null, { timeout: 5000 })
  const reloaded = (await page.locator('.memory-stage').innerText()).replace(/\s+/g, ' ')
  const reloadDiag = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
    const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
    const setting = await new Promise((res) => { const r = db.transaction('settings', 'readonly').objectStore('settings').get('memory.weightedCoreSenseOnly'); r.onsuccess = () => res(r.result?.value) })
    return { planIndex: plan?.index ?? null, currentWordId: plan?.wordIds?.[plan?.index ?? -1] ?? null, coreOnly: setting }
  })
  record('pageReloadDiag', { headword: await page.locator('.wc-word').first().innerText().catch(() => ''), meaning: await page.locator('.wc-cn').first().innerText().catch(() => ''), title: await page.locator('.study-topbar-title').innerText().catch(() => ''), hasNoUsableToast: /暂无可用本义|已回退普通加权/.test(await page.locator('body').innerText()), ...reloadDiag })
  record('pageReloadPersists', { hasMnemonic: /CORE72本义助记文本/.test(reloaded), hasExample: /CORE72 example sentence/.test(reloaded), hasPhrase: /CORE72 phrase/.test(reloaded) })
  assert(/CORE72本义助记文本/.test(reloaded) && /CORE72 example sentence/.test(reloaded) && /CORE72 phrase/.test(reloaded), `页面重载后仍应显示保存内容：${reloaded.slice(0, 240)}`)
  await page.screenshot({ path: join(OUT, '39-core-reload-390.png') }).catch(() => {})
  // 数量设0：例句/词组隐藏
  await setSettings({ 'memory.coreSenseExampleCount': 0, 'memory.coreSensePhraseCount': 0 })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page); await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.getByRole('button', { name: '加权记忆' }).first().click(); await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const zero = (await page.locator('.memory-stage').innerText()).replace(/\s+/g, ' ')
  record('countsZero', { hasExample: /CORE72 example sentence/.test(zero), hasPhrase: /CORE72 phrase/.test(zero), text: zero.slice(0, 220) })
  assert(!/CORE72 example sentence/.test(zero) && !/CORE72 phrase/.test(zero), '数量0时应隐藏例句/词组')
  await page.getByRole('button', { name: 'AI 本义内容' }).first().click()
  const zeroDlg = page.locator('.mm-dialog').filter({ hasText: '本义 AI' }).first()
  await zeroDlg.waitFor({ state: 'visible', timeout: 5000 })
  const zeroPanel = (await zeroDlg.innerText()).replace(/\s+/g, ' ')
  const exBtn = zeroDlg.getByRole('button', { name: 'AI 生成本义例句' }).first()
  const phBtn = zeroDlg.getByRole('button', { name: 'AI 生成本义词组' }).first()
  record('zeroPanel', { exampleDisabled: await exBtn.isDisabled(), phraseDisabled: await phBtn.isDisabled(), text: zeroPanel.slice(0, 200) })
  assert(await exBtn.isDisabled() && await phBtn.isDisabled(), '数量0时 AI 例句/词组按钮应置灰')
  assert(/例句数量为 0|词组数量为 0/.test(zeroPanel), `数量0应有说明：${zeroPanel.slice(0, 160)}`)
  await zeroDlg.getByRole('button', { name: '关闭' }).click().catch(() => {})
  // 设置页两项
  await page.goto(`${BASE}#/me/settings`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const settingsText = await page.locator('body').innerText()
  record('settingsItems', { example: /本义例句数量/.test(settingsText), phrase: /本义词组数量/.test(settingsText) })
  assert(/本义例句数量/.test(settingsText) && /本义词组数量/.test(settingsText), '设置页应有本义例句/词组数量两项')
  // 普通 c 加权不显示 core 内容
  await setSettings({ 'memory.weightedCoreSenseOnly': false, 'memory.coreSenseExampleCount': 2, 'memory.coreSensePhraseCount': 2 })
  await enter(); await page.getByRole('button', { name: '加权记忆' }).first().click(); await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const normal = (await page.locator('.memory-stage').innerText()).replace(/\s+/g, ' ')
  record('normalWeightedNoCore', { hasMnemonic: /CORE72本义助记文本/.test(normal), hasPhrase: /CORE72 phrase/.test(normal) })
  assert(!/CORE72本义助记文本/.test(normal) && !/CORE72 phrase/.test(normal), '普通 c 加权不应显示 core 内容')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[core72] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[core72] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '90-core72-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-core72.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
