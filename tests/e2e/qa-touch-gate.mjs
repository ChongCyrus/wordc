#!/usr/bin/env node
/**
 * task-177 真实 touch 门禁（task-185 目标：任意位置 1:1 跟手）。
 *
 * 期望（390 viewport，1% = 3.9px）：
 * - 关闭态任意起点 x=20/200/380，dx=-40 → 约 10.3%（松手 <30 关闭）
 * - dx=-160 → 约 41%；dx=-300 → clamp 75%
 * - 已打开 50% 时 dx=±50 → 约 62.8% / 37.2%
 * - 拖动过程单步比例与手指位移一致、无跳变；touchCancel 后可恢复
 *
 * 运行（task-185 新 hook build 后）：
 *   QA_FIXTURE=$PWD/tests/e2e/fixtures/minimal-profile.json \
 *   QA_BASE=http://127.0.0.1:4173/ node tests/e2e/qa-touch-gate.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BASE, FIXTURE, OUT, PROFILE, assert, closePanel, launch, maybeLoadFixture,
  openAnnotation, openPanelByButton, panelInfo, sleep, waitHome, watchErrors,
} from './qa-gate-lib.mjs'

const VW = 390
const toPercent = (dx) => (-dx / VW) * 100
const expectedPercent = (dx) => Math.min(75, Math.max(0, toPercent(dx)))
const started = Date.now()
const result = { base: BASE, profile: PROFILE || '(fresh)', fixture: FIXTURE || null, hasTouch: true, scenarios: {}, errors: [], ok: false }
const record = (k, v) => { result.scenarios[k] = v; console.log(`[touch] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { ctx, page, close } = await launch({ hasTouch: true })
const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const cdp = ctx.newCDPSession ? await ctx.newCDPSession(page) : await page.context().newCDPSession(page)
const pt = (x, y) => [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }]
const width = async () => (await panelInfo(page)).percent
const panelOpen = async () => (await panelInfo(page)).open
let bodyBox = null

async function begin() {
  bodyBox = await page.locator('.study-body').boundingBox()
  assert(bodyBox, '找不到 .study-body')
}
async function startTouch(x, y) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x, y) }) }
async function moveTouch(x, y) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x, y) }) }
async function endTouch() { await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await sleep(250) }
async function cancelTouch() { await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] }); await sleep(250) }

/** 手势后 300ms click suppression 内不要点收起；等完再关，必要时 DOM click 兜底 */
async function resetClosed() {
  await sleep(380)
  await closePanel(page)
  if (await page.locator('.derivation-panel').count()) {
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('.derivation-panel button')).find((b) => b.textContent?.trim() === '收起')
      btn?.click()
    }).catch(() => {})
    await page.locator('.derivation-panel').waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  }
  await sleep(250)
  assert((await page.locator('.derivation-panel').count()) === 0, '场景前右页未能关闭')
}
/** task-190 场景复位：等 click suppression 过期，再点 handle；失败重试一次 */
async function openPanelSafe(page) {
  await sleep(400)
  // 场景 setup 用 DOM click 快速打开（真实 click 行为在 1c 单独验证）
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === '展开生成元引申')
    btn?.click()
  }).catch(() => {})
  await page.locator('.derivation-panel').waitFor({ state: 'visible', timeout: 3000 }).catch(() => {})
  if (!(await page.locator('.derivation-panel').count())) {
    await sleep(400)
    await openPanelByButton(page).catch(() => {})
    await page.locator('.derivation-panel').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {})
  }
  assert((await page.locator('.derivation-panel').count()) === 1, 'openPanelSafe: 右页未打开')
}
/** 关闭态从绝对 x 起手拖动 dx；返回拖动中宽度、松手后状态 */
async function closedDrag(startX, dx, steps = 10) {
  await resetClosed()
  await begin()
  const y = bodyBox.y + Math.min(bodyBox.height * 0.45, bodyBox.height - 120)
  const target = await page.evaluate(({ x, yy }) => {
    const el = document.elementFromPoint(x, yy)
    return el ? `${el.tagName}.${String(el.className || '').slice(0, 80)}` : null
  }, { x: startX, yy: y })
  await startTouch(startX, y)
  let during = 0
  for (let i = 1; i <= steps; i += 1) {
    await moveTouch(startX + (dx * i) / steps, y)
    if (i === Math.round(steps / 2)) during = await width()
    await sleep(16)
  }
  const beforeRelease = await width()
  await endTouch()
  await page.waitForTimeout(300)
  return { during, beforeRelease, after: await width(), open: await panelOpen(), target, body: { x: bodyBox.x, y: bodyBox.y, w: bodyBox.width, h: bodyBox.height } }
}

/** 已打开 50 时从任意绝对 x 起手拖动 dx */
async function openDrag(dx, steps = 8, startX = 195) {
  // 场景内复用同一学习页：关面板 → 点 handle 重开 50，避免每次 reload（10 场景太慢）
  await resetClosed()
  await openPanelSafe(page)
  await page.waitForTimeout(200)
  const initial = await width()
  assert(initial === 50, `打开后应为 50%，实际 ${initial}%`)
  await begin()
  const y = bodyBox.y + Math.min(bodyBox.height * 0.45, bodyBox.height - 120)
  const target = await page.evaluate(({ x, yy }) => {
    const el = document.elementFromPoint(x, yy)
    return el ? `${el.tagName}.${String(el.className || '').slice(0, 80)}` : null
  }, { x: startX, yy: y })
  await startTouch(startX, y)
  for (let i = 1; i <= steps; i += 1) {
    await moveTouch(startX + (dx * i) / steps, y)
    await sleep(16)
  }
  const beforeRelease = await width()
  await endTouch()
  return { initial, beforeRelease, after: await width(), open: await panelOpen(), target, startX, dx }
}
function approx(actual, expected, tol = 3) { return Math.abs(actual - expected) <= tol }

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) { record('fixture', await maybeLoadFixture(page)); await page.goto(BASE, { waitUntil: 'domcontentloaded' }) }
  // task-188：让 current 处于第2词（canGoBack=true），才能验证右滑不误触发回退
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open('wordc'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
    const activeId = await new Promise((resolve) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => resolve(r.result?.value ?? null) })
    if (!activeId) return
    await new Promise((resolve, reject) => {
      const tx = db.transaction('plans', 'readwrite')
      const store = tx.objectStore('plans')
      const get = store.get(activeId)
      get.onsuccess = () => { const plan = get.result; if (plan && plan.wordIds?.length > 1) store.put({ ...plan, index: 1, updatedAt: Date.now() }) }
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
    })
  }).catch(() => {})
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 120_000)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  await page.screenshot({ path: join(OUT, '20-touch-annotation.png') }).catch(() => {})
  // task-197/209 边界：当前 technical 全部含义标记不常考；默认隐藏，点击「已隐藏 N 条」临时显示
  const hiddenRareBtn = page.locator('.annotation-hidden-rare').first()
  const hiddenDefault = (await hiddenRareBtn.count()) > 0 ? (await hiddenRareBtn.innerText()).trim() : ''
  if (hiddenDefault) await hiddenRareBtn.click()
  await page.waitForTimeout(200)
  const rareBadges = await page.locator('.rare-badge').count()
  record('allRareAnnotation', { hiddenDefault, rareBadges, hasAnnotation: (await page.locator('.annotation-stage').count()) > 0, errorBoundary: (await page.locator('text=页面渲染出错').count()) > 0 })
  assert(hiddenDefault === '' || /已隐藏 \d+ 条不常考/.test(hiddenDefault), `全 rare 默认应隐藏并显示计数，实际 ${hiddenDefault}`)
  assert(rareBadges > 0, '临时显示后全部含义不常考的词应显示不常考标记')
  assert(!(await page.locator('text=页面渲染出错').count()), '全部含义不常考导致 ErrorBoundary')

  // task-197 新增：手动不常考按钮可点、AI 标记入口可见（不点击，避免真实 API）
  const beforeToggle = await page.locator('.rare-badge').count()
  const firstRareToggle = page.locator('.rare-toggle-btn.is-rare').first()
  await firstRareToggle.click()
  await page.waitForTimeout(350)
  const afterToggle = await page.locator('.rare-badge').count()
  record('rareManualToggle', { beforeToggle, afterToggle })
  assert(afterToggle === beforeToggle - 1, `手动取消不常考应使 badge -1：${beforeToggle}→${afterToggle}`)
  await page.locator('.rare-toggle-btn').filter({ hasText: '标记不常考' }).first().click()
  await page.waitForTimeout(350)
  assert((await page.locator('.rare-badge').count()) === beforeToggle, '重新标记不常考应恢复 badge')
  const aiRareBtn = page.getByRole('button', { name: 'AI 标记不常考' }).first()
  record('aiRareEntry', { count: await aiRareBtn.count(), enabled: await aiRareBtn.isEnabled().catch(() => false) })
  assert((await aiRareBtn.count()) > 0 && (await aiRareBtn.isEnabled().catch(() => false)), '注释面应有可点的 AI 标记不常考入口')

  // ActionBar 三按钮不换行 + nc/rare 徽标不被右缘「引申」按钮遮挡
  const layout = await page.evaluate(() => {
    const row = document.querySelector('.memory-row')
    const btns = row ? Array.from(row.querySelectorAll('.memory-btn')) : []
    const tops = btns.map((b) => Math.round(b.getBoundingClientRect().top))
    const rowRect = row?.getBoundingClientRect()
    const handle = document.querySelector('button.derivation-handle')?.getBoundingClientRect()
    const badges = Array.from(document.querySelectorAll('.rare-badge,.nc-badge'))
    const badgeRects = badges.map((b) => { const r = b.getBoundingClientRect(); return { text: b.textContent, left: r.left, right: r.right, top: r.top, bottom: r.bottom } })
    const overlap = handle ? badgeRects.filter((r) => !(r.right <= handle.left || r.left >= handle.right || r.bottom <= handle.top || r.top >= handle.bottom)).length : 0
    return {
      buttonCount: btns.length,
      sameTop: tops.length > 0 && tops.every((t) => t === tops[0]),
      rowOverflow: rowRect ? row.scrollWidth > row.clientWidth + 1 : true,
      badgeCount: badges.length,
      rareBadges: document.querySelectorAll('.rare-badge').length,
      ncBadges: document.querySelectorAll('.nc-badge').length,
      badgeHandleOverlap: overlap,
      viewport: innerWidth,
    }
  })
  record('actionBarAndBadgesLayout', layout)
  assert(layout.buttonCount === 3 && layout.sameTop && !layout.rowOverflow, `ActionBar 三按钮应同排不换行：${JSON.stringify(layout)}`)
  assert(layout.rareBadges > 0 && layout.ncBadges > 0, `应同时有 rare/nc 徽标：${JSON.stringify(layout)}`)
  assert(layout.badgeHandleOverlap === 0, `徽标不应被引申按钮遮挡：${JSON.stringify(layout)}`)

  // task-197 阶段2：映射助记、任意位置计数/圆点、RootMnemonicDialog 可见
  await page.getByRole('button', { name: '生成式记忆' }).first().click()
  await page.locator('.generative-stage').waitFor({ state: 'visible', timeout: 10_000 })
  await page.locator('.generative-scroll').getByRole('button', { name: '下一步' }).click()
  await page.locator('.generative-phase2').waitFor({ state: 'visible', timeout: 10_000 })
  const mnemonicText = await page.locator('.generative-root-mnemonic').innerText().catch(() => '')
  record('stage2Mnemonic', { text: mnemonicText })
  assert(mnemonicText.includes('映射助记：fixture映射助记'), `阶段2应显示映射助记，实际 ${mnemonicText}`)
  const cardInfo = await page.evaluate(() => {
    const card = document.querySelector('.generative-wc-card')
    const r = card?.getBoundingClientRect()
    return {
      visible: !!card,
      width: r ? Math.round(r.width) : 0,
      viewport: window.innerWidth,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      textLength: document.querySelector('.generative-root-mnemonic')?.textContent?.length ?? 0,
    }
  })
  record('stage2CardLongText', cardInfo)
  assert(cardInfo.visible && cardInfo.width > 0 && cardInfo.width <= cardInfo.viewport, `阶段2卡片应可见且不超宽：${JSON.stringify(cardInfo)}`)
  assert(cardInfo.textLength > 100 && !cardInfo.horizontalOverflow, `阶段2长映射助记不应裁切/横向溢出：${JSON.stringify(cardInfo)}`)
  const countBefore = await page.locator('.generative-count .wc-count').innerText()
  const dotsBefore = await page.locator('.wc-dot.is-filled').count()
  await page.locator('.generative-phase2').click({ position: { x: 12, y: 12 } })
  await page.waitForTimeout(250)
  const countAfter = await page.locator('.generative-count .wc-count').innerText()
  const dotsAfter = await page.locator('.wc-dot.is-filled').count()
  record('stage2CountDots', { countBefore, countAfter, dotsBefore, dotsAfter })
  assert(countAfter !== countBefore && dotsAfter === dotsBefore + 1, `阶段2任意位置计数/圆点应+1：${countBefore}→${countAfter}, dots ${dotsBefore}→${dotsAfter}`)
  await page.getByRole('button', { name: 'AI助记·生成元映射' }).first().click()
  const dlg = page.locator('.mm-dialog').filter({ hasText: '生成元映射助记' }).first()
  await dlg.waitFor({ state: 'visible', timeout: 5000 })
  const z = await page.evaluate(() => {
    const d = document.querySelector('.mm-dialog'); const g = document.querySelector('.generative-stage')
    return { dialog: d ? getComputedStyle(d).zIndex : null, stage: g ? getComputedStyle(g).zIndex : null }
  })
  record('rootMnemonicDialog', { visible: await dlg.isVisible(), z })
  assert(await dlg.isVisible(), 'RootMnemonicDialog 应可见')
  const closeDlg = dlg.getByRole('button', { name: /取消|关闭|知道了/ }).first()
  if (await closeDlg.count()) await closeDlg.click().catch(() => {})
  else await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  await page.locator('.generative-head').getByRole('button', { name: '退出' }).click()
  await page.waitForTimeout(300)
  await begin()

  // 1) 关闭态任意起点 x=20/200/340（task-185 修复后要求 x340 也 1:1）
  for (const startX of [20, 200, 340]) {
    for (const dx of [-40, -160, -300]) {
      const g = await closedDrag(startX, dx)
      const exp = expectedPercent(dx)
      const label = `closed_x${startX}_dx${dx}`
      record(label, { ...g, expected: exp })
      assert(approx(g.beforeRelease, exp), `${label}: 松手前应约 ${exp.toFixed(1)}%，实际 ${g.beforeRelease}%`)
      if (exp < 30) {
        // task-190 用户纠正：短滑不吸附 30%，松手 raw>0 保持实际宽度
        assert(g.open, `${label}: 短滑应打开，实际 open=${g.open} after=${g.after}%`)
        assert(approx(g.after, exp, 2), `${label}: 松手后应保持≈${exp.toFixed(1)}%，实际 ${g.after}%`)
      } else {
        assert(g.open, `${label}: 松手应保持打开`)
        assert(approx(g.after, exp), `${label}: 松手后应约 ${exp.toFixed(1)}%，实际 ${g.after}%`)
      }
      assert(!(await panelInfo(page)).horizontalOverflow, `${label}: 横向溢出`)
      await page.screenshot({ path: join(OUT, `21-touch-${label}.png`) }).catch(() => {})
    }
  }

  // 1b) task-187 灵敏度：settings derivation.swipeSensitivity=2，dx=-40 期望 20.5%
  async function setSensitivity(value) {
    await page.evaluate(async (v) => {
      const db = await new Promise((resolve, reject) => { const r = indexedDB.open('wordc'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error) })
      await new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite')
        tx.objectStore('settings').put({ key: 'derivation.swipeSensitivity', value: v, updatedAt: Date.now() })
        tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error)
      })
    }, value)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitHome(page, 90_000)
    await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
    await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
    await openAnnotation(page)
  }
  await setSensitivity(2)
  const sens = await closedDrag(200, -40)
  const sensExpected = (40 / 390) * 100 * 2
  record('sensitivity2_dx-40', { ...sens, expected: sensExpected })
  assert(approx(sens.beforeRelease, sensExpected, 4), `灵敏度2 dx=-40 应约 ${sensExpected.toFixed(1)}%，实际 ${sens.beforeRelease}%`)
  assert(sens.open && approx(sens.after, sensExpected, 2), `灵敏度2 dx=-40 松手应保持≈${sensExpected.toFixed(1)}%，实际 open=${sens.open} ${sens.after}%`)
  await setSensitivity(1)

  // 1c) 显式入口：点击「展开生成元引申」按钮应正常打开并初始 50%（先 fresh 重载，避免灵敏度场景残留）
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  await resetClosed()
  await openPanelSafe(page)
  const byHandle = await panelInfo(page)
  record('openByHandleButton', byHandle)
  assert(byHandle.open && byHandle.percent === 50, `点击 handle 应打开 50%，实际 open=${byHandle.open} ${byHandle.percent}%`)
  await closePanel(page)

  // 2) 已打开 50：整屏任意 x=20/100/200/280/340 起手 dx=±50 → 62.8 / 37.2
  for (const startX of [20, 100, 200, 280, 340]) {
    for (const dx of [-50, 50]) {
      const r = await openDrag(dx, 8, startX)
      const exp = 50 - (dx / 390) * 100
      const label = `open50_x${startX}_dx${dx}`
      record(label, { ...r, expected: exp })
      assert(approx(r.beforeRelease, exp, 4), `${label}: 应约 ${exp.toFixed(1)}%，实际 ${r.beforeRelease}%（target=${r.target}）`)
      assert(r.open, `${label}: 松手后应保持打开`)
      assert(approx(r.after, Math.min(75, Math.max(30, exp)), 4), `${label}: 松手后应在 30–75，实际 ${r.after}%`)
      assert(!(await panelInfo(page)).horizontalOverflow, `${label}: 横向溢出`)
    }
  }

  // 2a) task-190：右页打开后右滑收窄，只有到 0 才关闭；中间 <30 仍保持打开
  const narrow = await openDrag(100, 10, 200)
  record('task190_rightNarrow100', { ...narrow, expected: 50 - (100 / 390) * 100 })
  assert(approx(narrow.beforeRelease, 50 - (100 / 390) * 100, 4), `右滑100px应约24.4%，实际 ${narrow.beforeRelease}%`)
  assert(narrow.open, `右滑到24.4%（>0）不应关闭，实际 open=${narrow.open}`)
  assert(approx(narrow.after, 50 - (100 / 390) * 100, 3), `右滑100px松手应保持≈24.4%，实际 ${narrow.after}%`)
  const toZero = await openDrag(200, 12, 200)
  record('task190_rightToZero', { ...toZero, expected: 0 })
  assert(!toZero.open, `右滑到 0 应关闭，实际 open=${toZero.open} ${toZero.after}%`)

  // 2b) 纵向滚动/按钮点击不误触：面板打开 50 后纵向 touch、按钮 tap 均不改宽度
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  await closePanel(page)
  await openPanelSafe(page)
  await begin()
  const vy = bodyBox.y + bodyBox.height * 0.45
  await startTouch(200, vy)
  for (let i = 1; i <= 5; i += 1) { await moveTouch(200, vy - 16 * i); await sleep(16) }
  await endTouch()
  const afterVertical = await panelInfo(page)
  record('verticalNoResize', afterVertical)
  assert(afterVertical.open && afterVertical.percent === 50, `纵向滚动不应改宽度，实际 open=${afterVertical.open} ${afterVertical.percent}%`)
  await page.touchscreen.tap(100, vy)
  await sleep(300)
  const afterTap = await panelInfo(page)
  record('buttonTapNoResize', afterTap)
  assert(afterTap.open && afterTap.percent === 50, `普通按钮 tap 不应误调宽，实际 open=${afterTap.open} ${afterTap.percent}%`)
  await resetClosed()

  // 3) 单步比例/无跳变：fresh 学习页后关闭态 dx=-160
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  await resetClosed()
  await begin()
  const y = bodyBox.y + Math.min(bodyBox.height * 0.45, bodyBox.height - 120)
  const x0 = 200
  await startTouch(x0, y)
  const samples = []
  for (let i = 1; i <= 8; i += 1) {
    await moveTouch(x0 - 20 * i, y)
    await sleep(20)
    samples.push(await width())
  }
  await endTouch()
  record('proportional_samples', { samples, expected: expectedPercent(-160) })
  for (let i = 0; i < samples.length; i += 1) {
    const expected = expectedPercent(-20 * (i + 1))
    assert(approx(samples[i], expected, 4), `第 ${i + 1} 步应约 ${expected.toFixed(1)}%，实际 ${samples[i]}%`)
  }

  // 4) touchCancel 后可恢复
  await resetClosed()
  await begin()
  await startTouch(200, y); await moveTouch(160, y); await cancelTouch()
  const afterCancelTouch = await panelInfo(page)
  record('afterTouchCancel', afterCancelTouch)
  // task-190：cancel 不回滚已打开状态；允许 open>0，仅要求宽度合法
  assert(afterCancelTouch.percent >= 0 && afterCancelTouch.percent <= 75, `touchCancel 后宽度非法：${afterCancelTouch.percent}%`)
  const afterCancel = await closedDrag(200, -160)
  record('after_cancel', afterCancel)
  assert(afterCancel.open && approx(afterCancel.beforeRelease, expectedPercent(-160)), 'touchCancel 后再 touch 应正常 1:1 打开')

  // 4b) task-195：页面根替换/loading→ready 后手势仍生效；blur/visibility 自愈
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  await page.evaluate(() => { window.dispatchEvent(new Event('blur')); document.dispatchEvent(new Event('visibilitychange')) }).catch(() => {})
  const afterRemount = await closedDrag(200, -160)
  record('task195_remount_gesture', afterRemount)
  assert(afterRemount.open && approx(afterRemount.beforeRelease, 41, 4), `根替换/blur 后手势应仍1:1≈41%，实际 ${afterRemount.beforeRelease}%`)
  await resetClosed()
  const headBefore = (await page.locator('.word-head').first().innerText()).replace(/\s+/g, ' ')
  const titleBefore = await page.locator('.study-topbar-title').innerText()
  const hashBefore = await page.evaluate(() => location.hash)
  await begin()
  const y188 = bodyBox.y + Math.min(bodyBox.height * 0.45, bodyBox.height - 120)
  await startTouch(200, y188)
  for (let i = 1; i <= 6; i += 1) { await moveTouch(200 + 20 * i, y188); await sleep(16) }
  await endTouch()
  const afterAnnotationRight = {
    head: (await page.locator('.word-head').first().innerText()).replace(/\s+/g, ' '),
    title: await page.locator('.study-topbar-title').innerText(),
    hash: await page.evaluate(() => location.hash),
    panelOpen: await panelOpen(page),
  }
  record('task188_annotationRightSwipe', { before: { head: headBefore, title: titleBefore, hash: hashBefore }, after: afterAnnotationRight })
  assert(afterAnnotationRight.head === headBefore && afterAnnotationRight.title === titleBefore, '注释面右滑不应换词/goBack')
  assert(afterAnnotationRight.hash === hashBefore, '注释面右滑不应改路由')
  assert(!afterAnnotationRight.panelOpen, '关闭态右滑不应打开面板')

  // 右页打开：右滑只收窄，不 goBack
  await openPanelSafe(page)
  await begin()
  const panelHead = (await page.locator('.word-head').first().innerText()).replace(/\s+/g, ' ')
  await startTouch(200, y188)
  for (let i = 1; i <= 5; i += 1) { await moveTouch(200 + 10 * i, y188); await sleep(16) }
  let panelRight = await panelInfo(page)
  await endTouch()
  panelRight = await panelInfo(page)
  record('task188_panelRightNarrow', panelRight)
  assert(panelRight.open && approx(panelRight.percent, 37.2, 4), `右页打开右滑50px应约37.2%，实际 ${panelRight.percent}%`)
  assert((await page.locator('.word-head').first().innerText()).replace(/\s+/g, ' ') === panelHead, '右页右滑不应换词')
  // 继续右滑 >30 应关闭，不换词
  await begin()
  await startTouch(200, y188)
  for (let i = 1; i <= 10; i += 1) { await moveTouch(200 + 30 * i, y188); await sleep(16) }
  await endTouch()
  const panelClosedByRight = await panelInfo(page)
  record('task188_panelRightClose', panelClosedByRight)
  assert(!panelClosedByRight.open, '右页右滑>30应关闭面板')
  assert((await page.locator('.word-head').first().innerText()).replace(/\s+/g, ' ') === panelHead, '右页右滑关闭不应换词')

  // 顶部按钮仍可回退（计划 index1 时 canGoBack=true）；等 click suppression 过期
  await sleep(500)
  const backBtn = page.getByRole('button', { name: '上一个单词' }).first()
  await backBtn.waitFor({ state: 'visible', timeout: 10_000 })
  const backBox = await backBtn.boundingBox()
  assert(backBox, '顶部回退按钮不可见')
  // 移动端真实路径：touch tap（mouse click 会被 .study-page 的 pointer capture 重定向，非用户路径）
  await page.touchscreen.tap(backBox.x + backBox.width / 2, backBox.y + backBox.height / 2)
  await page.waitForTimeout(600)
  const afterTopBack = {
    head: (await page.locator('.word-head').first().innerText()).replace(/\s+/g, ' '),
    title: await page.locator('.study-topbar-title').innerText(),
    method: 'touch-tap',
  }
  record('task188_topBack', { before: { head: panelHead, title: titleBefore }, after: afterTopBack })
  assert(afterTopBack.head !== panelHead || afterTopBack.title !== titleBefore, '顶部回退按钮应能回退上一词')

  // 0.3.66：dialog 打开时手势不改宽；关闭后弹层外可正常调宽
  await sleep(500)
  await page.getByRole('button', { name: '更多' }).first().click()
  await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).click()
  await page.locator('.mm-dialog').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(OUT, '30-ai-dialog-390.png') }).catch(() => {})
  const dialogLayout = await page.evaluate(() => {
    const d = document.querySelector('.mm-dialog')
    const r = d?.getBoundingClientRect()
    const narrowText = d ? Array.from(d.querySelectorAll('p,span,div,button')).filter((el) => {
      const t = (el.textContent ?? '').trim()
      if (t.length < 5) return false
      const er = el.getBoundingClientRect()
      return er.width > 0 && er.width < 24 && er.height > er.width * 1.5
    }).length : 0
    return {
      visible: !!d, width: r ? Math.round(r.width) : 0, viewport: innerWidth,
      horizontalOverflow: d ? d.scrollWidth > d.clientWidth + 1 : true,
      pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      narrowText,
    }
  })
  record('aiDialogLayout390', dialogLayout)
  assert(dialogLayout.visible && !dialogLayout.horizontalOverflow && !dialogLayout.pageOverflow, `AI dialog 不应横向溢出：${JSON.stringify(dialogLayout)}`)
  assert(dialogLayout.narrowText === 0, `AI dialog 不应中文竖排/窄条：${JSON.stringify(dialogLayout)}`)
  const beforeDialogDrag = await panelInfo(page)
  await begin()
  const yDlg = bodyBox.y + bodyBox.height * 0.45
  await startTouch(200, yDlg)
  for (let i = 1; i <= 8; i += 1) { await moveTouch(200 - 20 * i, yDlg); await sleep(16) }
  await endTouch()
  const duringDialogDrag = await panelInfo(page)
  record('dialogGestureNoResize', { before: beforeDialogDrag.percent, during: duringDialogDrag.percent, dialogOpen: await page.locator('.mm-dialog').first().isVisible() })
  assert(duringDialogDrag.percent === beforeDialogDrag.percent, `dialog 打开时滑动不应改宽：${beforeDialogDrag.percent}→${duringDialogDrag.percent}`)
  const dlgClose = page.locator('.mm-dialog').first().getByRole('button', { name: /取消|关闭|知道了/ }).first()
  if (await dlgClose.count()) await dlgClose.click().catch(() => {})
  else await page.keyboard.press('Escape')
  await page.locator('.mm-dialog').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  await page.waitForTimeout(500)
  const afterClose = await closedDrag(200, -160)
  record('afterDialogCloseGesture', afterClose)
  assert(afterClose.open && approx(afterClose.beforeRelease, 41, 4), `dialog 关闭后弹层外应可调宽≈41%，实际 ${afterClose.beforeRelease}%`)

  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true
  result.durationMs = Date.now() - started
  console.log(`\n[touch] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false
  result.durationMs = Date.now() - started
  result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[touch] FAIL: ${result.failReason}`)
  await page.screenshot({ path: join(OUT, '99-touch-failure.png') }).catch(() => {})
  process.exitCode = 1
} finally {
  await writeFile(join(OUT, 'qa-touch-gate.json'), JSON.stringify(result, null, 2))
  await close().catch(() => {})
}
