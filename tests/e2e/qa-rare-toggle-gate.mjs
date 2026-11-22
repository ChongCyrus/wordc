#!/usr/bin/env node
/** task-215：本义卡「标记不常考」→默认隐藏/计数+1；显示→取消标记；按钮不误触整卡/不打开编辑；失败 toast；390。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, sleep, watchErrors, assert } from './qa-gate-lib.mjs'

const started = Date.now()
const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[rare-toggle] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  // 注入第二个非 rare 本义（索引2）并清空 rareCoreSenses
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const now = Date.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['packs', 'packItems', 'words'], 'readwrite')
      tx.objectStore('packs').put({ id: 'fixture-core2', name: 'fixture second core', kind: 'semantics', formatVersion: 1, checksum: 'fixturecore2', source: 'builtin', status: 'applied', deckId: 'kaoyan-2027-dagang', promptVersion: 'v4.0-semantics-grouped', counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 }, createdAt: now, updatedAt: now })
      tx.objectStore('packItems').put({ id: 'fixture-core2:1', packId: 'fixture-core2', seq: 1, wordId: 'kaoyan-2027-dagang:denounce', headwordLower: 'denounce', payload: { headword: 'denounce', coreSenses: [{ index: 1, label: 'fixture第二本义' }], meaningMap: [] }, status: 'applied', createdAt: now, appliedAt: now })
      const get = tx.objectStore('words').get('kaoyan-2027-dagang:denounce')
      get.onsuccess = () => { const w = get.result; if (w) { const next = { ...w }; delete next.rareCoreSenses; tx.objectStore('words').put(next) } }
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  const cards = page.locator('.core-sense-card')
  await cards.first().waitFor({ state: 'visible', timeout: 10_000 })
  const initial = { cards: await cards.count(), hidden: await page.locator('.annotation-hidden-rare').count(), rareCards: await page.locator('.core-sense-card.is-rare').count() }
  record('initial', initial)
  assert(initial.cards === 2 && initial.rareCards === 0, `初始应2个普通本义卡：${JSON.stringify(initial)}`)
  const firstCard = cards.first()
  const ratioBefore = await firstCard.locator('.core-sense-stat-ratio').innerText()
  const markBtn = firstCard.locator('.rare-toggle-btn').first()
  const markLabel = await markBtn.innerText()
  assert(markLabel.includes('标记不常考'), `初始按钮应为标记不常考，实际 ${markLabel}`)
  await markBtn.click()
  await page.waitForTimeout(700)
  const marked = {
    cards: await page.locator('.core-sense-card').count(),
    hiddenText: (await page.locator('.annotation-hidden-rare').first().innerText().catch(() => '')).trim(),
    ratio: (await page.locator('.core-sense-card').first().locator('.core-sense-stat-ratio').innerText().catch(() => '')).replace(/\s+/g, ' '),
    dialog: await page.locator('.mm-dialog').count(),
  }
  record('afterMark', { ...marked, ratioBefore: ratioBefore.replace(/\s+/g, ' ') })
  assert(/已隐藏 2 条不常考/.test(marked.hiddenText), `标记后应默认隐藏且计数1（含 fixture rare c）：${marked.hiddenText}`)
  assert(marked.cards === 1, `标记后卡片应隐藏1张，实际 ${marked.cards}`)
  assert(marked.ratio === ratioBefore.replace(/\s+/g, ' '), `按钮不应误触整卡clicks：${ratioBefore}→${marked.ratio}`)
  assert(marked.dialog === 0, '点标记按钮不应打开编辑弹窗')
  // 点此显示 → 取消标记（二次确认）
  await page.locator('.annotation-hidden-rare').first().click()
  await page.waitForTimeout(300)
  const shown = { cards: await page.locator('.core-sense-card').count(), rareCards: await page.locator('.core-sense-card.is-rare').count(), text: (await page.locator('.annotation-hidden-rare').first().innerText()).trim() }
  record('shown', shown)
  assert(shown.cards === 2 && shown.rareCards === 1 && /已临时显示 2 条/.test(shown.text), `显示后应有1张rare卡：${JSON.stringify(shown)}`)
  const cancelBtn = page.locator('.core-sense-card.is-rare .rare-toggle-btn').first()
  assert((await cancelBtn.innerText()).includes('取消不常考'), '已标记载应显示取消不常考')
  await cancelBtn.click()
  const confirm = page.getByRole('dialog', { name: '取消本义不常考标记？' }).first()
  await confirm.waitFor({ state: 'visible', timeout: 5000 })
  await confirm.getByRole('button', { name: '确定' }).click()
  await page.waitForTimeout(800)
  const canceled = { rareCards: await page.locator('.core-sense-card.is-rare').count(), hidden: await page.locator('.annotation-hidden-rare').count(), markText: (await page.locator('.core-sense-card .rare-toggle-btn').first().innerText()).trim() }
  record('canceled', canceled)
  assert(canceled.rareCards === 0 && canceled.markText.includes('标记不常考'), `取消后应恢复普通：${JSON.stringify(canceled)}`)
  // 失败 toast：临时让 words.put 抛错
  await page.evaluate(() => { const proto = IDBObjectStore.prototype; const orig = proto.put; window.__origPut = orig; proto.put = function (...args) { if (this.name === 'words') throw new Error('fixture put fail'); return orig.apply(this, args) } })
  await page.locator('.core-sense-card .rare-toggle-btn').first().click()
  await page.waitForFunction(() => /标记本义不常考失败/.test(document.body.innerText), null, { timeout: 5000 }).catch(() => {})
  const failToast = (await page.locator('body').innerText()).match(/标记本义不常考失败/)?.[0] ?? ''
  record('failureToast', { failToast })
  await page.evaluate(() => { if (window.__origPut) IDBObjectStore.prototype.put = window.__origPut })
  assert(failToast.length > 0, '写入失败应提示「标记本义不常考失败」')
  const layout = await page.evaluate(() => ({ pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, rareBtns: document.querySelectorAll('.rare-toggle-btn').length }))
  record('layout390', layout)
  assert(!layout.pageOverflow && layout.rareBtns >= 2, `390 不应溢出且本义卡有按钮：${JSON.stringify(layout)}`)
  await page.screenshot({ path: join(OUT, '38-rare-core-toggle-390.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource|fixture put fail/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[rare-toggle] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[rare-toggle] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '91-rare-toggle-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-rare-toggle.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
