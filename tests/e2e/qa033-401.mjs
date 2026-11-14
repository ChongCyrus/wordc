/** 0.3.33「AI 补内容」浏览器回归（三项修复验证）。
 *  目标构建 index-C8u3v3Eu.js，127.0.0.1:4173，复用 /tmp/qa033-profile（自 qa032 复制并清 SW/Cache）。
 *  全程 mock（不调真实 API，花费 ¥0）；只写 tests/e2e、docs；不改 src。
 *  S1 per-c 例句显示 / S2 续跑同 deck 单 pack / S3 SW 新构建接管 / S4 401 不再显示上限摘要。 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ROOT, log, sleep, waitSeededHome, clickHomeLearn, enterAnnotation,
  openAiPanel, closeDialogs, waitPanelTarget, listPacks, listDrafts,
  injectPlanForWord, setupAi,
} from './ai-qa-lib.mjs'

const BASE = 'http://127.0.0.1:4173/'
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.33')
const PROFILE = process.env.QA_PROFILE || '/tmp/qa033-profile'
const RAW_PATH = join(ROOT, 'docs/qa/ai-0.3.33-401.json')
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
await mkdir(OUT, { recursive: true })

const raw = {
  startedAt: new Date().toISOString(), base: BASE, build: null, versionText: null, profile: PROFILE,
  scenarios: {}, findings: [], consoleErrors: [], pageErrors: [], cost: { realCalls: 0, yuan: 0 }, notes: [],
}
let seq = 0
const shot = async (page, name) => { const p = join(OUT, `${name}.png`); await page.screenshot({ path: p }).catch(() => {}); return `docs/assets/qa/ai-0.3.33/${name}.png` }
const finding = (id, sev, title, o = {}) => { raw.findings.push({ id, severity: sev, title, ...o }); log(`  [${sev}] ${id} ${title}`) }
const now = () => new Date().toISOString()

const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROMIUM, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: LIB },
  viewport: { width: 390, height: 844 }, locale: 'zh-CN', deviceScaleFactor: 1,
  serviceWorkers: 'block',
})
const page = context.pages()[0] ?? (await context.newPage())
const bag = { consoleErrors: [], pageErrors: [], texts: [] }
page.on('console', (m) => { bag.texts.push(m.text()); if (m.type() === 'error') bag.consoleErrors.push(m.text().slice(0, 400)) })
page.on('pageerror', (e) => bag.pageErrors.push(String(e?.stack ?? e).slice(0, 900)))
page.on('dialog', (d) => d.dismiss().catch(() => {}))

// ---------- mock provider ----------
const st = { calls: 0, tags: [], mode: 'ok', partialSlice: 0, delayMs: 0, log: [], realCalls: 0 }
function buildMock(user) {
  const km = /kind = (examples|phrases|mnemonics)/.exec(user)
  const kind = km ? km[1] : 'semantics'
  const start = user.indexOf('targets = ')
  if (start < 0) return null
  let end = km ? user.indexOf('\n请只输出', start) : user.indexOf('\n请先通读', start)
  if (end < 0) end = user.indexOf('\n', start)
  let targets
  try { targets = JSON.parse(user.slice(start + 10, end > start ? end : undefined)) } catch { return null }
  if (!Array.isArray(targets)) return null
  const tag = `${st.runTag || 'Q33'}${String.fromCharCode(65 + st.tags.length)}`
  const items = []
  for (const t of targets) {
    const mIdx = t.meaningIndex
    if (kind === 'examples') {
      items.push({ headword: t.headword, ...(mIdx != null ? { meaningIndex: mIdx } : {}), examples: [{ en: `${tag} example for ${t.headword} c${mIdx ?? '-'}`, cn: `${tag} 例句翻译 c${mIdx ?? '-'}` }] })
    } else if (kind === 'phrases') {
      items.push({ headword: t.headword, ...(mIdx != null ? { meaningIndex: mIdx } : {}), phrases: [{ en: `${t.headword} ${tag} up`, cn: `${tag} 词组翻译 c${mIdx ?? '-'}` }] })
    } else {
      items.push({ headword: t.headword, ...(mIdx != null ? { meaningIndex: mIdx } : {}), mnemonics: [{ type: 'assoc', text: `${tag} 助记 c${mIdx ?? '-'}` }] })
    }
  }
  const out = { items }
  if (st.partialSlice > 0) out.items = out.items.slice(0, st.partialSlice)
  st.tags.push({ tag, kind, targets: targets.length, sent: out.items.length, mIdx: targets.map((t) => t.meaningIndex ?? null) })
  st.log.push({ kind, tag, targets: targets.length, sent: out.items.length })
  return JSON.stringify(out)
}

await page.route('**/v1/chat/completions', async (route) => {
  st.calls += 1
  if (st.delayMs > 0) await sleep(st.delayMs)
  const req = route.request()
  let body = {}
  try { body = req.postDataJSON() ?? {} } catch { /* noop */ }
  const user = String((body?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '')
  if (user.includes('只用于连通性测试')) {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) })
  }
  if (st.mode === '401') {
    st.log.push({ kind: '401', tag: null })
    return route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'invalid api key' } }) })
  }
  const content = buildMock(user)
  if (content == null) {
    st.log.push({ kind: 'unparsed' })
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }) })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) })
})

// ---------- page helpers ----------
const panelEl = () => page.locator('.mm-dialog[aria-label="AI 扩充内容"]')
const panelText = async () => (await panelEl().innerText()).replace(/\s+/g, ' ')
const panelState = async () => page.evaluate(() => {
  const dlg = document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]')
  if (!dlg) return null
  return {
    text: (dlg.innerText || '').replace(/\s+/g, ' '),
    danger: [...dlg.querySelectorAll('.mm-danger-text')].map((el) => (el.innerText || '').replace(/\s+/g, ' ')),
    toasts: [...document.querySelectorAll('.mm-toast')].map((el) => (el.innerText || '').replace(/\s+/g, ' ')),
  }
})
const setKinds = async (gen, wanted) => {
  for (const kind of ['例句', '词组', '助记', '本义/引申链']) {
    const btn = gen.getByRole('button', { name: new RegExp(`^(✓ )?${kind.replace('/', '\\/')}$`) })
    if ((await btn.count()) === 0) continue
    const pressed = (await btn.getAttribute('aria-pressed')) === 'true'
    if (pressed !== wanted.includes(kind)) await btn.click()
  }
}
const clearDrafts = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const packs = await new Promise((res) => { const r = db.transaction('packs', 'readonly').objectStore('packs').getAll(); r.onsuccess = () => res(r.result) })
  const ids = packs.filter((p) => p.draft).map((p) => p.id)
  if (!ids.length) return 0
  const tx = db.transaction(['packs', 'packItems'], 'readwrite')
  for (const id of ids) {
    tx.objectStore('packs').delete(id)
    const all = tx.objectStore('packItems').getAll()
    all.onsuccess = () => { for (const it of all.result) if (it.packId === id) tx.objectStore('packItems').delete(it.id) }
  }
  await new Promise((r) => { tx.oncomplete = r; tx.onerror = r })
  return ids.length
})
const studyReady = async (headword) => {
  await clearDrafts()
  const injected = await injectPlanForWord(page, 1, { headword })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitSeededHome(page)
  await clickHomeLearn(page)
  await enterAnnotation(page)
  return injected
}
const wordDeep = (hw, wordId) => page.evaluate(async ({ headword, wordId }) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const get = (s) => new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  const words = await get('words')
  const word = words.find((w) => (wordId ? w.id === wordId : String(w.headword).toLowerCase() === String(headword).toLowerCase()))
  if (!word) return null
  return {
    id: word.id,
    meanings: (word.meanings ?? []).map((m, i) => ({ c: i + 1, id: m.meaningId, cn: m.cn, examples: (m.examples ?? []).map((e) => e.en) })),
    examples: (word.examples ?? []).map((e) => ({ en: e.en, meaningId: e.meaningId })),
    phrases: (word.phrases ?? []).map((e) => ({ en: e.en, meaningId: e.meaningId })),
    mnemonics: (word.mnemonics ?? []).map((m) => ({ type: m.type, text: m.text, meaningId: m.meaningId })),
  }
}, { headword: hw, wordId })
const annotation = () => page.evaluate(() => {
  const root = document.querySelector('.annotation-stage') ?? document.body
  const rows = [...root.querySelectorAll('.meanings > div')].map((d) => ({
    text: (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 110),
    examples: [...d.querySelectorAll('.meaning-example')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
    mnem: [...d.querySelectorAll('.meaning-mnemonic')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
  }))
  return {
    rows: rows.filter((r) => r.text.length > 0),
    examples: [...root.querySelectorAll('.example-item')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
    phrases: [...root.querySelectorAll('.phrase-row')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
    body: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 1500),
  }
})
const start = async (gen) => {
  const btn = gen.getByRole('button', { name: '开始生成', exact: true })
  await btn.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {})
  const box = await btn.boundingBox()
  return { btn, box }
}
const waitReview = async (timeout = 40000) => {
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  const ok = await review.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)
  return { review, ok }
}
const itemCount = (dlg) => dlg.getByRole('checkbox', { name: /^选择 / }).count()
const reviewInfo = async (rv) => {
  if (!rv.ok) return { shown: false, items: 0, title: '', text: '' }
  return {
    shown: true,
    items: await itemCount(rv.review),
    title: (await rv.review.locator('.mm-dialog__title, h2, h3').first().innerText().catch(() => '')).slice(0, 80),
    text: (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 900),
  }
}
const packItemsFor = (ids) => page.evaluate(async (packIds) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const all = await new Promise((res) => { const r = db.transaction('packItems', 'readonly').objectStore('packItems').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  return all.filter((i) => packIds.includes(i.packId)).map((i) => ({ packId: i.packId, status: i.status, skipReason: i.skipReason ?? null, meaningIndex: i.meaningIndex ?? null, headword: i.headword ?? null }))
}, ids)
const saveReview = async (rv) => {
  const before = await listPacks(page)
  const beforeIds = new Set(before.map((p) => p.id))
  const t0 = Date.now()
  let err = null
  try { await rv.review.getByRole('button', { name: /^保存已选/ }).click({ timeout: 20000 }) } catch (e) { err = String(e?.message ?? e).slice(0, 200) }
  const closed = await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 30000 }).then(() => true).catch(() => false)
  await sleep(1900)
  const after = await listPacks(page)
  const newPacks = after.filter((p) => !beforeIds.has(p.id))
  const newItems = await packItemsFor(newPacks.map((p) => p.id))
  return { closed, ms: Date.now() - t0, err, newPacks, newItems, annotation: await annotation(), packDelta: after.length - before.length }
}
const closeReview = async (rv) => {
  if (!rv.ok) return
  const btn = rv.review.getByRole('button', { name: '关闭', exact: true })
  if ((await btn.count()) > 0) await btn.click({ timeout: 5000 }).catch(() => {})
  await sleep(400)
}

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await waitSeededHome(page, 60000)
raw.build = (await page.content()).match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
await page.goto(BASE + '#/me', { waitUntil: 'domcontentloaded' })
await sleep(700)
raw.versionText = (await page.locator('body').innerText()).match(/v0\.3\.\d+/)?.[0] ?? null
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await waitSeededHome(page, 60000)
log(`build=${raw.build} version=${raw.versionText} profile=${PROFILE}`)
if (raw.build !== 'index-C8u3v3Eu.js') throw new Error(`构建不符：${raw.build}`)

// 复用 profile 的 AI 设置，仅确保为 mock 友好的确定性配置（假 Key，禁用真实调用）
await setupAi(page, { key: 'sk-QA-MOCK-KEY', maxCost: 3 })
raw.settings = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = await new Promise((res) => { const r = db.transaction('settings', 'readonly').objectStore('settings').getAll(); r.onsuccess = () => res(r.result) })
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return { enabled: m['ai.enabled'], provider: m['ai.provider'], keyStorage: m['ai.keyStorage'], hasKey: !!m['ai.apiKey'], maxCost: m['ai.maxCostPerRun'] }
})

const run = async (name, fn) => {
  log(`\n===== ${name} =====`)
  st.mode = 'ok'; st.partialSlice = 0; st.delayMs = 0; st.tags = []
  const t0 = Date.now(); const holder = {}
  try { const out = await fn(holder); raw.scenarios[name] = { ok: true, ms: Date.now() - t0, ...holder, ...(out ?? {}) }; log(`OK ${name} ${Math.round((Date.now() - t0) / 1000)}s`) }
  catch (e) { raw.scenarios[name] = { ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e).slice(0, 1500), ...holder }; log(`FAIL ${name}: ${e?.message ?? e}`) }
  raw.consoleErrors = bag.consoleErrors.slice(-20); raw.pageErrors = bag.pageErrors.slice(-10)
  await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
}

await run('S4 401干净复验', async (h) => {
  const out = {}
  st.runTag = 'S4C'
  h.word = await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(700)
  out.panelBefore = (await panelState())?.text?.slice(0, 700) ?? ''
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await waitPanelTarget(page, 1, 12000)
  await shot(page, 'S4C-01-ready')
  const s = await start(gen)
  st.mode = '401'; const c0 = st.calls
  await s.btn.click()
  await sleep(1500)
  const late = await panelState()
  out.late = late?.text?.slice(0, 900) ?? ''
  out.danger = late?.danger ?? []
  out.calls = st.calls - c0
  out.hasHttp401 = /HTTP\s*401/.test(out.late + ' ' + out.danger.join(' '))
  out.hasLimitText = /本次已达上限/.test(out.late)
  out.draftLeft = (await listDrafts(page)).length
  await shot(page, 'S4C-02-error-401')
  if (!out.hasHttp401) finding('C01','P1','401 文案未带 HTTP 401',{actual:out.late})
  if (out.hasLimitText) finding('C02','P1','401 仍显示「本次已达上限」摘要',{actual:out.late})
  return out
})
raw.cost = { realCalls: st.realCalls, yuan: 0 }
raw.finishedAt = now()
await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
log(`\n401 DONE findings=${raw.findings.length} calls=${st.calls}`)
await context.close()
