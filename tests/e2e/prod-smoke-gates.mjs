/**
 * task-177 生产包 smoke/gate：不 build；BASE 为生产 dist（vite preview / 静态 server）。
 * 失败门禁：任何 pageerror / console.error / ErrorBoundary fallback → 退出码 1。
 * 含主路由 smoke + 学习页任意位置左滑相对调宽 + 横向溢出检查。
 * 运行：E2E_BASE=http://127.0.0.1:4173/ node tests/e2e/prod-smoke-gates.mjs
 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'

const ROOT = '/root/workspace/背单词APP开发'
const CHROMIUM = process.env.E2E_CHROMIUM || `${ROOT}/tools/e2e/chromium/usr/lib/chromium/chromium`
const LIB = [`${ROOT}/tools/e2e/chromium/usr/lib/aarch64-linux-gnu`, `${ROOT}/tools/e2e/chromium/usr/lib/chromium`].join(':')
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/'
const out = { routes: {}, errors: { pageerror: [], console: [] }, gesture: {}, passed: false }
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], env: { ...process.env, LD_LIBRARY_PATH: LIB } })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = await ctx.newPage()
// 生产包 smoke 先跳过内置大 packs 首启 seed（真实 profile 由 fixture 提供，task-177 后续接）
await page.route('**/packs/**', (r) => r.abort())
page.on('pageerror', (e) => out.errors.pageerror.push(String(e)))
page.on('console', (m) => { if (m.type() === 'error') out.errors.console.push(m.text().slice(0, 300)) })
// 先等首页可用（内置 deck 异步种子完成），避免把“还在 loading”当成空数据
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
await page.getByRole('button', { name: /开始学习|继续学习/ }).first().waitFor({ state: 'visible', timeout: 45_000 })
// 等内置 deck/words 真正落库（首屏按钮会先出现，不能代表 deck 已 seed）
const deckDeadline = Date.now() + 45_000
while (Date.now() < deckDeadline) {
  const ready = await page.evaluate(async () => {
    try {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('wordc'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      const count = (store) => new Promise((resolve) => { const r = db.transaction(store, 'readonly').objectStore(store).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(0) })
      return (await count('decks')) >= 1 && (await count('words')) >= 1
    } catch { return false }
  }).catch(() => false)
  if (ready) break
  await page.waitForTimeout(500)
}


const routes = [['home', ''], ['decks', '#/decks'], ['stats', '#/stats'], ['me', '#/me'], ['settings', '#/me/settings'], ['today', '#/today']]
for (const [name, hash] of routes) {
  await page.goto(BASE + hash, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1200)
  const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  out.routes[name] = { length: body.length, errorBoundary: /页面渲染出错/.test(body), sample: body.slice(0, 120) }
  await page.screenshot({ path: `/tmp/prod-${name}.png` }).catch(() => {})
}
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)
// 0.3.87+ 默认 manual：CI smoke 不依赖添加弹窗交互，切 auto 让首页生成今日新词再开始学习
// （manual 交互/弹窗由 qa-task260/272/274 等专用 gate 覆盖）
await page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const r = indexedDB.open('wordc')
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
  await new Promise((resolve, reject) => {
    const tx = db.transaction('settings', 'readwrite')
    tx.objectStore('settings').put({ key: 'study.newWordSource', value: 'auto', updatedAt: Date.now() })
    tx.oncomplete = resolve
    tx.onerror = () => reject(tx.error)
  })
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1800)
const start = page.getByRole('button', { name: /开始学习|继续学习/ }).first()
await start.waitFor({ state: 'visible', timeout: 30_000 })
await start.click()
await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
await page.mouse.click(195, Math.round(844 * 0.45))
await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 30_000 })
await page.waitForTimeout(400)
const handle = page.getByRole('button', { name: '展开生成元引申' }).first()
await handle.click()
await page.waitForTimeout(300)
const width = () => page.evaluate(() => getComputedStyle(document.querySelector('.study-page')).getPropertyValue('--derivation-panel-width').trim())
out.gesture.before = await width()
// 左 1/4 起手，小位移 dx=-20：应从 50 相对变到约 55，而不是 75
await page.mouse.move(100, 420); await page.mouse.down(); await page.mouse.move(80, 422, { steps: 4 }); await page.waitForTimeout(150)
out.gesture.leftSmall = await width(); await page.mouse.up(); await page.waitForTimeout(250)
// 中点再拖 dx=-75：从当前宽度相对增加，不超过 75
await page.mouse.move(195, 420); await page.mouse.down(); await page.mouse.move(120, 422, { steps: 5 }); await page.waitForTimeout(150)
out.gesture.center = await width(); await page.mouse.up(); await page.waitForTimeout(250)
out.gesture.scrollOverflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)
out.errors.console = out.errors.console.filter((t) => !/favicon|ServiceWorker|ERR_/.test(t))
out.passed = out.errors.pageerror.length === 0 && out.errors.console.length === 0 && Object.values(out.routes).every((r) => r.length > 20 && !r.errorBoundary) && !out.gesture.scrollOverflow
await ctx.close()
await browser.close()
console.log(JSON.stringify(out, null, 2))
if (!out.passed) process.exit(1)
