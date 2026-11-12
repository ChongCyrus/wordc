/** 0.3.32「AI 补内容」浏览器回归（task-132 六项修复验证）。
 *  目标构建 index-DkmxpqUg.js，127.0.0.1:4173，复用 /tmp/qa032-profile（自 qa030 复制，IDB origin 4173）。
 *  全程 mock（不调真实 API，花费 ¥0）；只写 tests/e2e、docs；不改 src。
 *  S1 续跑历史 / S2 助记 done2/2 弹审核 / S3 多 c 例句显示 / S4 append 词组不被 limit skip
 *  S5 401 错误带 HTTP / S6 双击开始不取消。 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ROOT, log, sleep, waitSeededHome, clickHomeLearn, enterAnnotation,
  openAiPanel, closeDialogs, waitPanelTarget, listPacks, listDrafts,
  injectPlanForWord, setupAi,
} from './ai-qa-lib.mjs'

const BASE = 'http://127.0.0.1:4173/'
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.32')
const PROFILE = process.env.QA_PROFILE || '/tmp/qa032-profile'
const RAW_PATH = join(ROOT, 'docs/qa/ai-0.3.32-raw.json')
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
await mkdir(OUT, { recursive: true })

const raw = {
  startedAt: new Date().toISOString(), base: BASE, build: null, versionText: null, profile: PROFILE,
  scenarios: {}, findings: [], consoleErrors: [], pageErrors: [], cost: { realCalls: 0, yuan: 0 }, notes: [],
}
let seq = 0
const shot = async (page, name) => { const p = join(OUT, `${name}.png`); await page.screenshot({ path: p }).catch(() => {}); return `docs/assets/qa/ai-0.3.32/${name}.png` }
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
  const tag = `Q32${String.fromCharCode(65 + st.tags.length)}`
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
const packItemsFor = (ids) => page.evaluate(async (packIds) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const all = await new Promise((res) => { const r = db.transaction('packItems', 'readonly').objectStore('packItems').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  return all.filter((i) => packIds.includes(i.packId)).map((i) => ({ packId: i.packId, status: i.status, skipReason: i.skipReason ?? null, meaningIndex: i.meaningIndex ?? null, wordId: i.wordId ?? null, headword: i.headword ?? null, payload: i.payload }))
}, ids)
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
if (raw.build !== 'index-DkmxpqUg.js') throw new Error(`构建不符：${raw.build}`)

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

// ---------- S1 续跑历史：首轮只返回 1 条 → 关审核框 → 重开继续 → 再生成 → 审核 2 条 → 保存 2 条 ----------
await run('S1 续跑历史', async (h) => {
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
  await shot(page, 'S1-01-ready')

  // 首轮：mock 只给 1 条（c1），c2 无内容
  st.partialSlice = 1; const c0 = st.calls
  const s = await start(gen)
  await s.btn.click()
  let rv = await waitReview(30000)
  out.first = { ...(await reviewInfo(rv)), calls: st.calls - c0, log: st.log.slice(-2) }
  out.first.panel = (await panelState().catch(() => null))?.text?.slice(0, 500) ?? ''
  out.draftAfterFirst = (await listDrafts(page)).map((d) => ({ done: d.done, cursor: d.draft?.cursor, total: d.draft?.targetTotal, items: d.items }))
  await shot(page, 'S1-02-first-partial')
  await closeReview(rv)
  await closeDialogs(page)
  await sleep(400)

  // 重开面板 → 继续 → 审核框应含历史 1 条
  gen = await openAiPanel(page)
  await sleep(900)
  out.resumePanel = (await panelText()).slice(0, 400)
  const resumeBtn = gen.getByRole('button', { name: '继续', exact: true })
  out.resumeVisible = await resumeBtn.isVisible().catch(() => false)
  if (out.resumeVisible) await resumeBtn.click()
  await sleep(700)
  rv = await waitReview(15000)
  out.resumed = await reviewInfo(rv)
  await shot(page, 'S1-03-resume-review')
  await closeReview(rv)

  // 再生成：历史 c1 + 本次 c2 → 审核 2 条
  st.partialSlice = 0; st.tags = []; const c1all = st.calls
  const s2 = await start(gen)
  await s2.btn.click()
  rv = await waitReview(30000)
  out.second = { ...(await reviewInfo(rv)), calls: st.calls - c1all, log: st.log.slice(-2) }
  await shot(page, 'S1-04-resume-plus-new-review')
  if (out.second.items !== 2) finding('F01', 'P0', `续跑后审核 ${out.second.items} 条（期望历史+本次=2）`, { actual: out.second.text })
  if (!rv.ok) return out

  const sv = await saveReview(rv)
  out.save = { closed: sv.closed, ms: sv.ms, err: sv.err, packDelta: sv.packDelta, packs: sv.newPacks.map((p) => ({ id: p.id, name: p.name, kind: p.kind })) }
  out.newItems = sv.newItems.map((i) => ({ status: i.status, skipReason: i.skipReason, meaningIndex: i.meaningIndex, wordId: i.wordId }))
  out.applied = sv.newItems.filter((i) => i.status === 'applied').length
  out.skipped = sv.newItems.filter((i) => i.status === 'skipped').length
  out.deep = await wordDeep('address', h.word?.wordId)
  out.annotation = sv.annotation
  out.landed = {
    c1: out.deep?.meanings?.[0]?.examples?.filter((e) => /Q32/.test(e)) ?? [],
    c2: out.deep?.meanings?.[1]?.examples?.filter((e) => /Q32/.test(e)) ?? [],
  }
  await shot(page, 'S1-05-after-save')
  if (!sv.closed) finding('F02', 'P1', '保存后审核框/面板未关闭', {})
  const landedCount = (out.landed.c1.length + out.landed.c2.length)
  if (landedCount !== 2) finding('F03', 'P0', `续跑保存落地 ${landedCount} 条（期望 2）`, { actual: JSON.stringify({ applied: out.applied, items: out.newItems, landed: out.landed }) })
  if (out.newItems.some((i) => i.skipReason === 'limit')) finding('F04', 'P1', '续跑保存出现 skipReason=limit', { actual: JSON.stringify(out.newItems) })
  return out
})

// ---------- S2 助记 done2/2 弹审核（mock 2 条） ----------
await run('S2 助记done2/2弹审核', async (h) => {
  const out = {}
  h.word = await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(800)
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  await setKinds(gen, ['助记'])
  await gen.getByLabel('助记生成模式').selectOption('append')
  await sleep(400)
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if (!(await c1.isChecked())) await c1.click()
  await waitPanelTarget(page, 1, 12000)
  if (!(await c2.isChecked())) await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  await shot(page, 'S2-01-ready')

  const c0 = st.calls
  const s = await start(gen)
  await s.btn.click()
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.progressPanelBeforeReview = (await panelState().catch(() => null))
  out.review = await reviewInfo(rv)
  out.hasLimitText = /本次已达上限/.test(out.review.text)
  out.perC = /c1[^→]*→\s*\[assoc\]/.test(out.review.text) && /c2[^→]*→\s*\[assoc\]/.test(out.review.text)
  out.draft = (await listDrafts(page)).map((d) => ({ done: d.done, cursor: d.draft?.cursor, total: d.draft?.targetTotal }))
  await shot(page, 'S2-02-review')
  if (!rv.ok) { finding('F05', 'P0', '助记 done2/2 未弹审核框', { actual: out.progressPanelBeforeReview?.text }); return out }
  if (out.review.items !== 2) finding('F06', 'P0', `助记审核 ${out.review.items} 条（期望 2）`, { actual: out.review.text })
  if (out.hasLimitText) finding('F07', 'P1', '助记完成态仍显示「本次已达上限」', { actual: out.review.text })
  if (!out.perC) finding('F08', 'P1', '审核框未显示「cX 中文 → [类型]」', { actual: out.review.text })

  const sv = await saveReview(rv)
  out.save = { closed: sv.closed, ms: sv.ms, err: sv.err, packDelta: sv.packDelta }
  out.newItems = sv.newItems.map((i) => ({ status: i.status, skipReason: i.skipReason, meaningIndex: i.meaningIndex }))
  out.annotation = sv.annotation
  out.deep = await wordDeep('address', h.word?.wordId)
  out.rows = sv.annotation.rows.filter((r) => r.mnem.length > 0).map((r) => r.mnem)
  await shot(page, 'S2-03-after-save')
  if (out.newItems.filter((i) => i.status === 'applied').length !== 2) finding('F09', 'P0', `助记落地 ${out.newItems.filter((i) => i.status === 'applied').length} 条（期望 2）`, { actual: JSON.stringify(out.newItems) })
  if (out.rows.length < 2 || !/Q32/.test(JSON.stringify(out.rows[0])) || !/Q32/.test(JSON.stringify(out.rows[1]))) finding('F10', 'P1', '助记未分别挂到 c1/c2 行', { actual: JSON.stringify(out.rows.slice(0, 3)) })
  return out
})

// ---------- S3 多 c 例句显示：c1+c2 例句保存后注解面每个 c 行显示对应例句 ----------
await run('S3 多c例句显示', async (h) => {
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
  if (!(await c1.isChecked())) await c1.click()
  await waitPanelTarget(page, 1, 12000)
  if (!(await c2.isChecked())) await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  await shot(page, 'S3-01-ready')

  const c0 = st.calls
  const s = await start(gen)
  await s.btn.click()
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.review = await reviewInfo(rv)
  await shot(page, 'S3-02-review')
  if (out.review.items !== 2) finding('F11', 'P0', `多 c 例句审核 ${out.review.items} 条（期望 2）`, { actual: out.review.text })
  if (!rv.ok) return out

  const sv = await saveReview(rv)
  out.save = { closed: sv.closed, ms: sv.ms, packDelta: sv.packDelta }
  out.newItems = sv.newItems.map((i) => ({ status: i.status, skipReason: i.skipReason, meaningIndex: i.meaningIndex }))
  out.deep = await wordDeep('address', h.word?.wordId)
  out.annotation = sv.annotation
  out.perCAnnotations = sv.annotation.rows.map((r, i) => ({ c: i + 1, examples: r.examples }))
  out.landed = {
    c1: out.deep?.meanings?.[0]?.examples?.filter((e) => /Q32/.test(e)) ?? [],
    c2: out.deep?.meanings?.[1]?.examples?.filter((e) => /Q32/.test(e)) ?? [],
  }
  out.domC1 = out.perCAnnotations[0]?.examples ?? []
  out.domC2 = out.perCAnnotations[1]?.examples ?? []
  await shot(page, 'S3-03-after-save')
  if (out.landed.c1.length === 0 || out.landed.c2.length === 0) finding('F12', 'P0', 'DB 未分别给 c1/c2 写入例句', { actual: JSON.stringify(out.landed) })
  if (!out.domC1.some((t) => /Q32/.test(t)) || !out.domC2.some((t) => /Q32/.test(t))) finding('F13', 'P1', '注解面 c1/c2 行未显示对应例句', { actual: JSON.stringify(out.perCAnnotations) })
  raw.notes.push(`S3 注解面 c 行例句：c1=${JSON.stringify(out.domC1)} c2=${JSON.stringify(out.domC2)}`)
  return out
})

// ---------- S4 append 词组不被 limit skip（例句+词组 append） ----------
await run('S4 append词组不被limit跳过', async (h) => {
  const out = {}
  h.word = await studyReady('address')
  const before = await wordDeep('address', h.word?.wordId)
  out.phrasesBefore = before?.phrases?.length ?? 0
  const gen = await openAiPanel(page)
  await sleep(800)
  await setKinds(gen, ['例句', '词组'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await gen.getByLabel('词组生成模式').selectOption('append')
  out.target = await waitPanelTarget(page, 2, 15000)
  await shot(page, 'S4-01-ready')

  const c0 = st.calls
  const s = await start(gen)
  await s.btn.click()
  const rv = await waitReview(40000)
  out.calls = st.calls - c0
  out.review = await reviewInfo(rv)
  out.replaceNotice = /将替换/.test(out.review.text)
  await shot(page, 'S4-02-review')
  if (out.review.items !== 2) finding('F14', 'P1', `多 kind 审核 ${out.review.items} 条（期望 2）`, { actual: out.review.text })
  if (!rv.ok) return out

  const sv = await saveReview(rv)
  out.save = { closed: sv.closed, ms: sv.ms, packDelta: sv.packDelta }
  out.newItems = sv.newItems.map((i) => ({ status: i.status, skipReason: i.skipReason, meaningIndex: i.meaningIndex, payload: i.payload }))
  out.limitSkips = sv.newItems.filter((i) => i.skipReason === 'limit').length
  out.deep = await wordDeep('address', h.word?.wordId)
  out.annotation = sv.annotation
  out.phrasesAfter = out.deep?.phrases?.length ?? 0
  out.newPhrases = (out.deep?.phrases ?? []).filter((p) => /Q32/.test(p.en)).map((p) => p.en)
  out.newExamples = (out.deep?.examples ?? []).filter((e) => /Q32/.test(e.en)).map((e) => e.en)
  out.domPhrases = sv.annotation.phrases.filter((x) => /Q32/.test(x))
  out.domExamples = sv.annotation.examples.filter((x) => /Q32/.test(x))
  await shot(page, 'S4-03-after-save')
  if (out.limitSkips > 0) finding('F15', 'P0', `append 词组仍被 limit 跳过 ${out.limitSkips} 条`, { actual: JSON.stringify(out.newItems) })
  if (out.newPhrases.length === 0) finding('F16', 'P0', 'append 词组未落地', { actual: JSON.stringify({ items: out.newItems, phrases: out.deep?.phrases?.map((p) => p.en) }) })
  if (!out.domPhrases.length) finding('F17', 'P1', '注解面词组区未新增', { actual: JSON.stringify(sv.annotation.phrases) })
  if (out.replaceNotice) finding('F18', 'P2', 'append 审核仍标「将替换」', { actual: out.review.text })
  return out
})

// ---------- S5 401 错误带 HTTP，不被「已生成…上限」覆盖 ----------
await run('S5 401错误提示', async (h) => {
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
  await shot(page, 'S5-01-error-401')
  if (!out.hasErrorLine) finding('F19', 'P1', '401 未显示错误面板/文案', { actual: out.text })
  if (!out.hasHttp401) finding('F20', 'P1', '401 文案未带 HTTP 401', { actual: out.text })
  if (out.hasLimitText) finding('F21', 'P2', '401 时仍显示「本次已达上限」摘要（错误行仍可见）', { actual: out.text })
  return out
})

// ---------- S6 双击开始不取消（生成中第二击落在取消生成） ----------
await run('S6 双击开始不取消', async (h) => {
  const out = {}
  h.word = await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(800)
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await waitPanelTarget(page, 1, 12000)
  st.delayMs = 1600
  const c0 = st.calls
  const s = await start(gen)
  const hitPoint = { x: Math.round(s.box.x + s.box.width / 2), y: Math.round(s.box.y + s.box.height / 2) }
  out.startPoint = hitPoint
  await page.mouse.click(hitPoint.x, hitPoint.y)
  await sleep(300)
  const cancelBtn = gen.getByRole('button', { name: '取消生成', exact: true })
  out.cancelVisible300 = await cancelBtn.isVisible().catch(() => false)
  out.hitAt300 = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el ? { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 20) } : null }, hitPoint)
  await shot(page, 'S6-01-running')
  // 第二击：与第一击同一坐标（此时该位置已是「取消生成」）
  await page.mouse.click(hitPoint.x, hitPoint.y)
  await sleep(400)
  out.hitAt700 = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el ? { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 20) } : null }, hitPoint)
  out.panelAfterSecondClick = (await panelState())?.text?.slice(0, 500) ?? ''
  await shot(page, 'S6-02-after-second-click')
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.review = await reviewInfo(rv)
  out.cancelled = /已取消/.test((await panelState().catch(() => null))?.text ?? '') || /已取消/.test(out.review.text)
  out.summary = out.panelAfterSecondClick
  if (rv.ok) await closeReview(rv)
  await closeDialogs(page)
  await shot(page, 'S6-03-review')
  if (out.cancelled) finding('F22', 'P0', '双击开始仍触发取消', { actual: out.panelAfterSecondClick || out.review.text })
  if (!rv.ok) finding('F23', 'P0', '双击后未进入审核（生成被中断）', { actual: out.panelAfterSecondClick })
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
