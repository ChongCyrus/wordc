import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { join } from 'node:path'
import { ROOT } from './ai-qa-lib.mjs'
const CH = join(ROOT, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(ROOT, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(ROOT, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const ctx = await chromium.launchPersistentContext('/tmp/qa030-profile', { executablePath: CH, headless: true, args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: LIB }, viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = ctx.pages()[0] ?? await ctx.newPage()
await page.goto('http://127.0.0.1:4173/', { waitUntil: 'domcontentloaded' })
await new Promise((r) => setTimeout(r, 4000))
const data = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const w = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').get('kaoyan-2027-dagang:address'); r.onsuccess = () => res(r.result) })
  return { examples: (w.examples ?? []).map((e) => ({ en: e.en, m: e.meaningId ?? null })), phrases: (w.phrases ?? []).map((e) => ({ en: e.en, m: e.meaningId ?? null })), mnemonics: (w.mnemonics ?? []).map((m) => ({ type: m.type, text: m.text, m: m.meaningId ?? null })) }
})
console.log(JSON.stringify(data, null, 2))
await ctx.close()
