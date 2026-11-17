#!/usr/bin/env node
/**
 * 升级路径 QA gate（task-177）：旧 SW/旧版本缓存 → 新构建。
 *
 * 运行：
 *   QA_PROFILE=/tmp/qa034-profile QA_BASE=http://127.0.0.1:4173/ \
 *     node tests/e2e/qa-upgrade-gate.mjs
 *
 * 断言：
 * - App JS 执行前有旧 SW controller（记录 __qaSwBoot）
 * - 新版本启动后 localStorage mm.appVersion 更新为当前版本
 * - 入口脚本为当前 dist 的 index-*.js
 * - 无 ErrorBoundary / 无 pageerror/console.error
 * - 能进入学习页（白板）
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BASE,
  OUT,
  PROFILE,
  ROOT,
  assert,
  clickStart,
  launch,
  resetTodayPlan,
  screenshot,
  sleep,
  waitHome,
  watchErrors,
} from './qa-gate-lib.mjs'

const started = Date.now()
const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const version = process.env.QA_APP_VERSION || pkg.version
const result = {
  startedAt: new Date().toISOString(),
  base: BASE,
  profile: PROFILE || '(fresh)',
  version,
  checks: {},
  errors: [],
  ok: false,
}

function record(k, v) {
  result.checks[k] = v
  console.log(`[upgrade] ${k}: ${JSON.stringify(v)}`)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const { page, close } = await launch()
  const errors = watchErrors(page)
  await page.addInitScript(
    ({ v }) => {
      window.__qaSwBoot = {
        hasController: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
        script: navigator.serviceWorker?.controller?.scriptURL ?? '',
        storedVersion: (() => {
          try {
            return localStorage.getItem('mm.appVersion')
          } catch {
            return null
          }
        })(),
      }
      // 模拟旧版本：有 controller 时把版本写成上一版，触发 guardServiceWorkerVersion 清理
      if (window.__qaSwBoot.hasController) {
        try {
          localStorage.setItem('mm.appVersion', '0.3.51')
        } catch {
          undefined
        }
      }
    },
    { v: version },
  )

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
    const boot = await page.evaluate(() => window.__qaSwBoot)
    record('swAtBoot', boot)
    await waitHome(page, 120_000)
    // 清理流程可能触发一次 reload；等稳定后读取
    await sleep(1500)
    const after = await page.evaluate(async () => {
      const regs = await navigator.serviceWorker.getRegistrations().catch(() => [])
      const cachesKeys = await caches.keys().catch(() => [])
      const scripts = Array.from(document.scripts).map((s) => s.src)
      return {
        controllers: regs.map((r) => ({ scope: r.scope, active: r.active?.scriptURL ?? null })),
        caches: cachesKeys,
        entryScripts: scripts,
        storedVersion: (() => {
          try {
            return localStorage.getItem('mm.appVersion')
          } catch {
            return null
          }
        })(),
        lastError: (() => {
          try {
            return localStorage.getItem('mm.lastError')
          } catch {
            return null
          }
        })(),
        bodyHasErrorBoundary: document.body.innerText.includes('页面渲染出错'),
        bodyLen: document.body.innerText.trim().length,
      }
    })
    record('swAfter', after)
    assert(after.storedVersion === version, `mm.appVersion 未更新为 ${version}（实际 ${after.storedVersion}）`)
    assert(after.entryScripts.some((s) => /\/assets\/index-[^/]+\.js/.test(s)), '未加载当前 dist 入口脚本')
    assert(!after.bodyHasErrorBoundary, '出现 ErrorBoundary fallback')
    assert(!after.lastError, `存在 mm.lastError：${after.lastError}`)
    await screenshot(page, '10-upgrade-home')

    await resetTodayPlan(page)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitHome(page, 90_000)
    await clickStart(page)
    const board = { hasBoard: (await page.locator('.board-stage').count()) > 0, text: (await page.locator('body').innerText()).slice(0, 120) }
    record('studyBoardAfterUpgrade', board)
    assert(board.hasBoard, '升级后学习页未进入白板（可能黑屏/ErrorBoundary）')
    await screenshot(page, '11-upgrade-study-board')

    const all = [...errors.pageErrors, ...errors.consoleErrors]
    result.errors.push(...all)
    assert(all.length === 0, `存在 pageerror/console.error：${all.join('\n')}`)
    result.ok = true
    result.durationMs = Date.now() - started
    console.log(`\n[upgrade] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
  } catch (e) {
    result.ok = false
    result.durationMs = Date.now() - started
    result.failReason = e instanceof Error ? e.message : String(e)
    console.error(`\n[upgrade] FAIL: ${result.failReason}`)
    await page.screenshot({ path: join(OUT, '99-upgrade-failure.png') }).catch(() => {})
    process.exitCode = 1
  } finally {
    await writeFile(join(OUT, 'qa-upgrade.json'), JSON.stringify(result, null, 2))
    await close().catch(() => {})
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
