/** 0.3.28 QA：预热持久化 profile（只做一次 seed，后续场景复用） */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'
const ROOT = join(import.meta.dirname, '..', '..')
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
const PROFILE = process.env.QA_PROFILE || '/tmp/qa028-profile'
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4190/'
const t0 = Date.now()
const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROMIUM, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: LIB },
  viewport: { width: 390, height: 844 }, locale: 'zh-CN',
})
const page = context.pages()[0] ?? await context.newPage()
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
const deadline = Date.now() + 300000
let ok = false
while (Date.now() < deadline) {
  ok = await page.evaluate(async () => {
    const text = document.body.innerText
    if (!document.querySelectorAll('.mm-kpi').length && !/开始学习|继续学习/.test(text)) return false
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const n = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').count(); r.onsuccess = () => res(r.result); r.onerror = () => res(0) })
      return n > 100
    } catch { return false }
  }).catch(() => false)
  if (ok) break
  await new Promise((r) => setTimeout(r, 1000))
}
console.log(JSON.stringify({ seeded: ok, seconds: Math.round((Date.now() - t0) / 1000), build: (await page.content()).match(/index-[A-Za-z0-9_-]+\.js/)?.[0] }))
await context.close()
