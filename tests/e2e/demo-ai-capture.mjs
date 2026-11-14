#!/usr/bin/env node
/** 公开版新功能截图：AI 补内容面板、内容包管理（4174 公共构建）。 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'

const HERE = '/root/workspace/背单词APP开发'
const CHROMIUM = join(HERE, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(HERE, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(HERE, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const OUT = join(HERE, 'docs/assets/demo')
const BASE = process.env.BASE ?? 'http://127.0.0.1:4174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHome(page) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      const t = document.body.innerText
      return document.querySelectorAll('.mm-kpi').length >= 3 && /待复习/.test(t) && /开始学习|继续学习/.test(t)
    })
    if (ok) return
    await page.waitForTimeout(300)
  }
  throw new Error('home wait timeout')
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: LIB },
  })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', deviceScaleFactor: 2, colorScheme: 'dark' })
  const page = await ctx.newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitHome(page)
  await page.waitForFunction(async () => {
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const meta = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
      return meta.some((m) => /seeded|packs\./i.test(String(m.key ?? '')))
    } catch { return false }
  }, null, { timeout: 180_000 }).catch(() => {})
  await sleep(1200)
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('.board-stage').first().click()
  await page.locator('.word-text').first().waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(600)
  await page.locator('.study-topbar [aria-label="更多"]').first().click()
  await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).first().click()
  await page.locator('.mm-dialog[aria-label="AI 扩充内容"]').waitFor({ state: 'visible', timeout: 15_000 })
  await sleep(800)
  await page.screenshot({ path: join(OUT, '08-ai-generate.png') })
  console.log('shot 08-ai-generate.png')
  // 内容包管理（设置页）
  await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
  await page.getByText('内容包', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.getByText('内容包', { exact: true }).first().scrollIntoViewIfNeeded()
  await sleep(800)
  await page.screenshot({ path: join(OUT, '09-content-packs.png') })
  console.log('shot 09-content-packs.png')
  await browser.close()
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
