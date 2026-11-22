/** 0.3.28 面板几何/遮挡探针（一次性） */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'
import { ROOT, waitSeededHome, clickHomeLearn, enterAnnotation, openAiPanel, injectPlanForWord, panelText } from './ai-qa-lib.mjs'
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
const BASE = 'http://127.0.0.1:4190/'
const ctx = await chromium.launchPersistentContext('/tmp/qa028-profile', { executablePath: CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: LIB }, viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = ctx.pages()[0]
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await injectPlanForWord(page, 1, { headword: 'address' })
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await waitSeededHome(page)
await clickHomeLearn(page)
await enterAnnotation(page)
const gen = await openAiPanel(page)
await new Promise((r) => setTimeout(r, 1000))
const geo = await page.evaluate(() => {
  const dlg = document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]')
  const btn = [...dlg.querySelectorAll('button')].find((b) => b.textContent.trim() === '开始生成')
  const rating = document.querySelector('.study-rating, .rating-bar, .study-actions')
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height), z: cs.zIndex, pos: cs.position, overflowY: cs.overflowY, scrollH: el.scrollHeight, clientH: el.clientHeight } }
  const bb = btn.getBoundingClientRect()
  const cx = Math.round(bb.x + bb.width / 2), cy = Math.round(bb.y + bb.height / 2)
  const hit = document.elementFromPoint(Math.min(cx, 389), Math.min(cy, 843))
  return {
    viewport: { w: innerWidth, h: innerHeight },
    dialog: r(dlg), mask: r(document.querySelector('.mm-mask')), btn: r(btn), rating: r(rating),
    hitAtBtn: hit ? { tag: hit.tagName, cls: hit.className, text: (hit.textContent || '').trim().slice(0, 20) } : null,
    dialogScrollable: (() => { const body = dlg.querySelector('.mm-dialog-body') || dlg; return { scrollH: body.scrollHeight, clientH: body.clientHeight, overflowY: getComputedStyle(body).overflowY } })(),
    bodyScrollTop: document.scrollingElement.scrollTop,
  }
})
console.log(JSON.stringify(geo, null, 2))
await page.screenshot({ path: join(ROOT, 'docs/assets/qa/ai-0.3.28/P0-panel-geometry.png') })
let clicked = { ok: false }
try {
  await gen.getByRole('button', { name: '开始生成', exact: true }).click({ timeout: 8000 })
  clicked.ok = true
} catch (e) { clicked.error = String(e.message).slice(0, 300) }
await new Promise((r) => setTimeout(r, 800))
clicked.panel = (await panelText(page)).slice(0, 300)
clicked.running = await gen.getByRole('button', { name: '取消生成', exact: true }).isVisible().catch(() => false)
console.log('click=' + JSON.stringify(clicked))
await page.screenshot({ path: join(ROOT, 'docs/assets/qa/ai-0.3.28/P0-panel-after-click.png') })
await ctx.close()
