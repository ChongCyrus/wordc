import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'
import { ROOT, waitSeededHome, clickHomeLearn, enterAnnotation, openAiPanel, waitPanelTarget, injectPlanForWord, closeDialogs, sleep } from './ai-qa-lib.mjs'
const CH = join(ROOT, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(ROOT, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(ROOT, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.30')
const ctx = await chromium.launchPersistentContext('/tmp/qa030-profile', { executablePath: CH, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: LIB }, viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = ctx.pages()[0] ?? await ctx.newPage()
const bag = { errors: [], pageErrors: [] }
page.on('console', (m) => { if (m.type() === 'error') bag.errors.push(m.text().slice(0, 300)) })
page.on('pageerror', (e) => bag.pageErrors.push(String(e).slice(0, 500)))
let mode = '401', calls = 0
await page.route('**/v1/chat/completions', async (route) => {
  calls += 1
  if (mode === '401') return route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'invalid api key' } }) })
  const req = route.request(); let b = {}; try { b = req.postDataJSON() } catch {}
  const u = String((b?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '')
  const s = u.indexOf('targets = '); const e = u.indexOf('\n请只输出', s)
  let targets = []
  try { targets = JSON.parse(u.slice(s + 10, e > s ? e : undefined)) } catch {}
  const items = targets.map((t, i) => ({ headword: t.headword, examples: [{ en: `QA6-${i + 1} example for ${t.headword}`, cn: `QA6 例句 ${i + 1}` }] }))
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items }) } }] }) })
})
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })
await waitSeededHome(page)
await injectPlanForWord(page, 1, { headword: 'address' })
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })
await waitSeededHome(page); await clickHomeLearn(page); await enterAnnotation(page)
let gen = await openAiPanel(page); await sleep(700)
// examples append
await gen.getByLabel('例句生成模式').selectOption('append')
await waitPanelTarget(page, 1, 8000)
let t0 = calls
await gen.getByRole('button', { name: '开始生成', exact: true }).click()
await sleep(2000)
let panel = (await gen.innerText()).replace(/\s+/g, ' ')
const toast = await page.evaluate(() => [...document.querySelectorAll('.mm-toast')].map((e) => e.textContent.trim()))
const err401 = { panel: panel.slice(0, 700), toast, calls: calls - t0, hasHttp401: /HTTP\s*401/.test(panel + ' ' + toast.join(' ')) }
await page.screenshot({ path: join(OUT, 'S6-01-error-401.png') })
// append review label
mode = 'ok'; t0 = calls
await gen.getByRole('button', { name: '开始生成', exact: true }).click()
const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
const shown = await review.waitFor({ state: 'visible', timeout: 15000 }).then(() => true).catch(() => false)
const reviewText = shown ? (await review.innerText()).replace(/\s+/g, ' ') : ''
await page.screenshot({ path: join(OUT, 'S6-02-append-review.png') })
const append = { shown, calls: calls - t0, replaceNotice: /将替换/.test(reviewText), text: reviewText.slice(0, 350) }
if (shown) await review.getByRole('button', { name: '关闭', exact: true }).click()
await closeDialogs(page)
console.log(JSON.stringify({ err401, append, bag }, null, 2))
await ctx.close()
