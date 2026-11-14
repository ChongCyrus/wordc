#!/usr/bin/env node
/** 用私有构建（4173，含真实 v4 本义）拍一张注释面截图，供公开 README 展示「本义/引申链」。
 *  仅取 UI，不含词库名/受限商业词表字样。 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'

const HERE = '/root/workspace/背单词APP开发'
const CHROMIUM = join(HERE, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(HERE, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(HERE, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const OUT = join(HERE, 'docs/assets/demo/03-annotations.png')
const BASE = process.env.BASE ?? 'http://127.0.0.1:4173/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHome(page) {
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    const ok = await page.evaluate(() => {
      const t = document.body.innerText
      return document.querySelectorAll('.mm-kpi').length >= 3 && /待复习|开始学习|继续学习/.test(t)
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
  // 确保 seed 完成
  await page.waitForFunction(async () => {
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const meta = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
      return meta.some((m) => /seeded|packs\./i.test(String(m.key ?? '')))
    } catch { return false }
  }, null, { timeout: 180_000 }).catch(() => {})
  await sleep(1500)
  const start = page.getByRole('button', { name: /开始学习|继续学习/ }).first()
  await start.click()
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.locator('.board-stage').first().click()
  await page.locator('.word-text').first().waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(800)
  let text = await page.locator('body').innerText()
  // 若当前词没有本义，换下一词（最多 8 个）
  for (let i = 0; i < 8 && !/本义[1１]/.test(text); i++) {
    const know = page.getByRole('button', { name: /认识/ }).first()
    if (await know.count()) await know.click().catch(() => {})
    await sleep(700)
    const last = page.getByRole('button', { name: /回忆.*轻点进入注释面|回忆/ }).first()
    if (await last.count()) await last.click().catch(() => {})
    await sleep(700)
    text = await page.locator('body').innerText()
  }
  await page.screenshot({ path: OUT })
  console.log('shot', OUT, 'hasBenyi', /本义[1１]/.test(text))
  await browser.close()
}

main().catch((e) => { console.error(String(e)); process.exit(1) })
