import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { loadMinimalFixture } from './qa-fixture.mjs'

const ROOT = '/root/workspace/背单词APP开发'
const CHROME = join(ROOT, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(ROOT, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(ROOT, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const BASE = 'http://127.0.0.1:4174/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'], env: { ...process.env, LD_LIBRARY_PATH: LIB } })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
const page = await ctx.newPage()
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE_ERR', m.text().slice(0, 200)) })
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 })
  await page.waitForFunction(async () => {
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const hasWord = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(Boolean(r.result)); r.onerror = () => res(false) })
      const hasDeck = await new Promise((res) => { const r = db.transaction('decks', 'readonly').objectStore('decks').get('kaoyan-2027-dagang'); r.onsuccess = () => res(Boolean(r.result)); r.onerror = () => res(false) })
      return hasWord && hasDeck
    } catch { return false }
  }, null, { timeout: 120000 })
  await page.waitForFunction(async () => {
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const n = await new Promise((res) => { const r = db.transaction('words','readonly').objectStore('words').count(); r.onsuccess = () => res(r.result); r.onerror = () => res(0) })
      return n > 1000
    } catch { return false }
  }, null, { timeout: 180000 })
  await sleep(1000)
  await loadMinimalFixture(page, join(ROOT, 'tests/e2e/fixtures/minimal-profile.json'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => /开始学习|继续学习/.test(document.body.innerText), null, { timeout: 60000 })
  await sleep(800)

  const payload = await readFile('/sdcard/Download/DSH-Go/背单词-本义助记-生成-2026-11-17.json', 'utf8')
  const result = await page.evaluate(async (text) => {
    const data = await import('/src/data/index.ts')
    const t0 = performance.now()
    const tFetch = performance.now() - t0
    const t1 = performance.now()
    const preview = await data.previewCoreSenseMnemonicImport(text)
    const tPreview = performance.now() - t1
    const t2 = performance.now()
    const applied = await data.applyCoreSenseMnemonicImport(text, { overwrite: false })
    const tApply = performance.now() - t2
    const word = await data.getWord('kaoyan-2027-dagang:embrace')
    return {
      bytes: text.length, tFetch: Math.round(tFetch), tPreview: Math.round(tPreview), tApply: Math.round(tApply),
      preview: { ok: preview.ok, counts: preview.counts, issues: preview.issues.slice(0, 3) },
      applied: { ok: applied.ok, counts: applied.counts, issues: applied.issues.slice(0, 3) },
      embrace: { senses: word?.senseMnemonics?.length ?? 0, overview: word?.coreSenseOverview?.text?.slice(0, 30) ?? null },
    }
  }, payload)
  console.log(JSON.stringify(result, null, 2))
} finally {
  await ctx.close(); await browser.close()
}
