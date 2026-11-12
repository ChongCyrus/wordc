/** 0.3.28「AI 补内容」浏览器 QA：双击 / 多 kind / 多 c / append-cover / 失败不静默。
 *  目标构建：APK 内 PWA 精确 0.3.28（index-BfF_vX45.js），独立端口 4190，不触碰 4173。
 *  只读测试，不改 src。真实 API 仅当前词 1–3 条。 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ROOT, log, sleep, loadKey, waitSeededHome, clickHomeLearn, enterAnnotation,
  openAiPanel, closeDialogs, panelText, panelTarget, waitPanelTarget,
  listPacks, listDrafts, wordSnapshot, setupAi, injectPlanForWord, buildMockContent,
} from './ai-qa-lib.mjs'

const KEY = await loadKey()
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4190/'
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.28')
const PROFILE = process.env.QA_PROFILE || '/tmp/qa028-profile'
const RAW_PATH = join(ROOT, 'docs/qa/ai-0.3.28-raw.json')
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
await mkdir(OUT, { recursive: true })

const raw = { startedAt: new Date().toISOString(), base: BASE, build: null, versionText: null, profile: PROFILE, scenarios: {}, findings: [], consoleErrors: [], pageErrors: [], cost: { realCalls: 0, prompt: 0, completion: 0 }, notes: [] }
let seq = 0
const shot = async (page, name) => { const p = join(OUT, `${name}.png`); await page.screenshot({ path: p }).catch(() => {}); return p }
const finding = (sev, title, o = {}) => {
  seq += 1
  const f = { id: `F${String(seq).padStart(2, '0')}`, severity: sev, title, ...o }
  raw.findings.push(f); log(`  🐞 [${sev}] ${f.id} ${title}`); return f
}

// ---------- persistent browser ----------
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

// 自定义 mock 路由（可变内容 tag / partial）
const st = { calls: 0, realCalls: 0, realUsage: { prompt: 0, completion: 0 }, tags: [], partialSlice: 0, kindOnly: null, log: [] }
await page.route('**/v1/chat/completions', async (route) => {
  st.calls += 1
  const req = route.request()
  let body = {}
  try { body = req.postDataJSON() ?? {} } catch { /* noop */ }
  const user = String((body?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '')
  if (user.includes('只用于连通性测试')) {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }) })
  }
  if (st.mode === 'real') {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: req.headers()['authorization'] || '' }, body: req.postData() || '' })
    const text = await res.text()
    st.realCalls += 1
    try { const u = JSON.parse(text).usage ?? {}; st.realUsage.prompt += Number(u.prompt_tokens ?? 0); st.realUsage.completion += Number(u.completion_tokens ?? 0); st.realUsage.total = (st.realUsage.total ?? 0) + Number(u.total_tokens ?? 0) } catch { /* noop */ }
    st.log.push({ kind: 'real', status: res.status, user: user.slice(0, 30) })
    return route.fulfill({ status: res.status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text })
  }
  const content = buildMockContent(user, { log: [], partial: null })
  if (content == null) { st.log.push({ kind: 'unparsed' }); return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }) }) }
  const parsed = JSON.parse(content)
  const km = /kind = (examples|phrases|mnemonics)/.exec(user)
  const kind = km ? km[1] : 'semantics'
  if (st.kindOnly && st.kindOnly !== kind) parsed.items = []
  const tag = st.tags.length + 1
  st.tags.push({ tag, kind, targets: parsed.items.length })
  st.log.push({ kind, tag, items: parsed.items.length })
  for (const [i, item] of parsed.items.entries()) {
    if (item.examples) item.examples = item.examples.map((e) => ({ ...e, en: `QA-${tag} ex ${i + 1} for ${item.headword}`, cn: `QA-${tag} 例句 ${i + 1}` }))
    if (item.phrases) item.phrases = [{ en: `QA-${tag} ${item.headword} up`, cn: `QA-${tag} 词组 ${i + 1}` }]
    if (item.mnemonics) item.mnemonics = [{ type: 'assoc', text: `QA-${tag} 助记 ${i + 1}` }]
    if (item.coreSenses) item.coreSenses = item.coreSenses.map((s, k) => ({ ...s, label: `QA${tag}-义${k + 1}` }))
  }
  if (st.partialSlice > 0) parsed.items = parsed.items.slice(0, st.partialSlice)
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(parsed) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) })
})

const monitorToast = () => page.evaluate(() => { window.__toasts = window.__toasts || []; const host = document.querySelector('.mm-toast-host'); if (!host) return; new MutationObserver(() => { for (const el of host.querySelectorAll('.mm-toast')) window.__toasts.push(el.textContent.trim()) }).observe(host, { childList: true, subtree: true }) }).catch(() => {})
const grabToasts = () => page.evaluate(() => [...new Set(window.__toasts || [])]).catch(() => [])

const dbState = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const get = (s) => new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  const [packs, items] = await Promise.all([get('packs'), get('packItems')])
  return packs.map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status, source: p.source, draft: !!p.draft, items: items.filter((i) => i.packId === p.id).length, applied: items.filter((i) => i.packId === p.id && i.status === 'applied').length }))
})
const annotation = () => page.evaluate(() => {
  const root = document.querySelector('.annotation-stage') ?? document.body
  const txt = (sel) => [...root.querySelectorAll(sel)].map((el) => el.innerText.replace(/\s+/g, ' ').trim())
  return { core: txt('.core-sense-line'), examples: txt('.example-item'), phrases: txt('.phrase-row'), meanings: txt('.meanings .meaning-item, .meanings > *'), bodyText: root.innerText.replace(/\s+/g, ' ').slice(0, 800) }
})
const panelSnapshot = async (gen) => ({ text: (await gen.innerText()).replace(/\s+/g, ' ').slice(0, 600), target: await panelTarget(page), est: (await gen.innerText()).match(/预计 ¥([\d.]+)/)?.[1] ?? null })
const itemCount = (dlg) => dlg.getByRole('checkbox', { name: /^选择 / }).count()
const setKinds = async (gen, wanted) => {
  for (const kind of ['例句', '词组', '助记', '本义/引申链']) {
    const btn = gen.getByRole('button', { name: new RegExp(`^(✓ )?${kind.replace('/', '\\/')}$`) })
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
  await monitorToast()
  return injected
}
const applyAndCollect = async (review, { dbl = false, delay = 50 } = {}) => {
  const btn = review.getByRole('button', { name: /^保存已选/ })
  const t0 = Date.now()
  let clickError = null
  if (dbl) {
    try { await btn.dblclick({ delay, timeout: 15000, force: true }) }
    catch (e) { clickError = String(e?.message ?? e).slice(0, 200) }
  } else await btn.click()
  const closed = await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 30000 }).then(() => true).catch(() => false)
  const elapsed = Date.now() - t0
  if (clickError) log(`  ! dblclick error: ${clickError}`)
  await sleep(1600)
  return { closed, elapsed, clickError, toasts: await grabToasts(), packs: await dbState(), drafts: await listDrafts(page), annotation: await annotation() }
}

const ONLY = (process.env.QA_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean)
const run = async (name, fn) => {
  if (ONLY.length && !ONLY.some((k) => name.startsWith(k))) { log(`(skip ${name})`); return }
  log(`\n===== ${name} =====`)
  const t0 = Date.now()
  const holder = {}
  try {
    const out = await fn(holder)
    raw.scenarios[name] = { ok: true, ms: Date.now() - t0, ...holder, ...(out ?? {}) }
    log(`✅ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`)
  } catch (e) {
    raw.scenarios[name] = { ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e).slice(0, 2000), ...holder }
    log(`❌ ${name}: ${e?.message ?? e}`)
  }
  await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
}

const mergeUsage = () => { raw.cost.realCalls += st.realCalls; raw.cost.prompt += st.realUsage.prompt; raw.cost.completion += st.realUsage.completion }

// ---------- 初始化：设置页配 Key（persistent）+ 清空内容包 ----------
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await waitSeededHome(page, 180000)
raw.build = (await page.content()).match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
raw.versionText = (await page.locator('body').innerText()).match(/v0\.3\.\d+/)?.[0] ?? null
log(`build=${raw.build} version=${raw.versionText}`)
if (raw.build !== 'index-BfF_vX45.js') throw new Error(`构建不符：${raw.build}`)
// 清零内容包（保留内置词库/单词），与 0.3.27 基线一致
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  await new Promise((res) => {
    const tx = db.transaction(['meta', 'packs', 'packItems', 'contentRejects'], 'readwrite')
    tx.objectStore('meta').put({ key: 'packs.defaultSeeded', value: { version: 99 }, updatedAt: Date.now() })
    tx.objectStore('packs').clear(); tx.objectStore('packItems').clear(); tx.objectStore('contentRejects').clear()
    tx.oncomplete = res; tx.onerror = res
  })
})
// 设置页 UI 配置 Key
await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded({ timeout: 20000 })
const enable = page.getByRole('switch', { name: '启用 AI 扩充' })
if ((await enable.getAttribute('aria-checked')) !== 'true') await enable.click()
await page.getByRole('combobox', { name: 'AI 服务商' }).selectOption('deepseek')
await page.getByRole('combobox', { name: 'Key 存储方式' }).selectOption('persistent')
const keyInput = page.getByLabel('AI API Key')
await keyInput.fill(KEY)
await page.getByRole('button', { name: '保存 Key', exact: true }).click()
await sleep(800)
await page.getByLabel('单次运行费用上限').fill('1')
await page.keyboard.press('Tab')
await sleep(800)
await shot(page, 'S0-01-settings-key')
await page.reload({ waitUntil: 'domcontentloaded' })
await sleep(1200)
raw.settings = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const rows = await new Promise((res) => { const r = db.transaction('settings', 'readonly').objectStore('settings').getAll(); r.onsuccess = () => res(r.result) })
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
  return { enabled: m['ai.enabled'], provider: m['ai.provider'], keyStorage: m['ai.keyStorage'], transport: m['ai.transport'], maxCost: m['ai.maxCostPerRun'], hasKey: !!m['ai.apiKey'], keyTail: String(m['ai.apiKey'] || '').slice(-4) }
})
log('settings=' + JSON.stringify(raw.settings))

// ---------- S1 真实 API：双击开始生成 + 双击保存已选 ----------
await run('S1 双击（真实API）', async (h) => {
  const out = { single: {}, dbl: {}, save: {} }
  h.word = await studyReady('address')
  const gen = await openAiPanel(page)
  await monitorToast()
  await sleep(1200)
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  out.target = await waitPanelTarget(page, 1, 15000)
  out.panel = await panelSnapshot(gen)
  await shot(page, 'S1-01-panel-ready')
  // 单击一次
  st.mode = 'real'; st.tags = []
  const c0 = st.realCalls
  const btn = gen.getByRole('button', { name: '开始生成', exact: true })
  await btn.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {})
  const box = await btn.boundingBox()
  out.single.btnBox = box
  out.single.hit = await page.evaluate(({ x, y }) => { const el = document.elementFromPoint(x, y); return el ? { tag: el.tagName, cls: String(el.className).slice(0, 60), text: (el.textContent || '').trim().slice(0, 16) } : null }, { x: Math.round(box.x + box.width / 2), y: Math.round(Math.min(box.y + box.height / 2, 843)) })
  await btn.click({ timeout: 10000 }).catch((e) => { out.single.clickError = String(e.message).slice(0, 200) })
  await sleep(500)
  out.single.runningAfter500ms = await gen.getByRole('button', { name: '取消生成', exact: true }).isVisible().catch(() => false)
  out.single.panelAt500ms = (await gen.innerText()).replace(/\s+/g, ' ').slice(0, 200)
  out.single.calls = st.realCalls - c0
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  out.single.reviewShown = await review.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false)
  if (out.single.reviewShown) {
    out.single.reviewItems = await itemCount(review)
    out.single.reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 400)
  }
  await shot(page, 'S1-02-single-click-review')
  out.single.callsTotal = st.realCalls - c0
  mergeUsage()
  if (!out.single.runningAfter500ms) finding('P1', '单击「开始生成」后未立即进入生成状态', { expected: '500ms 内出现「取消生成」', actual: out.single.panelAt500ms, evidence: [join(OUT, 'S1-02-single-click-review.png')] })
  if (!out.single.reviewShown) { await closeDialogs(page); return out }
  // 审核框：双击保存已选
  out.save = await applyAndCollect(review, { dbl: true, delay: 60 })
  out.save.snapshot = await wordSnapshot(page, h.word.headword)
  out.save.packsNow = (await listPacks(page)).map((p) => ({ kind: p.kind, status: p.status, draft: p.draft }))
  out.save.domExamples = out.save.annotation.examples
  await shot(page, 'S1-03-after-dblclick-save')
  const aiPacks = out.save.packs.filter((p) => p.name === 'AI 生成')
  const dupEx = out.save.snapshot?.examples?.filter((e) => /QA|address/i.test(e.en)).length ?? 0
  if (aiPacks.length > 1) finding('P0', '双击「保存已选」产生多个 pack', { expected: '只建 1 个 pack', actual: JSON.stringify(aiPacks), evidence: [join(OUT, 'S1-03-after-dblclick-save.png')] })
  if ((out.save.snapshot?.examples?.length ?? 0) > 1) finding('P1', '双击保存导致例句重复落地', { expected: '例句 1 条', actual: JSON.stringify(out.save.snapshot.examples), evidence: [join(OUT, 'S1-03-after-dblclick-save.png')] })
  if (out.save.toasts.filter((t) => /已应用/.test(t)).length > 1) finding('P2', '双击保存出现多条「已应用」toast', { expected: '1 条', actual: JSON.stringify(out.save.toasts) })
  return out
})

// ---------- S2 真实 API：双击开始生成（请求数）----------
await run('S2 双击开始生成（真实API）', async (h) => {
  const out = {}
  const gen = await openAiPanel(page)
  await sleep(800)
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  out.target = await waitPanelTarget(page, 1, 15000)
  const c0 = st.realCalls
  const btn = gen.getByRole('button', { name: '开始生成', exact: true })
  await btn.scrollIntoViewIfNeeded({ timeout: 8000 }).catch(() => {})
  const box = await btn.boundingBox()
  out.box = box
  await btn.dblclick({ delay: 40, timeout: 15000 }).catch((e) => { out.dblclickError = String(e.message).slice(0, 300) })
  await sleep(400)
  out.after400 = (await gen.innerText()).replace(/\s+/g, ' ').slice(0, 250)
  out.cancelVisible = await gen.getByRole('button', { name: '取消生成', exact: true }).isVisible().catch(() => false)
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  out.reviewShown = await review.waitFor({ state: 'visible', timeout: 120000 }).then(() => true).catch(() => false)
  out.calls = st.realCalls - c0
  out.panelAfter = (await gen.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 400)
  if (out.reviewShown) { out.reviewItems = await itemCount(review); out.reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 400) }
  mergeUsage()
  await shot(page, 'S2-01-dblclick-start-result')
  if (out.calls > 1) finding('P0', '双击「开始生成」发起多次真实请求', { expected: '1 次请求', actual: `${out.calls} 次；面板=${out.panelAfter}`, evidence: [join(OUT, 'S2-01-dblclick-start-result.png')] })
  if (!out.reviewShown) finding('P1', '双击「开始生成」后未出现审核框', { expected: '出现审核框（1 条）', actual: out.panelAfter, evidence: [join(OUT, 'S2-01-dblclick-start-result.png')] })
  if (out.reviewShown) {
    // 清理：关闭审核框，避免残留草稿
    await review.getByRole('button', { name: '关闭', exact: true }).click().catch(() => {})
    await closeDialogs(page)
    await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const packs = await new Promise((res) => { const r = db.transaction('packs', 'readonly').objectStore('packs').getAll(); r.onsuccess = () => res(r.result) })
      const ids = packs.filter((p) => p.draft).map((p) => p.id)
      const tx = db.transaction(['packs', 'packItems'], 'readwrite')
      for (const id of ids) { tx.objectStore('packs').delete(id); const all = tx.objectStore('packItems').getAll(); all.onsuccess = () => { for (const it of all.result) if (it.packId === id) tx.objectStore('packItems').delete(it.id) } }
      await new Promise((r) => { tx.oncomplete = r; tx.onerror = r })
    })
  }
  return out
})

// ---------- S3 多 kind（真实API）：例句+词组 目标2/审核2/落地2 ----------
await run('S3 多kind（真实API）', async (h) => {
  const out = {}
  await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(1000)
  await setKinds(gen, ['例句', '词组'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await gen.getByLabel('词组生成模式').selectOption('append')
  out.target = await waitPanelTarget(page, 2, 20000)
  out.panel = await panelSnapshot(gen)
  await shot(page, 'S3-01-multikind-ready')
  st.mode = 'real'; st.tags = []
  const c0 = st.realCalls
  await gen.getByRole('button', { name: '开始生成', exact: true }).click()
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  out.reviewShown = await review.waitFor({ state: 'visible', timeout: 120000 }).then(() => true).catch(() => false)
  out.calls = st.realCalls - c0
  if (out.reviewShown) {
    out.reviewItems = await itemCount(review)
    out.reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 500)
  } else out.panelAfter = (await gen.innerText()).replace(/\s+/g, ' ').slice(0, 400)
  mergeUsage()
  await shot(page, 'S3-02-multikind-review')
  if (out.target !== 2) finding('P1', '多 kind 目标数不为 2', { expected: '2', actual: String(out.target), evidence: [join(OUT, 'S3-01-multikind-ready.png')] })
  if (out.reviewShown && out.reviewItems !== 2) finding('P1', `多 kind 审核框条目数 ${out.reviewItems}（期望 2）`, { expected: '2 条（1 例句 + 1 词组）', actual: `review=${out.reviewText}`, evidence: [join(OUT, 'S3-02-multikind-review.png')] })
  if (out.reviewShown) {
    const save = await applyAndCollect(review)
    out.save = { closed: save.closed, toasts: save.toasts, packs: save.packs.filter((p) => p.name === 'AI 生成'), applied: save.packs.filter((p) => p.name === 'AI 生成').reduce((n, p) => n + p.applied, 0) }
    out.snapshot = await wordSnapshot(page, 'address')
    out.annotation = save.annotation
    await shot(page, 'S3-03-multikind-after-save')
    const hasEx = (out.snapshot?.examples?.length ?? 0) > 0
    const hasPh = (out.snapshot?.phrases?.length ?? 0) > 0
    out.landed = { examples: out.snapshot?.examples?.length ?? 0, phrases: out.snapshot?.phrases?.length ?? 0, domExamples: out.annotation.examples.length, domPhrases: out.annotation.phrases.length }
    if (!hasEx || !hasPh) finding('P0', '多 kind 生成后只落地一种类型', { expected: '例句+词组都落地', actual: JSON.stringify(out.landed), evidence: [join(OUT, 'S3-03-multikind-after-save.png')] })
    if ((out.annotation.examples.length === 0) !== (out.annotation.phrases.length === 0)) finding('P2', '注解面只显示一种生成内容', { expected: '两者都显示', actual: JSON.stringify(out.landed), evidence: [join(OUT, 'S3-03-multikind-after-save.png')] })
  }
  return out
})

// ---------- S4 多 c（mock）：c1+c2 目标2/审核2/落地2 ----------
await run('S4 多c（mock）', async () => {
  const out = {}
  await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(800)
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await sleep(500)
  out.meanings = (await gen.innerText()).match(/c\d+[^\n]*/g)?.slice(0, 5) ?? []
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if ((await c2.count()) === 0) { out.note = '该词不足 2 个含义，无法测多 c'; return out }
  if (!(await c1.isChecked())) await c1.click()
  await waitPanelTarget(page, 1, 10000)
  await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  out.panel = await panelSnapshot(gen)
  await shot(page, 'S4-01-multic-ready')
  st.mode = 'ok'; st.partialSlice = 0; st.tags = []
  const c0 = st.calls
  await gen.getByRole('button', { name: '开始生成', exact: true }).click()
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  out.reviewShown = await review.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
  out.calls = st.calls - c0
  if (out.reviewShown) { out.reviewItems = await itemCount(review); out.reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 600) }
  await shot(page, 'S4-02-multic-review')
  if (out.target !== 2) finding('P1', '多 c 目标数不为 2', { expected: '2', actual: String(out.target), evidence: [join(OUT, 'S4-01-multic-ready.png')] })
  if (out.reviewShown && out.reviewItems !== 2) finding('P1', `多 c 审核条目数 ${out.reviewItems}（期望 2）`, { expected: '2（c1+c2）', actual: out.reviewText, evidence: [join(OUT, 'S4-02-multic-review.png')] })
  if (out.reviewShown) {
    const save = await applyAndCollect(review)
    out.snapshot = await wordSnapshot(page, 'address')
    out.save = { closed: save.closed, toasts: save.toasts, packs: save.packs.filter((p) => p.name === 'AI 生成') }
    out.skipReasons = await page.evaluate(async () => {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const items = await new Promise((res) => { const r = db.transaction('packItems', 'readonly').objectStore('packItems').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
      return items.filter((i) => i.status !== 'applied').map((i) => ({ status: i.status, reason: i.skipReason, headword: i.headword, meaningIndex: i.meaningIndex, meaningId: i.meaningId, payloadKeys: Object.keys(i.payload ?? {}) })).slice(0, 6)
    })
    out.annotation = save.annotation
    await shot(page, 'S4-03-multic-after-save')
    const exs = out.snapshot?.examples ?? []
    out.landed = { examples: exs.length, meaningIds: exs.map((e) => e.meaningId) }
    if (exs.length < 2) finding('P0', '多 c 生成后落地条数少于 2', { expected: 'c1、c2 各 1 条', actual: JSON.stringify(out.landed), evidence: [join(OUT, 'S4-03-multic-after-save.png')] })
  }
  return out
})

// ---------- S5 append/cover 混合（mock）----------
await run('S5 append/cover 混合（mock）', async () => {
  const out = {}
  await studyReady('address')
  out.before = { examples: (await wordSnapshot(page, 'address'))?.examples?.length ?? 0, phrases: (await wordSnapshot(page, 'address'))?.phrases?.length ?? 0 }
  out.beforeAnnotation = await annotation()
  const gen = await openAiPanel(page)
  await sleep(800)
  await setKinds(gen, ['例句', '词组'])
  // 混合：例句 append + 词组 cover
  const gen2 = gen
  await gen2.getByLabel('例句生成模式').selectOption('append')
  await gen2.getByLabel('词组生成模式').selectOption('replace')
  out.target = await waitPanelTarget(page, 2, 15000)
  out.panel = await panelSnapshot(gen2)
  await shot(page, 'S5-01-append-cover-ready')
  st.tags = []
  await gen2.getByRole('button', { name: '开始生成', exact: true }).click()
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  out.reviewShown = await review.waitFor({ state: 'visible', timeout: 25000 }).then(() => true).catch(() => false)
  out.mockLog = st.log.slice(-4)
  out.panelAfter = (await gen2.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 500)
  await shot(page, 'S5-02-review')
  if (!out.reviewShown) { await closeDialogs(page).catch(() => {}); return out }
  out.reviewItems = await itemCount(review)
  out.reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 500)
  out.replaceNotice = /将替换|覆盖/.test(out.reviewText)
  await shot(page, 'S5-02-append-cover-review')
  const save = await applyAndCollect(review)
  await shot(page, 'S5-03-append-cover-after-save')
  out.snapshot = await wordSnapshot(page, 'address')
  out.annotation = save.annotation
  out.save = { toasts: save.toasts, packs: save.packs.filter((p) => p.name === 'AI 生成'), applied: save.packs.filter((p) => p.name === 'AI 生成').reduce((n, p) => n + p.applied, 0) }
  out.after = { examples: out.snapshot?.examples?.length ?? 0, phrases: out.snapshot?.phrases?.length ?? 0, exTexts: out.snapshot?.examples?.map((e) => e.en), phTexts: out.snapshot?.phrases?.map((p) => p.en) }
  out.mockLog = st.log.slice(-6)
  if ((out.after.phrases ?? 0) !== 1) finding('P0', `覆盖模式后旧词组未正确处理（phrases=${out.after.phrases}）`, { expected: '仅保留新 1 条', actual: JSON.stringify(out.after.phTexts), evidence: [join(OUT, 'S5-03-append-cover-after-save.png')] })
  if ((out.after.examples ?? 0) < (out.before.examples ?? 0) + 1) finding('P1', 'append 模式未追加例句', { expected: `≥${(out.before.examples ?? 0) + 1}`, actual: String(out.after.examples), evidence: [join(OUT, 'S5-03-append-cover-after-save.png')] })
  return out
})

// ---------- S6 失败不静默（mock 部分返回）----------
await run('S6 失败不静默（mock 部分返回）', async () => {
  const out = {}
  await studyReady('address')
  const gen = await openAiPanel(page)
  await sleep(800)
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  await sleep(400)
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if ((await c2.count()) === 0) { out.note = '该词不足 2 个含义'; return out }
  if (!(await c1.isChecked())) await c1.click()
  if (!(await c2.isChecked())) await c2.click()
  out.target = await waitPanelTarget(page, 2, 15000)
  st.mode = 'ok'; st.tags = []; st.partialSlice = 1
  const c0 = st.calls
  await gen.getByRole('button', { name: '开始生成', exact: true }).click()
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  out.reviewShown = await review.waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
  out.calls = st.calls - c0
  await sleep(600)
  if (out.reviewShown) {
    out.reviewItems = await itemCount(review)
    out.reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 700)
  }
  out.panelText = (await gen.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 800)
  out.failureHint = /失败\s*1|失败|未生成|部分/.test((out.reviewText ?? '') + out.panelText)
  await shot(page, 'S6-01-partial-failure')
  if (out.reviewShown && out.reviewItems !== 1) finding('P1', `部分失败时审核条目 ${out.reviewItems}（期望仅 1 条成功项）`, { expected: '仅成功项 1 条', actual: out.reviewText, evidence: [join(OUT, 'S6-01-partial-failure.png')] })
  if (!out.failureHint) finding('P1', '部分条目生成失败被静默（无失败数量/原因提示）', { expected: '明确显示失败 1 条及原因', actual: (out.reviewText ?? '') + ' || ' + out.panelText, evidence: [join(OUT, 'S6-01-partial-failure.png')] })
  out.failureText = ((out.reviewText ?? '') + ' || ' + out.panelText).match(/失败[^。]{0,80}/g)?.slice(0, 3) ?? []
  out.mockLog = st.log.slice(-6)
  st.partialSlice = 0
  await closeDialogs(page).catch(() => {})
  return out
})

mergeUsage()
raw.consoleErrors = bag.consoleErrors.slice(0, 20)
raw.pageErrors = bag.pageErrors.slice(0, 10)
await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
log(`\n📄 ${RAW_PATH} findings=${raw.findings.length} realCalls=${raw.cost.realCalls} tokens=${raw.cost.prompt}/${raw.cost.completion}`)
await context.close()
