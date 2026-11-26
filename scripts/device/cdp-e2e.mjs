#!/usr/bin/env node
// 真机 WebView E2E：通过 App 内 CDP 代理（127.0.0.1:9222）用 Playwright 驱动 QA 包。
// 前提：QA debuggable(0.16.2+) 已启动。
import { chromium } from 'playwright-core'

const base = process.argv[2] || 'http://127.0.0.1:9222'
const browser = await chromium.connectOverCDP(base, { noDefaults: true })
const contexts = browser.contexts()
const page = contexts.flatMap((c) => c.pages()).find((p) => p.url().includes('appassets.local'))
if (!page) throw new Error('未找到 WebView 页面')
console.log('connected:', page.url())

await page.waitForSelector('text=今日任务', { timeout: 30000 })
const home = await page.locator('body').innerText()
if (!/今日任务/.test(home)) throw new Error('首页未加载')
if (!/继续学习|开始学习|添加今日新单词/.test(home)) throw new Error('首页 CTA 异常')
console.log('home ok:', home.split('\n').slice(0, 6).join(' | '))

await page.getByText('我的', { exact: true }).last().click()
await page.waitForTimeout(800)
const mine = await page.locator('body').innerText()
if (!/检查点|导入与导出|迁移与修复/.test(mine)) throw new Error('我的页异常')
console.log('mine ok')

await page.getByText('导入与导出', { exact: false }).first().click()
await page.waitForTimeout(800)
const io = await page.locator('body').innerText()
if (!/学习进度|自动备份|从自动备份恢复/.test(io)) throw new Error('导入导出页异常')
console.log('io ok')
await page.screenshot({ path: 'device-cdp-e2e.png' })
console.log('PASS')
await browser.close()
