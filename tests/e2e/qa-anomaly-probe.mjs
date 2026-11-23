#!/usr/bin/env node
/** 0.4.0-A anomaly gate 最小对照 probe（不调真实 API）。用法：
 *  E2E_CHROMIUM=/usr/bin/google-chrome node tests/e2e/qa-anomaly-probe.mjs
 *  或本机：E2E_CHROMIUM=/root/.cache/.../chrome node tests/e2e/qa-anomaly-probe.mjs
 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
const ROOT = '/root/workspace/背单词APP开发'
const BASE = (process.env.QA_BASE || process.env.E2E_BASE || 'http://127.0.0.1:4173/').replace(/\/?$/, '/')
const EXE = process.env.E2E_CHROMIUM || `${ROOT}/tools/e2e/chromium/usr/lib/chromium/chromium`
const LIB = [`${ROOT}/tools/e2e/chromium/usr/lib/aarch64-linux-gnu`, `${ROOT}/tools/e2e/chromium/usr/lib/chromium`].join(':')
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: LIB } })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', colorScheme: 'dark' })
const page = await ctx.newPage()
await page.addInitScript(() => {
  window.__calls = { getFlag: [], save: [], diag: [] }
  window.MomoBridge = {
    isNativeApp: () => 'momo-apk',
    getFlag: (k) => { window.__calls.getFlag.push(k); return k === 'hadProgress' ? '1' : '' },
    setFlag: () => 'ok',
    saveAutoBackup: () => { window.__calls.save.push(1); return 'ok:/x' },
    listAutoBackups: () => '[]', readAutoBackup: () => '{}',
    deleteAutoBackup: () => 'ok', pruneAutoBackups: () => 'ok:0',
    appendDiagLog: (t) => { window.__calls.diag.push(t); return 'ok:/log' },
    getWebViewStorageInfo: () => '{}', selfTestAutoBackup: () => '{}',
    readDiagnosticFile: () => '{}', exportBackupToDownloads: () => 'ok:/d',
  }
})
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res) => { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').put({ key: 'data.autoBackupEnabled', value: true, updatedAt: Date.now() }); tx.oncomplete = res })
  await new Promise((res) => { const tx = db.transaction('states', 'readwrite'); tx.objectStore('states').clear(); tx.oncomplete = res })
})
await page.reload({ waitUntil: 'domcontentloaded' })
await page.waitForTimeout(8000)
const out = await page.evaluate(() => ({
  calls: window.__calls,
  visibility: document.visibilityState,
  scripts: [...document.scripts].map((s) => s.src).filter(Boolean),
  dialog: document.querySelector('[role="dialog"]')?.textContent?.slice(0, 120) ?? '',
  bodyHasAnomaly: /学习进度异常|检测到学习进度异常/.test(document.body.innerText),
  body: document.body.innerText.replace(/\s+/g,' ').slice(0,160),
}))
console.log(JSON.stringify(out, null, 2))
await browser.close()
