#!/usr/bin/env node
/**
 * 生产包 QA gate（task-177）：真实数据 profile → 学习页 smoke + 任意位置滑动 + 视觉截图。
 *
 * 运行：
 *   QA_PROFILE=/tmp/qa034-profile QA_BASE=http://127.0.0.1:4173/ \
 *     node tests/e2e/qa-prod-gate.mjs
 *
 * 无 QA_PROFILE 时用 fresh context（需要词库已 seed，否则会失败并提示）。
 * 输出：docs/assets/e2e/qa-gate/qa-gate.json + png；任何 pageerror/console.error 失败。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BASE,
  FIXTURE,
  OUT,
  PROFILE,
  assert,
  maybeLoadFixture,
  clickStart,
  closePanel,
  launch,
  openAnnotation,
  openPanelByButton,
  panelInfo,
  routeSmoke,
  screenshot,
  resetTodayPlan,
  sleep,
  swipePanelFrom,
  waitHome,
  watchErrors,
} from './qa-gate-lib.mjs'

const started = Date.now()
const result = {
  startedAt: new Date().toISOString(),
  base: BASE,
  profile: PROFILE || '(fresh)',
  viewport: '390x844',
  scenarios: {},
  errors: [],
  screenshots: [],
  ok: false,
}

function record(name, value) {
  result.scenarios[name] = value
  console.log(`[gate] ${name}: ${JSON.stringify(value)}`)
}

async function shot(page, name) {
  const path = await screenshot(page, name)
  result.screenshots.push(path.replace(/^.*\/docs\/assets\/e2e\/qa-gate\//, 'qa-gate/'))
  console.log(`[gate] screenshot ${path}`)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const { page, close } = await launch()
  const errors = watchErrors(page)
  if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
  // 记录 App JS 执行前的 SW 状态（升级路径证据）
  await page.addInitScript(() => {
    window.__qaSwBoot = {
      hasController: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
      script: navigator.serviceWorker?.controller?.scriptURL ?? '',
    }
  })

  async function gateErrors(label) {
    const all = [...errors.pageErrors, ...errors.consoleErrors].filter(
      (t) => !(FIXTURE && /packs|ERR_FAILED|Failed to load resource/.test(String(t))),
    )
    if (all.length) {
      result.errors.push({ label, errors: all })
      throw new Error(`${label}: pageerror/console.error ${all.length} 条\n${all.join('\n')}`)
    }
  }

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    const boot = await page.evaluate(() => window.__qaSwBoot)
    record('swAtBoot', boot)
    if (FIXTURE) {
      record('fixture', await maybeLoadFixture(page))
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    }
    await waitHome(page, 120_000)
    record('home', {
      text: (await page.locator('body').innerText()).slice(0, 120),
      title: await page.title(),
    })
    await shotgun(page, '01-home-390')

    // 主路由 smoke：每个路由都必须有内容且无 ErrorBoundary
    const routes = await routeSmoke(page)
    record('routes', routes)
    assert(routes.every((r) => r.ok), '存在路由 smoke 失败')
    // fixture 模式故意 abort 内置大 packs（避免 30MB seed），忽略该来源的资源加载 console.error
    if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
    await gateErrors('route-smoke')

    // 学习页：继续学习/开始学习 → 白板 → 注释
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitHome(page, 60_000)
    await resetTodayPlan(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitHome(page, 60_000)
    await clickStart(page)
    const boardText = (await page.locator('body').innerText()).slice(0, 160)
    assert(!boardText.includes('页面渲染出错'), '学习页出现 ErrorBoundary fallback')
    record('studyBoard', { text: boardText, hasBoard: await page.locator('.board-stage').count() > 0 })
    await shotgun(page, '02-study-board-390')
    await gateErrors('study-board')

    await openAnnotation(page)
    record('annotation', {
      text: (await page.locator('body').innerText()).slice(0, 140),
      hasAnnotation: await page.locator('.annotation-stage').count() > 0,
    })
    await shotgun(page, '03-annotation-390')

    // 默认打开：文字模式 + 50/50
    await openPanelByButton(page)
    let info = await panelInfo(page)
    record('panelOpenDefault', info)
    assert(info.open, '右页未打开')
    assert(info.percent === 50, `初始右页应为 50%，实际 ${info.percent}%`)
    assert(info.textMode, '初始应为文字模式')
    assert(!info.errorBoundary, '出现 ErrorBoundary')
    assert(!info.horizontalOverflow, '出现横向溢出')
    await shotgun(page, '04-panel-50-text-390')

    // 任意起点左滑：1:1 跟手（task-185）——dx=-160 应 ≈ dx/vw*100，而不是固定 50/58%
    const swipeVw = await page.evaluate(() => window.innerWidth)
    const swipeDx = -160
    const expectedPercent = Math.min(75, Math.max(30, Math.round((-swipeDx / swipeVw) * 100)))
    for (const [label, fraction] of [['leftQuarter', 0.25], ['mid', 0.5], ['rightQuarter', 0.75]]) {
      const swiped = await swipePanelFrom(page, fraction, swipeDx)
      record(`swipe_${label}`, { ...swiped, expectedPercent })
      assert(swiped.open, `${label}: 未打开右页`)
      assert(
        Math.abs(swiped.percent - expectedPercent) <= 2,
        `${label}: 右页宽度 ${swiped.percent}% 与 1:1 公式 ${expectedPercent}% 不符（dx=${swipeDx}, vw=${swipeVw}）`,
      )
      assert(!swiped.horizontalOverflow, `${label}: 横向溢出`)
      await shotgun(page, `05-swipe-${label}-390`)
      await closePanel(page)
    }
    // task-190 修正：短滑 -40 raw≈10.3% >0，松手保持 10.3%（不吸附 30、不回弹）
    const shortSwipe = await swipePanelFrom(page, 0.5, -40)
    record('swipe_short40_keep10', shortSwipe)
    assert(shortSwipe.open, '短滑 -40px 松手应保持打开（task-190 不回弹）')
    assert(Math.abs(shortSwipe.percent - Math.round((40 / swipeVw) * 100)) <= 2, `短滑 -40px 松手应约 10.3%，实际 ${shortSwipe.percent}%`)

    // 手柄拖拽：短滑后先关闭再重开 50，从 50 往左拖 40px，右页变宽但不超过 75
    await closePanel(page)
    await openPanelByButton(page)
    const handle = page.locator('.derivation-resize-handle').first()
    record('handleExists', await handle.count())
    if (await handle.count()) {
      const box = await handle.boundingBox()
      if (box) {
        const cx = box.x + box.width / 2
        const cy = box.y + Math.min(120, box.height / 2)
        await page.mouse.move(cx, cy)
        await page.mouse.down()
        await page.mouse.move(cx - 40, cy, { steps: 8 })
        await page.mouse.up()
        await sleep(250)
        const dragged = await panelInfo(page)
        record('handleDrag', dragged)
        const expectedHandle = Math.min(75, 50 + Math.round((40 / swipeVw) * 100))
        assert(
          Math.abs(dragged.percent - expectedHandle) <= 2,
          `手柄拖拽宽度 ${dragged.percent}% 与 1:1 公式 ${expectedHandle}% 不符`,
        )
      }
    }
    await closePanel(page)
    await gateErrors('gesture')

    // 360 宽截图 + 无横向溢出（学习注释面）
    await page.setViewportSize({ width: 360, height: 800 })
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitHome(page, 60_000)
    await clickStart(page)
    await openAnnotation(page)
    await openPanelByButton(page)
    const narrow = await panelInfo(page)
    record('viewport360', narrow)
    assert(!narrow.horizontalOverflow, '360 宽存在横向溢出')
    assert(!narrow.errorBoundary, '360 出现 ErrorBoundary')
    await shotgun(page, '06-panel-360')

    await gateErrors('final')
    result.ok = true
    result.durationMs = Date.now() - started
    console.log(`\n[gate] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
  } catch (e) {
    result.ok = false
    result.durationMs = Date.now() - started
    result.failReason = e instanceof Error ? e.message : String(e)
    console.error(`\n[gate] FAIL: ${result.failReason}`)
    await page.screenshot({ path: join(OUT, '99-failure.png') }).catch(() => {})
    process.exitCode = 1
  } finally {
    result.errors.push(...errors.pageErrors.map((e) => ({ type: 'pageerror', message: e })))
    result.errors.push(...errors.consoleErrors.map((e) => ({ type: 'console.error', message: e })))
    await writeFile(join(OUT, 'qa-gate.json'), JSON.stringify(result, null, 2))
    await close().catch(() => {})
  }
}

async function shotgun(page, name) {
  await shot(page, name)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
