import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'
import { ROOT, waitSeededHome, clickHomeLearn, enterAnnotation, openAiPanel, waitPanelTarget, injectPlanForWord, listPacks, sleep } from './ai-qa-lib.mjs'
const CH = join(ROOT, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(ROOT, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(ROOT, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.30')
const ctx = await chromium.launchPersistentContext('/tmp/qa030-profile', { executablePath: CH, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: LIB }, viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = ctx.pages()[0] ?? await ctx.newPage()
let calls = 0
await page.route('**/v1/chat/completions', async (route) => {
  calls += 1
  const req = route.request(); let b = {}; try { b = req.postDataJSON() } catch {}
  const u = String((b?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '')
  const s = u.indexOf('targets = '); const e = u.indexOf('\n请只输出', s)
  let targets = []
  try { targets = JSON.parse(u.slice(s + 10, e > s ? e : undefined)) } catch {}
  const items = targets.map((t, i) => ({ headword: t.headword, examples: [{ en: `QA7-${i + 1} example for ${t.headword}`, cn: `QA7 例句 ${i + 1}` }] }))
  await sleep(300)
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }) })
})
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })
await waitSeededHome(page)
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const packs = await new Promise((res) => { const r = db.transaction('packs', 'readonly').objectStore('packs').getAll(); r.onsuccess = () => res(r.result) })
  const ids = packs.filter((p) => p.draft).map((p) => p.id)
  if (!ids.length) return
  const tx = db.transaction(['packs', 'packItems'], 'readwrite')
  for (const id of ids) { tx.objectStore('packs').delete(id); const all = tx.objectStore('packItems').getAll(); all.onsuccess = () => { for (const it of all.result) if (it.packId === id) tx.objectStore('packItems').delete(it.id) } }
  await new Promise((r) => { tx.oncomplete = r; tx.onerror = r })
})
await injectPlanForWord(page, 1, { headword: 'address' })
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })
await waitSeededHome(page); await clickHomeLearn(page); await enterAnnotation(page)
const gen = await openAiPanel(page); await sleep(700)
await gen.getByLabel('例句生成模式').selectOption('append')
await waitPanelTarget(page, 1, 8000)
const before = await listPacks(page)
const c0 = calls
await gen.getByRole('button', { name: '开始生成', exact: true }).click()
const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
const shown = await review.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
const items = shown ? await review.getByRole('checkbox', { name: /^选择 / }).count() : 0
let err = null
if (shown) await review.getByRole('button', { name: /^保存已选/ }).dblclick({ delay: 40, timeout: 15000 }).catch((e) => { err = String(e.message).slice(0, 200) })
const closed = await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 20000 }).then(() => true).catch(() => false)
await sleep(1500)
const after = await listPacks(page)
const totals = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const all = await new Promise((res) => { const r = db.transaction('packItems', 'readonly').objectStore('packItems').getAll(); r.onsuccess = () => res(r.result) })
  return { total: all.length, qa7: all.filter((i) => /QA7/.test(JSON.stringify(i.payload ?? {}))).map((i) => ({ status: i.status, packId: i.packId })) }
})
const ann = await page.evaluate(() => [...document.querySelectorAll('.example-item')].map((e) => e.innerText.replace(/\s+/g, ' ')).filter((t) => /QA7/.test(t)))
console.log(JSON.stringify({ shown, items, calls: calls - c0, err, closed, packDelta: after.length - before.length, packs: after.filter((p) => p.name === 'AI 生成').map((p) => ({ id: p.id, status: p.status })), totals, ann }, null, 2))
await page.screenshot({ path: join(OUT, 'S1-06-dblclick-save.png') })
await ctx.close()
