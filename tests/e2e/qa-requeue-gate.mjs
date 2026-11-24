#!/usr/bin/env node
/** 0.3.93 复验：同日回炉/最后词不结束（2词场景）。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, openAnnotation, watchErrors } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[requeue] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page); const rateLogs = []
page.on('console', (m) => { if (/\[rate\]/.test(m.text())) rateLogs.push(m.text()) })
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const cur = () => page.evaluate(() => ({
  word: document.querySelector('.word-text')?.textContent?.trim() ?? '',
  stageBoard: document.querySelectorAll('.board-stage').length,
  stageAnnotation: document.querySelectorAll('.annotation-stage').length,
  summary: document.querySelectorAll('.summary-stage, .study-summary, .done-stage').length,
  progress: document.querySelector('.study-topbar-progress, .progress-fraction')?.textContent?.trim() ?? '',
  body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 180),
}))
const clickRating = async (label) => {
  const cls = label === '认识' ? '.rating-btn--know' : label === '不认识' ? '.rating-btn--unknown' : '.rating-btn--vague'
  const b = page.locator(cls).first()
  await b.waitFor({ state: 'visible', timeout: 5000 })
  for (let i = 0; i < 30; i += 1) { if (!(await b.isDisabled().catch(() => true))) break; await page.waitForTimeout(100) }
  await b.click(); await page.waitForTimeout(1000)
}
const setupPlan = (index) => page.evaluate(async (idx) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const activeId = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
  const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(activeId); r.onsuccess = () => res(r.result) })
  const ids = (plan?.wordIds ?? []).slice(0, 2)
  const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result) })
  const list = ids.length === 2 ? words.filter((w) => ids.includes(w.id)) : words.slice(0, 2)
  const useIds = ids.length === 2 ? ids : list.map((w) => w.id)
  await new Promise((res, rej) => {
    const tx = db.transaction(['plans', 'meta'], 'readwrite')
    const next = { ...(plan ?? { id: '2026-11-21:kaoyan-2027-dagang', date: '2026-11-21', deckId: 'kaoyan-2027-dagang', sources: {}, goals: {}, ratings: {}, createdAt: Date.now() }), wordIds: useIds, index: idx, completedAt: null, updatedAt: Date.now() }
    tx.objectStore('plans').put(next)
    tx.objectStore('meta').put({ key: 'plan.activeId', value: next.id, updatedAt: Date.now() })
    tx.oncomplete = res; tx.onerror = () => rej(tx.error)
  })
  return list.map((w) => w.headword)
}, index)
const start = async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await page.waitForTimeout(800)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
  await page.waitForTimeout(1200)
  if ((await page.locator('.board-stage').count()) === 0 && (await page.locator('.annotation-stage').count()) === 0) {
    await page.waitForTimeout(2000)
  }
}
const dump = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
  const plan = id == null ? undefined : await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
  const logs = await new Promise((res) => { const r = db.transaction('reviewLogs', 'readonly').objectStore('reviewLogs').getAll(); r.onsuccess = () => res(r.result) })
  const last = logs.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0] ?? null
  const diag = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('diag.lastSubmitRating'); r.onsuccess = () => res(r.result?.value ?? null) })
  return {
    plan: plan ? { len: plan.wordIds.length, index: plan.index, completedAt: plan.completedAt ?? null, ids: plan.wordIds } : null,
    log: last ? { id: last.id, wordId: last.wordId, rating: last.rating, scheduleMode: last.scheduleMode ?? null } : null,
    diag,
    ui: {
      word: document.querySelector('.word-text')?.textContent?.trim() ?? '',
      board: document.querySelectorAll('.board-stage').length,
      annotation: document.querySelectorAll('.annotation-stage').length,
      summary: document.querySelectorAll('.summary-stage, .study-summary, .done-stage').length,
      progress: document.querySelector('.study-topbar-progress, .progress-fraction')?.textContent?.trim() ?? '',
      body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220),
    },
  }
})
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  const words = await setupPlan(0); record('plan', { words })
  await start()
  const steps = []
  for (let i = 0; i < 4; i += 1) {
    if ((await page.locator('.board-stage').count()) > 0) await openAnnotation(page)
    const before = await dump()
    const label = i === 0 ? '模糊' : '认识'
    let clicked = ''
    for (const l of [label, '模糊', '不认识']) {
      try { await clickRating(l); clicked = l; break } catch { /* next */ }
    }
    await page.waitForTimeout(1000)
    const after = await dump()
    steps.push({ i, clicked, before, after })
    if (after.ui.summary > 0) break
    if (!(await page.locator('.board-stage, .annotation-stage').count())) break
  }
  record('steps', steps)
  record('rateLogs', rateLogs)
  const second = steps[1]
  record('diagLast', steps.map((st) => st.after?.diag ?? null))
  record('requeueAssert', {
    summary: second?.after?.ui?.summary ?? null,
    plan: second?.after?.plan ?? null,
    rateLogs: rateLogs.slice(-3),
  })
  if (second) {
    const ok = second.after.plan != null && second.after.ui.summary === 0 && second.after.plan.completedAt == null
    if (!ok) throw new Error(`最后回炉词认识后仍结束：${JSON.stringify(second.after)} rateLogs=${JSON.stringify(rateLogs.slice(-3))}`)
  }
  await page.screenshot({ path: join(OUT, '104-requeue-steps-390.png') }).catch(() => {})
  // 最后词：单 technical、今日进度重置为0，点认识不应完成
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await page.waitForTimeout(500)
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const activeId = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
    const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(activeId); r.onsuccess = () => res(r.result) })
    const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').getAll(); r.onsuccess = () => res(r.result) })
    await new Promise((res, rej) => {
      const tx = db.transaction(['states', 'plans', 'meta'], 'readwrite')
      const today = new Date().toISOString().slice(0, 10)
      for (const st of states) tx.objectStore('states').put({ ...st, todayProgress: 0.4, todayProgressDate: today, todayProgressLevel: 1 })
      const target = 'kaoyan-2027-dagang:technical'
      const base = states[0]
      if (base) tx.objectStore('states').put({ ...base, wordId: target, deckId: 'kaoyan-2027-dagang', todayProgress: 0.4, todayProgressDate: today, todayProgressLevel: 1, lastRating: 'vague', sameDayCount: 1, sameDayDate: today, sameDayRequeued: 0, lastReviewedAt: Date.now() - 60000, updatedAt: Date.now() })
      const next = { ...(plan ?? { id: '2026-11-21:kaoyan-2027-dagang', date: '2026-11-21', deckId: 'kaoyan-2027-dagang', sources: {}, goals: {}, ratings: {}, createdAt: Date.now() }), wordIds: [target], index: 0, completedAt: null, sources: { [target]: 'requeue' }, updatedAt: Date.now() }
      tx.objectStore('plans').put(next)
      tx.objectStore('meta').put({ key: 'plan.activeId', value: next.id, updatedAt: Date.now() })
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  await start()
  if ((await page.locator('.board-stage').count()) > 0) await openAnnotation(page)
  const lastBefore = await dump()
  try { await clickRating('认识') } catch { /* ignore */ }
  await page.waitForTimeout(1500)
  const lastAfter = await dump()
  record('lastWord', { before: lastBefore, after: lastAfter })
  await page.screenshot({ path: join(OUT, '104-requeue-last-390.png') }).catch(() => {})
  const lastOk = lastAfter.plan != null && lastAfter.plan.completedAt == null && lastAfter.ui.summary === 0 && !/今日任务完成/.test(lastAfter.ui.body)
  if (!lastOk) throw new Error(`最后词认识后仍结束：${JSON.stringify(lastAfter)}`)
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[requeue] DONE in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[requeue] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '58-requeue-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-requeue.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
