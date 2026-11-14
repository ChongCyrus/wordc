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
const RAW_PATH = join(ROOT, 'docs/qa/ai-0.3.33-raw.json')
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
  const tag = `Q33${String.fromCharCode(65 + st.tags.length)}`
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

// ---------- S1 per-c 例句显示（c1+c2 append → mock 2 条 → 保存 → 注解面 c1/c2 行显示 en/cn） ----------
await run('S1 per-c例句显示', async (h) => {
  const out = {}
  h.word = await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(800)
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await sleep(400)
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if ((await c2.count()) === 0) throw new Error('词不足 2 含义')
  if (!(await c1.isChecked())) await c1.click()
  await waitPanelTarget(page, 1, 12000)
  if (!(await c2.isChecked())) await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  await shot(page, 'S1-01-ready')

  const c0 = st.calls
  const s = await start(gen)
  await s.btn.click()
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.review = await reviewInfo(rv)
  out.reviewPerC = /c1[^→]*→\s*\[例句\]/.test(out.review.text) && /c2[^→]*→\s*\[例句\]/.test(out.review.text)
  await shot(page, 'S1-02-review')
  if (out.review.items !== 2) finding('F01', 'P0', `per-c 例句审核 ${out.review.items} 条（期望 2）`, { actual: out.review.text })
  if (!rv.ok) return out

  const sv = await saveReview(rv)
  out.save = { closed: sv.closed, ms: sv.ms, packDelta: sv.packDelta }
  out.newItems = sv.newItems.map((i) => ({ status: i.status, skipReason: i.skipReason, meaningIndex: i.meaningIndex }))
  out.deep = await wordDeep('address', h.word?.wordId)
  out.annotation = sv.annotation
  out.perCAnnotations = sv.annotation.rows.map((r, i) => ({ c: i + 1, examples: r.examples }))
  out.landed = {
    c1: out.deep?.meanings?.[0]?.examples?.filter((e) => /Q33/.test(e)) ?? [],
    c2: out.deep?.meanings?.[1]?.examples?.filter((e) => /Q33/.test(e)) ?? [],
  }
  out.domC1 = out.perCAnnotations[0]?.examples ?? []
  out.domC2 = out.perCAnnotations[1]?.examples ?? []
  await shot(page, 'S1-03-after-save')
  if (!sv.closed) finding('F02', 'P1', '保存后面板未关闭', {})
  if (out.landed.c1.length === 0 || out.landed.c2.length === 0) finding('F03', 'P0', 'DB 未分别给 c1/c2 写入例句', { actual: JSON.stringify(out.landed) })
  if (!out.domC1.some((t) => /Q33/.test(t)) || !out.domC2.some((t) => /Q33/.test(t))) finding('F04', 'P1', '注解面 c1/c2 行未显示对应例句', { actual: JSON.stringify(out.perCAnnotations) })
  out.noRefreshNeeded = true
  raw.notes.push(`S1 注解面 c 行例句：c1=${JSON.stringify(out.domC1)} c2=${JSON.stringify(out.domC2)}`)
  return out
})

// ---------- S2 续跑同 deck 单 pack：首轮 1 条 → 关审核重开继续 → 再生成保存 → 同 deck 应 1 个 applied pack ----------
const packsFull = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const packs = await new Promise((res) => { const r = db.transaction('packs', 'readonly').objectStore('packs').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  return packs
})

await run('S2 续跑同deck单pack', async (h) => {
  const out = {}
  h.word = await studyReady('address')
  let gen = await openAiPanel(page)
  await sleep(800)
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await sleep(400)
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if ((await c2.count()) === 0) throw new Error('词不足 2 含义')
  if (!(await c1.isChecked())) await c1.click()
  await waitPanelTarget(page, 1, 12000)
  if (!(await c2.isChecked())) await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  await shot(page, 'S2-01-ready')

  st.partialSlice = 1
  const c0 = st.calls
  const s = await start(gen)
  await s.btn.click()
  let rv = await waitReview(30000)
  out.first = { ...(await reviewInfo(rv)), calls: st.calls - c0, log: st.log.slice(-2) }
  out.draftAfterFirst = (await listDrafts(page)).map((d) => ({ done: d.done, cursor: d.draft?.cursor, total: d.draft?.targetTotal }))
  await shot(page, 'S2-02-first-partial')
  await closeReview(rv)
  await closeDialogs(page)
  await sleep(400)

  gen = await openAiPanel(page)
  await sleep(900)
  out.resumePanel = (await panelText()).slice(0, 400)
  const resumeBtn = gen.getByRole('button', { name: '继续', exact: true })
  out.resumeVisible = await resumeBtn.isVisible().catch(() => false)
  if (out.resumeVisible) await resumeBtn.click()
  await sleep(700)
  rv = await waitReview(15000)
  out.resumed = await reviewInfo(rv)
  await shot(page, 'S2-03-resume-review')
  await closeReview(rv)

  st.partialSlice = 0; st.tags = []; const c1all = st.calls
  const s2 = await start(gen)
  await s2.btn.click()
  rv = await waitReview(30000)
  out.second = { ...(await reviewInfo(rv)), calls: st.calls - c1all, log: st.log.slice(-2) }
  await shot(page, 'S2-04-resume-plus-new-review')
  if (out.second.items !== 2) finding('F05', 'P0', `续跑后审核 ${out.second.items} 条（期望历史+本次=2）`, { actual: out.second.text })
  if (!rv.ok) return out

  const before = await packsFull(page)
  const beforeIds = new Set(before.map((p) => p.id))
  const beforeDeckIds = [...new Set(before.filter((p) => p.status === 'applied').map((p) => p.meta?.deckId ?? null))]
  out.deckBefore = beforeDeckIds
  const sv = await saveReview(rv)
  out.save = { closed: sv.closed, ms: sv.ms, err: sv.err, packDelta: sv.packDelta }
  const after = await packsFull(page)
  const newPacks = after.filter((p) => !beforeIds.has(p.id))
  const newItems = await packItemsFor(newPacks.map((p) => p.id))
  const appliedItems = newItems.filter((i) => i.status === 'applied')
  const byPack = newPacks.map((p) => ({
    id: p.id, name: p.name, kind: p.kind, status: p.status,
    deckId: p.meta?.deckId ?? p.deckId ?? null,
    meta: p.meta ?? null,
    items: newItems.filter((i) => i.packId === p.id).length,
    applied: newItems.filter((i) => i.packId === p.id && i.status === 'applied').length,
  }))
  out.newPacks = byPack
  out.newItems = newItems.map((i) => ({ status: i.status, skipReason: i.skipReason, meaningIndex: i.meaningIndex }))
  out.applied = appliedItems.length
  out.appliedPacks = byPack.filter((p) => p.applied > 0).length
  out.deckOfPacks = [...new Set(byPack.map((p) => p.deckId))]
  out.deep = await wordDeep('address', h.word?.wordId)
  out.annotation = sv.annotation
  out.landed = {
    c1: out.deep?.meanings?.[0]?.examples?.filter((e) => /Q33/.test(e)) ?? [],
    c2: out.deep?.meanings?.[1]?.examples?.filter((e) => /Q33/.test(e)) ?? [],
  }
  out.domC1 = sv.annotation.rows[0]?.examples ?? []
  out.domC2 = sv.annotation.rows[1]?.examples ?? []
  await shot(page, 'S2-05-after-save')
  if (!sv.closed) finding('F06', 'P1', '保存后面板未关闭', {})
  if (out.applied !== 2) finding('F07', 'P0', `续跑保存 applied ${out.applied} 条（期望 2）`, { actual: JSON.stringify({ items: out.newItems, packs: byPack }) })
  if (out.appliedPacks !== 1) finding('F08', 'P0', `同 deck 续跑产生 ${out.appliedPacks} 个 applied pack（期望 1）`, { actual: JSON.stringify(byPack) })
  if (newItems.some((i) => i.skipReason === 'limit')) finding('F09', 'P1', '续跑保存出现 skipReason=limit', { actual: JSON.stringify(out.newItems) })
  raw.notes.push(`S2 packs=${JSON.stringify(byPack)}`)
  return out
})

// ---------- S3 SW 新构建接管 ----------
await run('S3 SW新构建接管', async (h) => {
  const out = {}
  out.entry = raw.build
  out.scriptSrc = await page.evaluate(() => [...document.scripts].map((s) => s.src).filter(Boolean))
  out.resources = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /assets\/index-.*\.js/.test(n)))
  out.controller = await page.evaluate(() => navigator.serviceWorker?.controller?.scriptURL ?? null)
  out.registrations = await page.evaluate(async () => {
    try { const rs = await navigator.serviceWorker?.getRegistrations?.() ?? []; return rs.map((r) => ({ scope: r.scope, active: r.active?.scriptURL ?? null, waiting: r.waiting?.scriptURL ?? null, installing: r.installing?.scriptURL ?? null })) } catch (e) { return [{ error: String(e) }] }
  })
  const swResp = await context.request.get(BASE + 'sw.js')
  out.swStatus = swResp.status()
  const swText = await swResp.text()
  out.swBytes = swText.length
  out.hasSkipWaiting = /skipWaiting/.test(swText)
  out.hasClientsClaim = /clientsClaim/.test(swText)
  out.hasCleanup = /cleanupOutdatedCaches/.test(swText)
  out.hasNewBuildInManifest = /index-C8u3v3Eu\.js/.test(swText)
  out.hasOldBuildInManifest = /index-DkmxpqUg\.js/.test(swText)
  out.swSnippet = (swText.match(/skipWaiting[^\n]{0,120}/)?.[0] ?? '') + ' | ' + (swText.match(/clientsClaim[^\n]{0,120}/)?.[0] ?? '')
  out.caches = await page.evaluate(async () => {
    const keys = await caches.keys()
    const out = []
    for (const k of keys) {
      const c = await caches.open(k)
      out.push({ name: k, entries: (await c.keys()).map((r) => r.url) })
    }
    return out
  })
  out.cachedIndexJs = out.caches.flatMap((c) => c.entries).filter((u) => /assets\/index-.*\.js/.test(u))
  out.oldIndexCached = out.cachedIndexJs.some((u) => /index-DkmxpqUg\.js/.test(u))
  out.oldHtmlCached = out.caches.flatMap((c) => c.entries).filter((u) => /index\.html$/.test(u))
  await shot(page, 'S3-01-build')
  if (out.entry !== 'index-C8u3v3Eu.js') finding('F10', 'P0', `页面入口非 0.3.33：${out.entry}`, { actual: JSON.stringify(out.scriptSrc) })
  if (!out.hasSkipWaiting || !out.hasClientsClaim) finding('F11', 'P1', `sw.js 缺少 skipWaiting/clientsClaim`, { actual: out.swSnippet })
  if (out.hasOldBuildInManifest) finding('F12', 'P1', 'sw.js precache 清单仍含旧构建', {})
  if (out.oldIndexCached) finding('F13', 'P2', 'CacheStorage 仍缓存旧 index-*.js（需说明复现步骤）', { actual: JSON.stringify(out.cachedIndexJs) })
  raw.notes.push(`S3 controller=${out.controller} regs=${JSON.stringify(out.registrations)} caches=${JSON.stringify(out.caches.map((c) => c.name))} cachedIndex=${JSON.stringify(out.cachedIndexJs)}`)
  return out
})

// ---------- S4 401 不再显示「本次已达上限」 ----------
await run('S4 401错误提示', async (h) => {
  const out = {}
  h.word = await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(800)
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await waitPanelTarget(page, 1, 12000)
  const s = await start(gen)
  st.mode = '401'; const c0 = st.calls
  await s.btn.click()
  await sleep(900)
  out.early = await panelState()
  await sleep(1400)
  out.late = await panelState()
  out.calls = st.calls - c0
  out.text = (out.late?.text ?? '').slice(0, 900)
  out.hasHttp401 = /HTTP\s*401/.test((out.late?.text ?? '') + ' ' + (out.late?.danger ?? []).join(' '))
  out.hasLimitText = /本次已达上限/.test(out.late?.text ?? '')
  out.hasErrorLine = /Key 无效|HTTP\s*401/.test(out.late?.danger?.join(' ') ?? '')
  out.draftLeft = (await listDrafts(page)).length
  await shot(page, 'S4-01-error-401')
  if (!out.hasErrorLine) finding('F14', 'P1', '401 未显示错误面板/文案', { actual: out.text })
  if (!out.hasHttp401) finding('F15', 'P1', '401 文案未带 HTTP 401', { actual: out.text })
  if (out.hasLimitText) finding('F16', 'P1', '401 时仍显示「本次已达上限」摘要', { actual: out.text })
  return out
})

raw.cost = { realCalls: st.realCalls, yuan: 0 }
raw.consoleErrors = bag.consoleErrors.slice(-20)
raw.pageErrors = bag.pageErrors.slice(-10)
raw.finishedAt = now()
raw.notes.push(`mock 请求总数 ${st.calls}；真实 API 0 次`)
await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
log(`\nDONE findings=${raw.findings.length} mockCalls=${st.calls} realCalls=${st.realCalls}`)
await context.close()
