/**
 * task-177 视觉基线 diff 门禁（无第三方依赖：浏览器 canvas 解码 PNG）。
 * 用法：
 *   node tests/e2e/qa-visual-compare.mjs
 * 默认比较 docs/assets/e2e/qa-gate 下关键截图与 tests/e2e/fixtures/visual-baseline 同名基线；
 * 像素差异 > 1.5% 视为失败（明显裁切/布局回退）。
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const CURRENT = join(ROOT, 'docs/assets/e2e/qa-gate')
const BASELINE = join(ROOT, 'tests/e2e/fixtures/visual-baseline')
const CHROMIUM = process.env.E2E_CHROMIUM || join(ROOT, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(ROOT, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(ROOT, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const names = ['03-annotation-390.png', '04-panel-50-text-390.png', '06-panel-360.png']
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: LIB } })
const page = await browser.newPage()
const result = []
for (const name of names) {
  const cur = join(CURRENT, name)
  const base = join(BASELINE, name)
  if (!existsSync(cur) || !existsSync(base)) { result.push({ name, status: 'skip', reason: 'missing baseline/current' }); continue }
  const curB64 = (await readFile(cur)).toString('base64')
  const baseB64 = (await readFile(base)).toString('base64')
  const diff = await page.evaluate(async ([a, b]) => {
    const load = (data) => new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = `data:image/png;base64,${data}`
    })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    if (ia.width !== ib.width || ia.height !== ib.height) return { ratio: 1, sizeMismatch: true, wa: ia.width, ha: ia.height, wb: ib.width, hb: ib.height }
    const canvasA = new OffscreenCanvas(ia.width, ia.height)
    const canvasB = new OffscreenCanvas(ib.width, ib.height)
    const ca = canvasA.getContext('2d'); const cb = canvasB.getContext('2d')
    ca.drawImage(ia, 0, 0); cb.drawImage(ib, 0, 0)
    const da = ca.getImageData(0, 0, ia.width, ia.height).data
    const db = cb.getImageData(0, 0, ib.width, ib.height).data
    let changed = 0
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > 24 || Math.abs(da[i + 1] - db[i + 1]) > 24 || Math.abs(da[i + 2] - db[i + 2]) > 24) changed += 1
    }
    return { ratio: changed / (ia.width * ia.height), sizeMismatch: false }
  }, [curB64, baseB64])
  result.push({ name, ...diff, status: diff.ratio > 0.015 ? 'fail' : 'pass' })
}
await browser.close()
console.log(JSON.stringify(result, null, 2))
if (result.some((r) => r.status === 'fail')) process.exit(1)
