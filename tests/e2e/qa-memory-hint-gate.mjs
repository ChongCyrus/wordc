#!/usr/bin/env node
/** 0.3.74 task-225：memory 阶段顶部提示；注释/白板/生成式不显示；12px、位置、390 不溢出。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[hint] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const setSettings = async (pairs) => page.evaluate(async (pairs) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res, rej) => { const tx = db.transaction('settings', 'readwrite'); for (const [key, value] of Object.entries(pairs)) tx.objectStore('settings').put({ key, value, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
}, pairs)
const exitMemory = async () => {
  await page.getByRole('button', { name: '退出记忆' }).first().click()
  const dlg = page.getByRole('dialog', { name: /退出记忆/ }).first()
  if (await dlg.count()) await dlg.getByRole('button', { name: /确定|退出/ }).first().click().catch(() => {})
  await page.waitForTimeout(700)
}
const enter = async () => { await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page); await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }) }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(r.result) })
    if (!w) return
    await new Promise((res, rej) => { const tx = db.transaction('words', 'readwrite'); tx.objectStore('words').put({ ...w, rareCoreSenses: [], rareMeaningIds: [], senseMnemonics: [{ coreSenseIndex: 1, label: 'fixture旧本义', text: 'T231段落助记', source: 'manual', updatedAt: Date.now() }] }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await enter()
  const boardHint = await page.locator('.wc-memory-reminder').count()
  await openAnnotation(page)
  const annoHint = await page.locator('.wc-memory-reminder').count()
  record('nonMemory', { boardHint, annoHint })
  assert(boardHint === 0 && annoHint === 0, '白板/注释面不应显示记忆提示')
  // 普通记忆
  await page.getByRole('button', { name: '记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const normal = await page.evaluate(() => {
    const el = document.querySelector('.wc-memory-reminder')
    const list = document.querySelector('.wc-memory-reminder-list')
    const card = document.querySelector('.wc-card')
    const topButtons = Array.from(document.querySelectorAll('.weighted-core-only-toggle, .core-sense-ai-btn'))
    const r = el?.getBoundingClientRect()
    const c = card?.getBoundingClientRect()
    const style = el ? getComputedStyle(el) : null
    const overlap = topButtons.some((b) => { const br = b.getBoundingClientRect(); return r && br.width > 0 && !(r.right <= br.left || br.right <= r.left || r.bottom <= br.top || br.bottom <= r.top) })
    return el ? { text: el.textContent?.trim(), fontSize: style?.fontSize, li: list ? list.querySelectorAll('li').length : 0, strong: el.querySelectorAll('strong').length, color: style?.color, width: Math.round(r.width), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, top: Math.round(r.top), cardTop: c ? Math.round(c.top) : null, overlapTopButtons: overlap, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 } : null
  })
  record('normalMemory', normal)
  await page.screenshot({ path: join(OUT, '47-memory-hint-normal-390.png') }).catch(() => {})
  assert(normal && normal.li === 2 && normal.strong >= 3, `普通记忆应为2条圆圈列表+加粗：${JSON.stringify(normal)}`)
  assert(normal.fontSize === '12px', `提示字号应12px，实际 ${normal.fontSize}`)
  assert(normal.top < (normal.cardTop ?? 0), `提示应在卡片上方：${normal.top} < ${normal.cardTop}`)
  assert(normal.scrollWidth <= normal.clientWidth && !normal.pageOverflow && !normal.overlapTopButtons, `提示不应溢出/遮挡按钮：${JSON.stringify(normal)}`)
  // 普通内存退出→加权
  await exitMemory()
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  const weightedHint = await page.locator('.wc-memory-reminder').count()
  const weightedList = await page.locator('.wc-memory-reminder-list li').count()
  record('weightedMemory', { hintCount: weightedHint, listItems: weightedList })
  assert(weightedHint === 1 && weightedList === 2, '加权记忆应显示2条圆圈提示')
  // 只记本义
  await exitMemory()
  await setSettings({ 'memory.weightedCoreSenseOnly': true })
  await enter(); await openAnnotation(page)
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(300)
  const coreOnly = await page.evaluate(() => {
    const el = document.querySelector('.wc-memory-reminder')
    const btn = document.querySelector('.core-sense-ai-btn')
    const r = el?.getBoundingClientRect(); const br = btn?.getBoundingClientRect()
    return { hintCount: document.querySelectorAll('.wc-memory-reminder').length, listItems: document.querySelectorAll('.wc-memory-reminder-list li').length, strong: el?.querySelectorAll('strong').length ?? 0, text: el?.textContent?.trim(), top: r ? Math.round(r.top) : null, bottom: r ? Math.round(r.bottom) : null, aiBtnTop: br ? Math.round(br.top) : null, aiBtnBottom: br ? Math.round(br.bottom) : null, verticalGap: r && br ? Math.round(r.top - br.bottom) : null, overlapAiBtn: r && br ? !(r.right <= br.left || br.right <= br.left || r.bottom <= br.top || br.bottom <= r.top) : false, overflow: document.documentElement.scrollWidth > innerWidth + 1, className: el?.className, marginTop: el ? getComputedStyle(el).marginTop : '', parent: el?.parentElement ? { cls: el.parentElement.className, top: Math.round(el.parentElement.getBoundingClientRect().top), bottom: Math.round(el.parentElement.getBoundingClientRect().bottom), display: getComputedStyle(el.parentElement).display, justifyContent: getComputedStyle(el.parentElement).justifyContent } : null, stage: el?.closest('.study-body') ? { top: Math.round(el.closest('.study-body').getBoundingClientRect().top), bottom: Math.round(el.closest('.study-body').getBoundingClientRect().bottom), height: Math.round(el.closest('.study-body').getBoundingClientRect().height) } : null }
  })
  record('coreOnlyMemory', coreOnly)
  await page.screenshot({ path: join(OUT, '48-memory-hint-coreonly-390.png') }).catch(() => {})
  assert(coreOnly.hintCount === 1 && coreOnly.listItems === 2 && coreOnly.strong >= 3, '只记本义应显示2条圆圈提示')
  assert(!coreOnly.overlapAiBtn && coreOnly.verticalGap >= 8 && !coreOnly.overflow, `只记本义提示应与 AI 按钮有>=8px间距/不溢出：${JSON.stringify(coreOnly)}`)
  for (const width of [360, 390, 411]) {
    await page.setViewportSize({ width, height: 844 })
    await page.waitForTimeout(350)
    const layout = await page.evaluate(() => {
      const el = document.querySelector('.wc-memory-reminder')
      const toggle = document.querySelector('.weighted-core-only-toggle')
      const aiBtn = document.querySelector('.core-sense-ai-btn')
      const rect = (x) => { const r = x?.getBoundingClientRect(); return r ? { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) } : null }
      const overlap = (a, b) => Boolean(a && b && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top))
      const h = rect(el), t = rect(toggle), b = rect(aiBtn)
      return { hint: h, toggle: t, aiBtn: b, gapAi: h && b ? h.top - b.bottom : null, overlapToggle: overlap(h, t), overlapAi: overlap(h, b), overflow: document.documentElement.scrollWidth > innerWidth + 1, width: innerWidth }
    })
    record(`coreOnlyLayout${width}`, layout)
    await page.screenshot({ path: join(OUT, `52-memory-hint-coreonly-${width}.png`) }).catch(() => {})
    assert(!layout.overlapToggle && !layout.overlapAi && layout.gapAi >= 8 && !layout.overflow, `${width} 提示应与按钮有>=8px间距/不重叠/不溢出：${JSON.stringify(layout)}`)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  // task-235：注释面点本义助记段落只开编辑窗，不开 AI 面板
  await exitMemory()
  const block = page.locator('.core-sense-mnemonic-block').first()
  if (await block.count()) {
    await block.click()
    await page.waitForTimeout(300)
    const editVisible = await page.locator('[data-testid="sense-edit-dialog"]').count()
    const panelVisible = await page.locator('[data-testid="sense-panel"]').count()
    record('annotationBlockClick', { editVisible, panelVisible })
    await page.screenshot({ path: join(OUT, '53-annotation-block-edit-390.png') }).catch(() => {})
    assert(editVisible > 0 && panelVisible === 0, `点段落应只开编辑窗：edit=${editVisible} panel=${panelVisible}`)
    await page.keyboard.press('Escape').catch(() => {})
    await page.locator('[data-testid="sense-edit-dialog"]').count()
    await page.screenshot({ path: join(OUT, '54-annotation-block-closed-390.png') }).catch(() => {})
  }
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[hint] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[hint] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '87-hint-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-memory-hint.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
