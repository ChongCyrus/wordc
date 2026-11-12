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
  const get = (s) => new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  const [words, packs, items, drafts] = await Promise.all([get('words'), get('packs'), get('packItems'), get('settings')])
  const addr = words.filter((w) => String(w.headword).toLowerCase() === 'address').map((w) => ({ id: w.id, deckId: w.deckId, meaningCount: (w.meanings ?? []).length, ex: (w.examples ?? []).length, ph: (w.phrases ?? []).length, mn: (w.mnemonics ?? []).length }))
  const packById = new Map(packs.map((p) => [p.id, p]))
  const rows = items.filter((i) => String(i.headwordLower) === 'address').map((i) => ({ id: i.id, pack: packById.get(i.packId)?.name, packStatus: packById.get(i.packId)?.status, wordId: i.wordId, meaningIndex: i.meaningIndex ?? null, status: i.status, skipReason: i.skipReason ?? null, ex: i.payload?.examples?.map((e) => e.en) ?? [], ph: i.payload?.phrases?.map((e) => e.en) ?? [], mn: i.payload?.mnemonics?.map((e) => e.text) ?? [] }))
  return { addr, packs: packs.map((p) => ({ id: p.id, name: p.name, status: p.status, kind: p.kind, checksum: p.checksum?.slice(0, 12), deckId: p.deckId ?? null, draft: p.draft ?? null })), rows }
})
console.log(JSON.stringify(data, null, 2))
await ctx.close()
