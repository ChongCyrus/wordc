/**
 * QA gate 公共库（task-177）：生产包 E2E 的浏览器/数据/手势辅助。
 *
 * 约束：
 * - 只读审计，不改 src；
 * - 生产包用 vite preview 的 dist（不复用 dev server）；
 * - 真实数据优先用 QA_PROFILE（持久化 profile），无 profile 时可回退 fresh seed。
 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { loadMinimalFixture } from './qa-fixture.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..')
const TOOLS = join(ROOT, 'tools/e2e')
export const CHROMIUM = process.env.E2E_CHROMIUM || join(TOOLS, 'chromium/usr/lib/chromium/chromium')
export const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
export const BASE = (process.env.QA_BASE || process.env.E2E_BASE || 'http://127.0.0.1:4173/').replace(/\/?$/, '/')
export const OUT = process.env.QA_OUT || join(ROOT, 'docs/assets/e2e/qa-gate')
export const PROFILE = process.env.QA_PROFILE || ''
export const FIXTURE = process.env.QA_FIXTURE || ''
export const VIEWPORT = { width: 390, height: 844 }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function watchErrors(page) {
  const bag = { pageErrors: [], consoleErrors: [] }
  page.on('pageerror', (e) => bag.pageErrors.push((e?.stack ? String(e.stack) : String(e)).slice(0, 1200)))
  page.on('console', (m) => {
    if (m.type() === 'error') bag.consoleErrors.push(m.text().slice(0, 500))
  })
  return bag
}

export async function launch({ viewport = VIEWPORT, headless = true, hasTouch = false } = {}) {
  const args = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  const env = { ...process.env, LD_LIBRARY_PATH: LIB }
  if (PROFILE) {
    const ctx = await chromium.launchPersistentContext(PROFILE, {
      executablePath: CHROMIUM,
      headless,
      args,
      env,
      viewport,
      locale: 'zh-CN',
      colorScheme: 'dark',
      hasTouch,
      isMobile: hasTouch,
    })
    const page = ctx.pages()[0] ?? (await ctx.newPage())
    return { ctx, page, close: () => ctx.close() }
  }
  const browser = await chromium.launch({ executablePath: CHROMIUM, headless, args, env })
  const ctx = await browser.newContext({ viewport, locale: 'zh-CN', colorScheme: 'dark', hasTouch, isMobile: hasTouch })
  const page = await ctx.newPage()
  return { ctx: browser, page, close: () => browser.close() }
}

export async function waitHome(page, timeout = 60_000) {
  await page.waitForFunction(
    () => /开始学习|继续学习|查看今日|去添加词库/.test(document.body.innerText),
    null,
    { timeout },
  )
}

export async function clickStart(page) {
  const btn = page.getByRole('button', { name: /开始学习|继续学习/ }).first()
  await btn.waitFor({ state: 'visible', timeout: 30_000 })
  await btn.click()
  await page.locator('.board-stage, .completion-page, .study-page').first().waitFor({ state: 'visible', timeout: 60_000 })
  // 首次进入需要 plan/词库查询；等板面或完成页真正稳定
  await page.waitForFunction(
    () => !!document.querySelector('.board-stage') || !!document.querySelector('.completion-page') || /今日完成/.test(document.body.innerText),
    null,
    { timeout: 60_000 },
  )
}

export async function openAnnotation(page) {
  await page.locator('.board-stage').first().click()
  await page.locator('.annotation-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
}

export async function panelInfo(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('.derivation-panel')
    const pageEl = document.querySelector('.study-page')
    const rect = panel?.getBoundingClientRect()
    const bodyText = document.body.innerText
    return {
      open: !!panel,
      width: rect ? Math.round(rect.width) : 0,
      viewport: window.innerWidth,
      percent: rect ? Math.round((rect.width / window.innerWidth) * 100) : 0,
      cssWidth: pageEl ? getComputedStyle(pageEl).getPropertyValue('--derivation-panel-width').trim() : '',
      textMode: !!Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === '文字' && b.getAttribute('aria-pressed') !== 'false'),
      errorBoundary: bodyText.includes('页面渲染出错'),
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }
  })
}

export async function openPanelByButton(page) {
  const btn = page.getByRole('button', { name: '展开生成元引申' }).first()
  await btn.waitFor({ state: 'visible', timeout: 15_000 })
  // task-190：真实 click 可能被 capture/click-suppression 吞掉；DOM click 启动场景，失败再真实 click
  await page.evaluate(() => {
    const b = Array.from(document.querySelectorAll('button')).find((x) => x.getAttribute('aria-label') === '展开生成元引申')
    b?.click()
  }).catch(() => {})
  await page.locator('.derivation-panel').waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  if (!(await page.locator('.derivation-panel').count())) {
    await btn.click({ force: true }).catch(() => {})
    await page.locator('.derivation-panel').waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  }
  await sleep(250)
}

export async function closePanel(page) {
  if (!(await page.locator('.derivation-panel').count())) return
  const btn = page.getByRole('button', { name: '收起' }).first()
  if (await btn.count()) await btn.click().catch(() => {})
  await page.locator('.derivation-panel').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  if (await page.locator('.derivation-panel').count()) {
    // task-190：真实 click 可能被 click-suppression 吞掉；DOM click 兜底
    await page.evaluate(() => {
      const b = Array.from(document.querySelectorAll('.derivation-panel button')).find((x) => x.textContent?.trim() === '收起')
      b?.click()
    }).catch(() => {})
    await page.locator('.derivation-panel').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  }
  await sleep(200)
}

/**
 * 任意起点水平拖动（pointer 事件；Playwright mouse 产生 pointerType=mouse）。
 * task-185：1:1 跟手——宽度 = dx / window.innerWidth * 100（未开时 startWidth=0），
 * 松手 <30% 会关闭；默认 dx=-160（390 宽约 41%）用于断言打开后的比例。
 */
export async function swipePanelFrom(page, xFraction, dx = -160) {
  await closePanel(page)
  if (await page.locator('.derivation-panel').count()) {
    // 兜底：再次点收起/关闭，确保从关闭态起手，避免把已开 50% 当成起手 0
    const close = page.getByRole('button', { name: /收起|关闭/ }).first()
    if (await close.count()) await close.click().catch(() => {})
    await page.locator('.derivation-panel').waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {})
    await sleep(200)
  }
  if (await page.locator('.derivation-panel').count()) throw new Error('右页未能关闭，无法测关闭态滑动')
  const box = await page.locator('.study-body').boundingBox()
  if (!box) throw new Error('找不到 .study-body')
  const x = box.x + box.width * xFraction
  const y = box.y + Math.min(Math.max(180, box.height * 0.35), box.height - 120)
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx, y, { steps: 10 })
  await page.mouse.up()
  await sleep(350)
  return panelInfo(page)
}

/** 测试夹具：把今日 plan 重置到 index 0（已完成 profile 也能重新进入学习页）。 */
export async function resetTodayPlan(page) {
  const changed = await page.evaluate(async () => {
    const open = () => new Promise((resolve, reject) => {
      const req = indexedDB.open('wordc')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const db = await open()
    const meta = await new Promise((resolve) => {
      const req = db.transaction('meta', 'readonly').objectStore('meta').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve([])
    })
    const activeId = meta.find((m) => m.key === 'plan.activeId')?.value
    if (!activeId) return false
    const plan = await new Promise((resolve) => {
      const req = db.transaction('plans', 'readonly').objectStore('plans').get(activeId)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
    })
    if (!plan) return false
    await new Promise((resolve, reject) => {
      const tx = db.transaction('plans', 'readwrite')
      tx.objectStore('plans').put({ ...plan, index: 0, completedAt: null, updatedAt: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return true
  })
  return changed
}

export async function routeSmoke(page) {
  const routes = [
    ['#/decks', /词库|新建|导入/],
    ['#/stats', /统计|学习量|不熟悉度/],
    ['#/me', /我的|使用说明|原理/],
    ['#/me/settings', /设置|记忆设置|外观/],
    ['#/today', /今日|复习|新学|还没有|暂无/],
  ]
  const results = []
  for (const [hash, re] of routes) {
    await page.goto(BASE + hash, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    // 等异步页结束 loading（stats 有时先显示“正在统计数据…”）
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText
          return !/正在统计数据/.test(t)
        },
        null,
        { timeout: 15_000 },
      )
      .catch(() => {})
    await sleep(500)
    const text = await page.locator('body').innerText()
    results.push({ hash, ok: re.test(text) && text.trim().length > 5 && !text.includes('页面渲染出错') && !/正在统计数据/.test(text), len: text.length })
  }
  return results
}

export async function screenshot(page, name) {
  const path = join(OUT, `${name}.png`)
  await page.screenshot({ path, fullPage: false })
  return path
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`)
}

export function safeJson(value) {
  return JSON.stringify(value)
}

/** 等内置 deck/words 落库（fresh fixture 用） */
export async function waitDeckSeed(page, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const ready = await page.evaluate(async () => {
      try {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open('wordc'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
        const count = (store) => new Promise((resolve) => { const r = db.transaction(store, 'readonly').objectStore(store).count(); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(0) })
        return (await count('decks')) >= 1 && (await count('words')) >= 1
      } catch { return false }
    }).catch(() => false)
    if (ready) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

/** 若 QA_FIXTURE 指定，则等待内置 deck 后加载最小 JSON fixture */
export async function maybeLoadFixture(page) {
  if (!FIXTURE) return null
  await waitDeckSeed(page)
  return loadMinimalFixture(page, FIXTURE)
}
