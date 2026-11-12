/** 0.3.30「AI 补内容」浏览器回归：单击/双击、多c、多kind、续跑、助记逐c、错误文案。
 *  目标构建 index-D8r_Ueij.js，127.0.0.1:4173，复用持久化 profile（不 fresh seed）。
 *  只写 tests/e2e、docs；不改 src。真实 API 仅 2 次（S1 1 条 / S2 2 条）。 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ROOT, log, sleep, loadKey, waitSeededHome, clickHomeLearn, enterAnnotation,
  openAiPanel, closeDialogs, panelTarget, waitPanelTarget,
  listPacks, listDrafts, wordSnapshot, injectPlanForWord,
} from './ai-qa-lib.mjs'

const KEY = await loadKey()
const BASE = 'http://127.0.0.1:4173/'
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.30')
const PROFILE = process.env.QA_PROFILE || '/tmp/qa030-profile'
const RAW_PATH = join(ROOT, 'docs/qa/ai-0.3.30-raw.json')
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
await mkdir(OUT, { recursive: true })

const raw = { startedAt: new Date().toISOString(), base: BASE, build: null, versionText: null, profile: PROFILE, scenarios: {}, findings: [], consoleErrors: [], pageErrors: [], cost: { realCalls: 0, prompt: 0, completion: 0 }, notes: [] }
let seq = 0
const shot = async (page, name) => { const p = join(OUT, `${name}.png`); await page.screenshot({ path: p }).catch(() => {}); return p }
const finding = (id, sev, title, o = {}) => { raw.findings.push({ id, severity: sev, title, ...o }); log(`  [${sev}] ${id} ${title}`) }
const now = () => new Date().toISOString()

const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROMIUM, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: LIB },
  viewport: { width: 390, height: 844 }, locale: 'zh-CN', deviceScaleFactor: 1,
})
const page = context.pages()[0] ?? (await context.newPage())
const bag = { consoleErrors: [], pageErrors: [], texts: [] }
page.on('console', (m) => { bag.texts.push(m.text()); if (m.type() === 'error') bag.consoleErrors.push(m.text().slice(0, 400)) })
page.on('pageerror', (e) => bag.pageErrors.push(String(e?.stack ?? e).slice(0, 900)))
page.on('dialog', (d) => d.dismiss().catch(() => {}))

const st = { calls: 0, realCalls: 0, realUsage: { prompt: 0, completion: 0 }, tags: [], partialSlice: 0, mode: 'ok', log: [] }
await page.route('**/v1/chat/completions', async (route) => {
  st.calls += 1
  const req = route.request()
  let body = {}
  try { body = req.postDataJSON() ?? {} } catch { /* noop */ }
  const user = String((body?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '')
  if (user.includes('只用于连通性测试')) {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) })
  }
  if (st.mode === 'real') {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: req.headers()['authorization'] || '' }, body: req.postData() || '' })
    const text = await res.text()
    st.realCalls += 1
    try { const u = JSON.parse(text).usage ?? {}; st.realUsage.prompt += Number(u.prompt_tokens ?? 0); st.realUsage.completion += Number(u.completion_tokens ?? 0) } catch { /* noop */ }
    st.log.push({ kind: 'real', status: res.status })
    return route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text })
  }
  if (st.mode === '401') {
    st.log.push({ kind: '401' })
    return route.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'invalid api key' } }) })
  }
  const content = buildMock(user)
  if (content == null) {
    st.log.push({ kind: 'unparsed' })
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }) })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) })
})

function buildMock(user) {
  const km = /kind = (examples|phrases|mnemonics)/.exec(user)
  let kind = km ? km[1] : 'semantics'
  const start = user.indexOf('targets = ')
  if (start < 0) return null
  let end = km ? user.indexOf('\n请只输出', start) : user.indexOf('\n请先通读', start)
  if (end < 0) end = user.indexOf('\n', start)
  let targets
  try { targets = JSON.parse(user.slice(start + 10, end > start ? end : undefined)) } catch { return null }
  if (!Array.isArray(targets)) return null
  const tag = st.tags.length + 1
  const items = []
  for (const [i, t] of targets.entries()) {
    const mIdx = t.meaningIndex
    if (kind === 'examples') {
      items.push({ headword: t.headword, ...(mIdx != null ? { meaningIndex: mIdx } : {}), examples: [{ en: `QA${tag}-${mIdx ?? i + 1} example for ${t.headword}`, cn: `QA${tag} 例句 c${mIdx ?? '-'}` }] })
    } else if (kind === 'phrases') {
      items.push({ headword: t.headword, ...(mIdx != null ? { meaningIndex: mIdx } : {}), phrases: [{ en: `${t.headword} QA${tag}-${mIdx ?? i + 1} up`, cn: `QA${tag} 词组 c${mIdx ?? '-'}` }] })
    } else {
      items.push({ headword: t.headword, ...(mIdx != null ? { meaningIndex: mIdx } : {}), mnemonics: [{ type: 'assoc', text: `QA${tag} 助记 c${mIdx ?? '-'}` }] })
    }
  }
  const out = { items }
  if (st.partialSlice > 0) out.items = out.items.slice(0, st.partialSlice)
  st.tags.push({ tag, kind, targets: targets.length, sent: out.items.length, mIdx: targets.map((t) => t.meaningIndex ?? null) })
  st.log.push({ kind, tag, targets: targets.length, sent: out.items.length })
  return JSON.stringify(out)
}

const dbState = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const get = (s) => new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  const [packs, items] = await Promise.all([get('packs'), get('packItems')])
  return packs.map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status, source: p.source, draft: !!p.draft, items: items.filter((i) => i.packId === p.id).length, applied: items.filter((i) => i.packId === p.id && i.status === 'applied').length }))
})
const annotation = () => page.evaluate(() => {
  const root = document.querySelector('.annotation-stage') ?? document.body
  const rows = [...root.querySelectorAll('.meanings > div')].map((d) => ({
    text: (d.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    mnem: [...d.querySelectorAll('.meaning-mnemonic')].map((m) => (m.innerText || '').replace(/\s+/g, ' ').trim()),
  }))
  return {
    examples: [...root.querySelectorAll('.example-item')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
    phrases: [...root.querySelectorAll('.phrase-row')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
    mnemonicRows: rows.filter((r) => r.mnem.length > 0),
    bodyText: root.innerText.replace(/\s+/g, ' ').slice(0, 1200),
  }
})
const panelText = async () => (await page.locator('.mm-dialog[aria-label="AI 扩充内容"]').innerText()).replace(/\s+/g, ' ')
const itemCount = (dlg) => dlg.getByRole('checkbox', { name: /^选择 / }).count()
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
const start = async (gen) => {
  const btn = gen.getByRole('button', { name: '开始生成', exact: true })
  await btn.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {})
  const box = await btn.boundingBox()
  const hit = box ? await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el ? { tag: el.tagName, text: (el.textContent || '').trim().slice(0, 20) } : null }, { x: Math.round(Math.min(box.x + box.width / 2, 389)), y: Math.round(Math.min(box.y + box.height / 2, 843)) }) : null
  return { btn, box, hit }
}
const waitReview = async (timeout = 120000) => {
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  const ok = await review.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)
  return { review, ok }
}
const save = async (review, { dbl = false, delay = 50 } = {}) => {
  const before = await listPacks(page)
  const beforeApplied = before.filter((p) => p.name === 'AI 生成').reduce((n, p) => n + 0, 0)
  const btn = review.getByRole('button', { name: /^保存已选/ })
  const t0 = Date.now()
  let err = null
  try {
    if (dbl) await btn.dblclick({ delay, timeout: 20000, force: true })
    else await btn.click({ timeout: 20000 })
  } catch (e) { err = String(e?.message ?? e).slice(0, 200) }
  const closed = await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 30000 }).then(() => true).catch(() => false)
  await sleep(1600)
  const after = await listPacks(page)
  return { closed, ms: Date.now() - t0, err, packs: after, beforePacks: before, drafts: await listDrafts(page), annotation: await annotation(), beforeApplied }
}

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await waitSeededHome(page, 60000)
raw.build = (await page.content()).match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
raw.versionText = (await page.locator('body').innerText()).match(/v0\.3\.\d+/)?.[0] ?? null
log(`build=${raw.build} version=${raw.versionText}`)
if (raw.build !== 'index-D8r_Ueij.js') throw new Error(`构建不符：${raw.build}`)

// ---------- 设置 Key（UI persistent，不打印 Key） ----------
await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded({ timeout: 20000 })
const enable = page.getByRole('switch', { name: '启用 AI 扩充' })
if ((await enable.getAttribute('aria-checked')) !== 'true') await enable.click()
await page.getByRole('combobox', { name: 'AI 服务商' }).selectOption('deepseek')
await page.getByRole('combobox', { name: 'Key 存储方式' }).selectOption('persistent')
await page.getByLabel('AI API Key').fill(KEY)
await page.getByRole('button', { name: '保存 Key', exact: true }).click()
await sleep(700)
await page.getByLabel('单次运行费用上限').fill('1')
await page.keyboard.press('Tab')
await sleep(600)
raw.settings = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = await new Promise((res) => { const r = db.transaction('settings', 'readonly').objectStore('settings').getAll(); r.onsuccess = () => res(r.result) })
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return { enabled: m['ai.enabled'], provider: m['ai.provider'], keyStorage: m['ai.keyStorage'], hasKey: !!m['ai.apiKey'], maxCost: m['ai.maxCostPerRun'] }
})
log('settings=' + JSON.stringify(raw.settings))

const run = async (name, fn) => {
  log(`\n===== ${name} =====`)
  const t0 = Date.now(); const holder = {}
  try { const out = await fn(holder); raw.scenarios[name] = { ok: true, ms: Date.now() - t0, ...holder, ...(out ?? {}) }; log(`OK ${name} ${Math.round((Date.now() - t0) / 1000)}s`) }
  catch (e) { raw.scenarios[name] = { ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e).slice(0, 1500), ...holder }; log(`FAIL ${name}: ${e?.message ?? e}`) }
  raw.consoleErrors = bag.consoleErrors.slice(-20); raw.pageErrors = bag.pageErrors.slice(-10)
  await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
}

// ---------- S1 单击开始/单击保存 + 双击去重（真实API 1 条 + mock） ----------
await run('S1 单击生效/双击去重', async (h) => {
  const out = {}
  h.word = await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(900)
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  out.target = await waitPanelTarget(page, 1, 15000)
  await shot(page, 'S1-01-panel-ready')
  st.mode = 'real'; st.tags = []; st.realCalls = 0
  const s = await start(gen)
  out.startHit = s.hit
  await s.btn.click({ timeout: 10000 })
  await sleep(400)
  out.running400 = await gen.getByRole('button', { name: '取消生成', exact: true }).isVisible().catch(() => false)
  out.panel400 = (await gen.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
  const rv = await waitReview(120000)
  out.calls = st.realCalls
  out.reviewShown = rv.ok
  if (rv.ok) { out.items = await itemCount(rv.review); out.reviewText = (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 400) }
  await shot(page, 'S1-02-review')
  if (!out.running400) finding('F01', 'P1', '单击开始后未立即进入生成', { expected: '400ms 内出现「取消生成」', actual: out.panel400 })
  if (out.calls !== 1) finding('F02', 'P1', `单击开始请求数 ${out.calls}（期望 1）`, { actual: String(out.calls) })
  if (!rv.ok) return out
  const sv = await save(rv.review)
  out.save = { closed: sv.closed, ms: sv.ms, err: sv.err, packs: sv.packs, drafts: sv.drafts.length, examples: sv.annotation.examples }
  out.snapshot = await wordSnapshot(page, h.word.headword)
  out.packDelta = sv.packs.length - sv.beforePacks.length
  out.savedPacks = sv.packs.filter((p) => p.name === 'AI 生成')
  await shot(page, 'S1-03-after-save')
  const newEx = (out.snapshot?.examples ?? []).filter((e) => /QA|example/i.test(e.en))
  out.appliedExamples = newEx.length
  if (!sv.closed) finding('F03', 'P1', '单击保存后审核框未关闭', {})
  if (out.packDelta !== 1) finding('F04', 'P0', `单击保存产生 ${out.packDelta} 个 pack（期望 1）`, { actual: JSON.stringify(out.savedPacks) })
  if (newEx.length !== 1) finding('F05', 'P0', `单击保存落地例句 ${newEx.length} 条（期望 1）`, { actual: JSON.stringify(newEx) })
  if ((sv.annotation.examples ?? []).filter((x) => /QA|example/i.test(x)).length !== 1) finding('F06', 'P2', '注解面例句数与保存结果不符', { actual: JSON.stringify(sv.annotation.examples) })

  // --- 双击：mock，快速两次点击只触发一次 ---
  const before = await dbState()
  const gen2 = await openAiPanel(page)
  await sleep(700)
  await setKinds(gen2, ['例句'])
  await gen2.getByLabel('例句生成模式').selectOption('append')
  out.dblTarget = await waitPanelTarget(page, 1, 15000)
  st.mode = 'ok'; st.tags = []; const c0 = st.calls
  const s2 = await start(gen2)
  await s2.btn.dblclick({ delay: 50, timeout: 15000 }).catch((e) => { out.dblStartErr = String(e.message).slice(0, 160) })
  await sleep(400)
  out.dblRunning = await gen2.getByRole('button', { name: '取消生成', exact: true }).isVisible().catch(() => false)
  const rv2 = await waitReview(30000)
  out.dblCalls = st.calls - c0
  out.dblReview = rv2.ok ? await itemCount(rv2.review) : 0
  await shot(page, 'S1-04-dblclick-review')
  if (out.dblCalls !== 1) finding('F07', 'P0', `双击开始请求数 ${out.dblCalls}（期望 1）`, { actual: JSON.stringify(st.log.slice(-4)) })
  if (out.dblReview !== 1) finding('F08', 'P1', `双击开始后审核条目 ${out.dblReview}（期望 1）`, {})
  if (rv2.ok) {
    const sv2 = await save(rv2.review, { dbl: true, delay: 50 })
    const after = sv2.packs
    out.dblSave = { closed: sv2.closed, packDelta: after.length - before.length, examples: sv2.annotation.examples, toasts: await page.evaluate(() => [...new Set(window.__toasts || [])]).catch(() => []) }
    out.dblSnapshot = await wordSnapshot(page, h.word.headword)
    const qa = (out.dblSnapshot?.examples ?? []).filter((e) => /QA/.test(e.en))
    out.dblApplied = qa.length
    await shot(page, 'S1-05-after-dblclick-save')
    if (out.dblSave.packDelta !== 1) finding('F09', 'P0', `双击保存产生 ${out.dblSave.packDelta} 个 pack（期望 1）`, { actual: JSON.stringify(after.filter((p) => p.name === 'AI 生成')) })
    if (qa.length !== 1) finding('F10', 'P0', `双击保存落地例句 ${qa.length} 条（期望 1）`, { actual: JSON.stringify(qa) })
  }
  return out
})

// ---------- S2 多 c（真实API：c1+c2 → 目标2/审核2/落地2） ----------
await run('S2 多c落地', async (h) => {
  const out = {}
  h.word = await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(800)
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await sleep(500)
  out.meanings = (await gen.innerText()).match(/c\d+[^\n]*/g)?.slice(0, 4) ?? []
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if ((await c2.count()) === 0) throw new Error('词不足 2 含义')
  if (!(await c1.isChecked())) await c1.click()
  await waitPanelTarget(page, 1, 10000)
  await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  out.meaningsRows = await page.evaluate(() => [...document.querySelectorAll('.mm-dialog[aria-label="AI 扩充内容"] label')].map((l) => l.innerText.replace(/\s+/g, ' ').trim()).filter((t) => /^c\d/.test(t)))
  await shot(page, 'S2-01-multic-ready')
  st.mode = 'real'; st.tags = []; st.realCalls = 0
  const s = await start(gen)
  out.startHit = s.hit
  await s.btn.click()
  const rv = await waitReview(120000)
  out.calls = st.realCalls
  out.reviewShown = rv.ok
  out.items = rv.ok ? await itemCount(rv.review) : 0
  out.reviewText = rv.ok ? (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 700) : ''
  await shot(page, 'S2-02-multic-review')
  if (out.target !== 2) finding('F11', 'P1', `多 c 目标 ${out.target}（期望 2）`, {})
  if (out.items !== 2) finding('F12', 'P1', `多 c 审核 ${out.items} 条（期望 2）`, { actual: out.reviewText })
  if (!rv.ok) return out
  const sv = await save(rv.review)
  out.save = { closed: sv.closed, ms: sv.ms, packDelta: sv.packs.length - sv.beforePacks.length, drafts: sv.drafts.length }
  out.snapshot = await wordSnapshot(page, h.word.headword)
  out.annotation = sv.annotation
  await shot(page, 'S2-03-multic-after-save')
  const ids = h.word.meanings.slice(0, 2).map((m) => m.id)
  const exs = (out.snapshot?.examples ?? []).filter((e) => /QA/.test(e.en))
  out.landed = { count: exs.length, meaningIds: exs.map((e) => e.meaningId), c1: ids[0], c2: ids[1], dom: (out.annotation.examples ?? []).filter((x) => /QA/.test(x)) }
  if (exs.length !== 2) finding('F13', 'P0', `多 c 落地 ${exs.length} 条（期望 2）`, { actual: JSON.stringify(exs) })
  if (!exs.some((e) => e.meaningId === ids[0]) || !exs.some((e) => e.meaningId === ids[1])) finding('F14', 'P0', '多 c 落地未分别挂到 c1/c2', { expected: JSON.stringify(ids), actual: JSON.stringify(out.landed) })
  if ((out.landed.dom ?? []).length !== 2) finding('F15', 'P1', '注解面未显示两个 c 的新例句', { actual: JSON.stringify(out.annotation.examples) })
  return out
})

// ---------- S3 多 kind（mock：例句+词组） ----------
await run('S3 多kind落地', async () => {
  const out = {}
  await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(700)
  await setKinds(gen, ['例句', '词组'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await gen.getByLabel('词组生成模式').selectOption('append')
  out.target = await waitPanelTarget(page, 2, 15000)
  await shot(page, 'S3-01-multikind-ready')
  st.mode = 'ok'; st.tags = []; const c0 = st.calls
  const s = await start(gen)
  out.startHit = s.hit
  await s.btn.click()
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.reviewShown = rv.ok
  out.items = rv.ok ? await itemCount(rv.review) : 0
  out.reviewText = rv.ok ? (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 600) : ''
  out.replaceNotice = /将替换/.test(out.reviewText)
  await shot(page, 'S3-02-multikind-review')
  if (out.target !== 2) finding('F16', 'P1', `多 kind 目标 ${out.target}（期望 2）`, {})
  if (out.items !== 2) finding('F17', 'P1', `多 kind 审核 ${out.items} 条（期望 2）`, { actual: out.reviewText })
  if (!rv.ok) return out
  const sv = await save(rv.review)
  out.annotation = sv.annotation
  out.snapshot = await wordSnapshot(page, 'address')
  await shot(page, 'S3-03-multikind-after-save')
  const ex = (out.snapshot?.examples ?? []).filter((e) => /QA3/.test(e.en))
  const ph = (out.snapshot?.phrases ?? []).filter((p) => /QA3/.test(p.en))
  out.landed = { examples: ex.length, phrases: ph.length, domExamples: (sv.annotation.examples ?? []).filter((x) => /QA3/.test(x)).length, domPhrases: (sv.annotation.phrases ?? []).filter((x) => /QA3/.test(x)).length }
  if (ex.length < 1 || ph.length < 1) finding('F18', 'P0', '多 kind 未同时落地例句与词组', { actual: JSON.stringify(out.landed) })
  if (out.landed.domExamples < 1 || out.landed.domPhrases < 1) finding('F19', 'P1', '注解面缺少例句区或词组区新内容', { actual: JSON.stringify(sv.annotation) })
  return out
})

// ---------- S4 续跑不丢（mock 部分返回 → 关闭 → 继续 → 再生成） ----------
await run('S4 续跑不丢', async () => {
  const out = {}
  await studyReady('address')
  let gen = await openAiPanel(page)
  await sleep(700)
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await sleep(400)
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if (!(await c1.isChecked())) await c1.click()
  if (!(await c2.isChecked())) await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  st.mode = 'ok'; st.tags = []; st.partialSlice = 1
  const c0 = st.calls
  await start(gen).then((s) => s.btn.click())
  let rv = await waitReview(30000)
  out.first = { shown: rv.ok, items: rv.ok ? await itemCount(rv.review) : 0, calls: st.calls - c0, text: rv.ok ? (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 300) : '' }
  out.draftAfterFirst = (await listDrafts(page)).map((d) => ({ done: d.done, cursor: d.draft?.cursor, total: d.draft?.targetTotal, items: d.items.length }))
  await shot(page, 'S4-01-partial-first')
  if (rv.ok) await rv.review.getByRole('button', { name: '关闭', exact: true }).click()
  await sleep(500)
  await closeDialogs(page)
  // 重开面板 → 继续草稿
  gen = await openAiPanel(page)
  await sleep(800)
  out.panelAfterReopen = (await gen.innerText()).replace(/\s+/g, ' ').slice(0, 500)
  out.hasResume = /继续/.test(out.panelAfterReopen)
  const resumeBtn = gen.getByRole('button', { name: '继续', exact: true })
  out.resumeVisible = await resumeBtn.isVisible().catch(() => false)
  await shot(page, 'S4-02-draft-banner')
  if (out.resumeVisible) await resumeBtn.click()
  rv = await waitReview(15000)
  out.resumed = { shown: rv.ok, items: rv.ok ? await itemCount(rv.review) : 0, text: rv.ok ? (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 400) : '' }
  await shot(page, 'S4-03-resume-review')
  if (out.resumed.items !== 1) finding('F20', 'P1', `「继续」未载入历史草稿（审核 ${out.resumed.items}，期望 1）`, { actual: out.resumed.text })
  if (rv.ok) await rv.review.getByRole('button', { name: '关闭', exact: true }).click()
  await sleep(400)
  st.partialSlice = 0; st.tags = []; const c1all = st.calls
  const s = await start(gen)
  await s.btn.click()
  rv = await waitReview(30000)
  out.second = { shown: rv.ok, items: rv.ok ? await itemCount(rv.review) : 0, calls: st.calls - c1all, text: rv.ok ? (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 500) : '' }
  await shot(page, 'S4-04-resume-plus-new-review')
  if (out.second.items !== 2) finding('F21', 'P0', `续跑后审核 ${out.second.items} 条（期望历史+本次=2）`, { actual: out.second.text })
  if (!rv.ok) return out
  const sv = await save(rv.review)
  out.snapshot = await wordSnapshot(page, 'address')
  out.annotation = sv.annotation
  await shot(page, 'S4-05-after-save')
  const ex = (out.snapshot?.examples ?? []).filter((e) => /QA/.test(e.en))
  out.landed = { count: ex.length, texts: ex.map((e) => e.en), dom: (sv.annotation.examples ?? []).filter((x) => /QA/.test(x)) }
  if (ex.length !== 2) finding('F22', 'P0', `续跑保存落地 ${ex.length} 条（期望 2）`, { actual: JSON.stringify(out.landed) })
  if (out.draftAfterFirst.some((d) => (d.cursor ?? 0) >= (d.total ?? 0) && d.items < 2)) finding('F23', 'P2', '首次中断 cursor 与已生成数不一致', { actual: JSON.stringify(out.draftAfterFirst) })
  return out
})

// ---------- S5 助记逐 c（mock） ----------
await run('S5 助记逐c', async () => {
  const out = {}
  await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(700)
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  await setKinds(gen, ['助记'])
  await gen.getByLabel('助记生成模式').selectOption('append')
  await sleep(400)
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if (!(await c1.isChecked())) await c1.click()
  await waitPanelTarget(page, 1, 10000)
  if (!(await c2.isChecked())) await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  await shot(page, 'S5-01-mnemonic-ready')
  st.mode = 'ok'; st.tags = []; const c0 = st.calls
  const s = await start(gen)
  out.startHit = s.hit
  await s.btn.click()
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.items = rv.ok ? await itemCount(rv.review) : 0
  out.reviewText = rv.ok ? (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 700) : ''
  out.perC = /c1[^→]*→\s*\[assoc\]/.test(out.reviewText) && /c2[^→]*→\s*\[assoc\]/.test(out.reviewText)
  await shot(page, 'S5-02-mnemonic-review')
  if (out.target !== 2) finding('F24', 'P1', `助记逐 c 目标 ${out.target}（期望 2）`, {})
  if (out.items !== 2) finding('F25', 'P0', `助记逐 c 审核 ${out.items} 条（期望 2）`, { actual: out.reviewText })
  if (!out.perC) finding('F26', 'P1', '审核框未显示「cX 中文 → [类型]」', { actual: out.reviewText })
  if (!rv.ok) return out
  const sv = await save(rv.review)
  out.annotation = sv.annotation
  out.snapshot = await wordSnapshot(page, 'address')
  await shot(page, 'S5-03-mnemonic-after-save')
  out.mnemonicRows = sv.annotation.mnemonicRows
  const rows = sv.annotation.mnemonicRows ?? []
  const c1row = rows[0], c2row = rows[1]
  out.landed = { rows: rows.length, c1: c1row?.mnem ?? [], c2: c2row?.mnem ?? [] }
  if (rows.length < 2 || !/QA5/.test(JSON.stringify(c1row?.mnem ?? [])) || !/QA5/.test(JSON.stringify(c2row?.mnem ?? []))) finding('F27', 'P0', '助记未分别挂到 c1/c2 行', { actual: JSON.stringify(rows.slice(0, 4)) })
  return out
})

// ---------- S6 错误文案 HTTP 状态 + append 无「将替换」 + 底部按钮可点 ----------
await run('S6 错误文案/append/按钮', async () => {
  const out = {}
  await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(700)
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await waitPanelTarget(page, 1, 10000)
  const s = await start(gen)
  out.startButton = { box: s.box, hit: s.hit }
  st.mode = '401'; const c0 = st.calls
  await s.btn.click()
  await sleep(1800)
  out.panel = (await panelText()).slice(0, 700)
  out.calls = st.calls - c0
  out.toasts = await page.evaluate(() => [...new Set(window.__toasts || [])]).catch(() => [])
  out.hasHttp = /HTTP\s*401/.test(out.panel + ' ' + out.toasts.join(' '))
  await shot(page, 'S6-01-error-401')
  if (!out.hasHttp) finding('F28', 'P1', '401 错误文案未带 HTTP 状态', { actual: out.panel })
  // append 审核不应出现「将替换」：复用 S3 已记录；这里再开一次 mock 快速验证标题
  st.mode = 'ok'; st.tags = []; const c1 = st.calls
  const s2 = await start(gen)
  await s2.btn.click()
  const rv = await waitReview(20000)
  out.appendReview = rv.ok ? (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 300) : ''
  out.appendReplaceNotice = /将替换/.test(out.appendReview)
  out.calls2 = st.calls - c1
  if (out.appendReplaceNotice) finding('F29', 'P2', 'append 审核仍标注「将替换」', { actual: out.appendReview })
  if (rv.ok) await rv.review.getByRole('button', { name: '关闭', exact: true }).click()
  await closeDialogs(page)
  return out
})

raw.consoleErrors = bag.consoleErrors.slice(-20)
raw.pageErrors = bag.pageErrors.slice(-10)
raw.finishedAt = now()
await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
log(`\nDONE findings=${raw.findings.length} realCalls=${st.realCalls} tokens=${st.realUsage.prompt}/${st.realUsage.completion}`)
await context.close()
