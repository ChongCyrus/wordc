/** 0.3.32 复跑：S3（多 c 例句显示，唯一 tag 避免 duplicate）+ S2（助记 prompt 正确解析）+ DB 取证。
 *  只写 docs；不改 src。 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ROOT, log, sleep, waitSeededHome, clickHomeLearn, enterAnnotation,
  openAiPanel, closeDialogs, waitPanelTarget, listPacks,
  injectPlanForWord, setupAi,
} from './ai-qa-lib.mjs'

const BASE = 'http://127.0.0.1:4173/'
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.32')
const PROFILE = process.env.QA_PROFILE || '/tmp/qa032-profile'
const RAW_PATH = join(ROOT, 'docs/qa/ai-0.3.32-rerun.json')
const PROBE_PATH = join(ROOT, 'docs/qa/ai-0.3.32-probe.json')
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
await mkdir(OUT, { recursive: true })

const raw = { at: new Date().toISOString(), build: null, scenarios: {}, findings: [], consoleErrors: [], pageErrors: [], mockCalls: 0 }
const shot = async (name) => { await page.screenshot({ path: join(OUT, `${name}.png`) }).catch(() => {}) }
const finding = (id, sev, title, o = {}) => { raw.findings.push({ id, severity: sev, title, ...o }); log(`  [${sev}] ${id} ${title}`) }

const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROMIUM, headless: true,
  args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  env: { ...process.env, LD_LIBRARY_PATH: LIB },
  viewport: { width: 390, height: 844 }, locale: 'zh-CN', deviceScaleFactor: 1,
  serviceWorkers: 'block',
})
const page = context.pages()[0] ?? (await context.newPage())
const bag = { consoleErrors: [], pageErrors: [] }
page.on('console', (m) => { if (m.type() === 'error') bag.consoleErrors.push(m.text().slice(0, 300)) })
page.on('pageerror', (e) => bag.pageErrors.push(String(e?.stack ?? e).slice(0, 800)))
page.on('dialog', (d) => d.dismiss().catch(() => {}))

const st = { calls: 0, tags: [], log: [], delayMs: 0 }
function buildMock(user) {
  const km = /kind = (examples|phrases|mnemonics)/.exec(user)
  const kind = km ? km[1] : 'semantics'
  let targets = null
  if (kind === 'mnemonics' && user.includes('targets（')) {
    const tail = user.slice(user.lastIndexOf('\n') + 1)
    try { targets = JSON.parse(tail) } catch { return null }
  } else {
    const start = user.indexOf('targets = ')
    if (start < 0) return null
    const end = user.indexOf('\n请只输出', start)
    try { targets = JSON.parse(user.slice(start + 10, end > start ? end : undefined)) } catch { return null }
  }
  if (!Array.isArray(targets)) return null
  const tag = `Q32R${raw.phase}${st.tags.length + 1}`
  const items = targets.map((t) => {
    const mIdx = t.meaningIndex
    const base = { headword: t.headword, ...(mIdx != null ? { meaningIndex: mIdx } : {}) }
    if (kind === 'examples') return { ...base, examples: [{ en: `${tag} example for ${t.headword} c${mIdx ?? '-'}`, cn: `${tag} 例句翻译 c${mIdx ?? '-'}` }] }
    if (kind === 'phrases') return { ...base, phrases: [{ en: `${t.headword} ${tag} up`, cn: `${tag} 词组翻译 c${mIdx ?? '-'}` }] }
    return { ...base, mnemonics: [{ type: 'assoc', text: `${tag} 助记 c${mIdx ?? '-'}` }] }
  })
  st.tags.push({ tag, kind, targets: targets.length })
  st.log.push({ kind, tag, targets: targets.length, items: items.length })
  return JSON.stringify({ items })
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
  const content = buildMock(user)
  if (content == null) {
    st.log.push({ kind: 'unparsed', head: user.slice(0, 80) })
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }] }) })
  }
  return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) })
})

const panelState = () => page.evaluate(() => {
  const dlg = document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]')
  if (!dlg) return null
  return { text: (dlg.innerText || '').replace(/\s+/g, ' '), danger: [...dlg.querySelectorAll('.mm-danger-text')].map((el) => (el.innerText || '').replace(/\s+/g, ' ')) }
})
const annotation = () => page.evaluate(() => {
  const root = document.querySelector('.annotation-stage') ?? document.body
  return {
    rows: [...root.querySelectorAll('.meanings > div')].map((d) => ({
      text: (d.innerText || '').replace(/\s+/g, ' ').slice(0, 90),
      examples: [...d.querySelectorAll('.meaning-example')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
      mnem: [...d.querySelectorAll('.meaning-mnemonic')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
    })).filter((r) => r.text.length > 0),
    globalExamples: [...root.querySelectorAll('.example-item')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
    body: (root.innerText || '').replace(/\s+/g, ' ').slice(0, 900),
  }
})
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
const packItemsFor = (ids) => page.evaluate(async (packIds) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const all = await new Promise((res) => { const r = db.transaction('packItems', 'readonly').objectStore('packItems').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  return all.filter((i) => packIds.includes(i.packId)).map((i) => ({ packId: i.packId, status: i.status, skipReason: i.skipReason ?? null, meaningIndex: i.meaningIndex ?? null, wordId: i.wordId ?? null }))
}, ids)
const wordDeep = (wordId) => page.evaluate(async (id) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const words = await new Promise((res) => { const r = db.transaction('words', 'readonly').objectStore('words').getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  const word = words.find((w) => w.id === id)
  if (!word) return null
  return {
    id: word.id, deckId: word.deckId,
    meanings: (word.meanings ?? []).map((m, i) => ({ c: i + 1, id: m.meaningId, cn: m.cn, examples: (m.examples ?? []).map((e) => e.en) })),
    examples: (word.examples ?? []).map((e) => e.en),
    phrases: (word.phrases ?? []).map((e) => e.en),
    mnemonics: (word.mnemonics ?? []).map((m) => ({ type: m.type, text: m.text, meaningId: m.meaningId })),
  }
}, wordId)
const freshStudy = async () => {
  await clearDrafts()
  const injected = await injectPlanForWord(page, 1, { headword: 'address' })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitSeededHome(page)
  await clickHomeLearn(page)
  await enterAnnotation(page)
  return injected
}
const pickMeanings = async (gen, kindLabel, modeLabel) => {
  await gen.getByRole('button', { name: '指定含义', exact: true }).click()
  const kindBtn = gen.getByRole('button', { name: new RegExp(`^(✓ )?${kindLabel}$`) })
  if ((await kindBtn.getAttribute('aria-pressed')) !== 'true') await kindBtn.click()
  await gen.getByLabel(modeLabel).selectOption('append')
  await sleep(400)
  const c1 = gen.getByRole('checkbox', { name: '选择含义 c1', exact: true })
  const c2 = gen.getByRole('checkbox', { name: '选择含义 c2', exact: true })
  if (!(await c1.isChecked())) await c1.click()
  await waitPanelTarget(page, 1, 12000)
  if (!(await c2.isChecked())) await c2.click()
  return waitPanelTarget(page, 2, 15000)
}
const waitReview = async (timeout = 30000) => {
  const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
  const ok = await review.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false)
  return { review, ok }
}
const reviewInfo = async (rv) => rv.ok ? {
  shown: true,
  items: await rv.review.getByRole('checkbox', { name: /^选择 / }).count(),
  text: (await rv.review.innerText()).replace(/\s+/g, ' ').slice(0, 900),
} : { shown: false, items: 0, text: '' }
const saveReview = async (rv) => {
  const before = await listPacks(page)
  const beforeIds = new Set(before.map((p) => p.id))
  const t0 = Date.now()
  let err = null
  try { await rv.review.getByRole('button', { name: /^保存已选/ }).click({ timeout: 20000 }) } catch (e) { err = String(e?.message ?? e).slice(0, 200) }
  const closed = await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 40000 }).then(() => true).catch(() => false)
  await sleep(2200)
  const after = await listPacks(page)
  const newPacks = after.filter((p) => !beforeIds.has(p.id))
  return { closed, ms: Date.now() - t0, err, newPacks, items: await packItemsFor(newPacks.map((p) => p.id)) }
}

await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
await waitSeededHome(page, 90000)
raw.build = (await page.content()).match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
await setupAi(page, { key: 'sk-QA-MOCK-KEY', maxCost: 3 })

// ---------- S3 多 c 例句显示（唯一 tag Q32R3） ----------
log('\n===== S3 复跑（多 c 例句显示） =====')
raw.phase = '3'
{
  const out = {}
  const injected = await freshStudy()
  const gen = await openAiPanel(page)
  await sleep(800)
  out.target = await pickMeanings(gen, '例句', '例句生成模式')
  out.wordId = injected.wordId
  await shot('S3-01-ready')
  const c0 = st.calls
  st.tags = []
  const btn = gen.getByRole('button', { name: '开始生成', exact: true })
  await btn.scrollIntoViewIfNeeded().catch(() => {})
  await btn.click()
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.review = await reviewInfo(rv)
  await shot('S3-02-review')
  if (out.review.items !== 2) finding('F11', 'P0', `多 c 例句审核 ${out.review.items} 条（期望 2）`, { actual: out.review.text })
  if (rv.ok) {
    const sv = await saveReview(rv)
    out.save = { closed: sv.closed, ms: sv.ms, err: sv.err, packs: sv.newPacks.map((p) => ({ id: p.id, kind: p.kind })) }
    out.items = sv.items
    out.deep = await wordDeep(injected.wordId)
    out.annotation = await annotation()
    out.c1 = out.deep?.meanings?.[0]?.examples?.filter((e) => /Q32R3/.test(e)) ?? []
    out.c2 = out.deep?.meanings?.[1]?.examples?.filter((e) => /Q32R3/.test(e)) ?? []
    out.domC1 = out.annotation.rows[0]?.examples ?? []
    out.domC2 = out.annotation.rows[1]?.examples ?? []
    out.applied = sv.items.filter((i) => i.status === 'applied').length
    await shot('S3-03-after-save')
    if (out.applied !== 2) finding('F12', 'P0', `多 c 例句落地 ${out.applied} 条（期望 2）`, { actual: JSON.stringify(sv.items) })
    if (!out.c1.length || !out.c2.length) finding('F12b', 'P0', 'DB 未分别给 c1/c2 写入例句', { actual: JSON.stringify({ c1: out.c1, c2: out.c2 }) })
    if (!out.domC1.some((t) => /Q32R3/.test(t)) || !out.domC2.some((t) => /Q32R3/.test(t))) finding('F13', 'P1', '注解面 c1/c2 行未显示对应例句（DB 有、UI 无）', { actual: JSON.stringify({ domC1: out.domC1, domC2: out.domC2, dbC1: out.c1, dbC2: out.c2 }) })
    if (!sv.closed) finding('F14', 'P2', '保存后面板未关闭', { ms: sv.ms })
  }
  raw.scenarios.S3 = out
  await closeDialogs(page)
}

// ---------- S2 助记 done2/2 弹审核（正确解析助记 prompt） ----------
log('\n===== S2 复跑（助记 done2/2） =====')
raw.phase = '2'
{
  const out = {}
  const injected = await freshStudy()
  const gen = await openAiPanel(page)
  await sleep(800)
  out.target = await pickMeanings(gen, '助记', '助记生成模式')
  out.wordId = injected.wordId
  await shot('S2-01-ready')
  const c0 = st.calls
  st.tags = []
  const btn = gen.getByRole('button', { name: '开始生成', exact: true })
  await btn.scrollIntoViewIfNeeded().catch(() => {})
  await btn.click()
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.mockLog = st.log
  out.panel = await panelState()
  out.review = await reviewInfo(rv)
  out.hasLimitText = /本次已达上限/.test(out.panel?.text ?? '')
  out.perC = /c1[^→]*→\s*\[assoc\]/.test(out.review.text) && /c2[^→]*→\s*\[assoc\]/.test(out.review.text)
  await shot('S2-02-review')
  if (!rv.ok) finding('F05', 'P0', '助记 done2/2 未弹审核框', { actual: out.panel?.text })
  else {
    if (out.review.items !== 2) finding('F06', 'P0', `助记审核 ${out.review.items} 条（期望 2）`, { actual: out.review.text })
    if (out.hasLimitText) finding('F07', 'P1', '助记完成态仍显示「本次已达上限」', { actual: out.panel?.text })
    if (!out.perC) finding('F08', 'P1', '审核框未显示「cX 中文 → [类型]」', { actual: out.review.text })
    const sv = await saveReview(rv)
    out.save = { closed: sv.closed, ms: sv.ms, err: sv.err, packs: sv.newPacks.map((p) => ({ id: p.id, kind: p.kind })) }
    out.items = sv.items
    out.applied = sv.items.filter((i) => i.status === 'applied').length
    out.deep = await wordDeep(injected.wordId)
    out.annotation = await annotation()
    out.rows = out.annotation.rows.filter((r) => r.mnem.length > 0).map((r) => r.mnem)
    await shot('S2-03-after-save')
    if (out.applied !== 2) finding('F09', 'P0', `助记落地 ${out.applied} 条（期望 2）`, { actual: JSON.stringify(sv.items) })
    if (out.rows.length < 2 || !/Q32R2/.test(JSON.stringify(out.rows[0])) || !/Q32R2/.test(JSON.stringify(out.rows[1]))) finding('F10', 'P1', '助记未分别挂到 c1/c2 行', { actual: JSON.stringify(out.rows.slice(0, 3)) })
    if (!sv.closed) finding('F11b', 'P2', '保存后面板未关闭', { ms: sv.ms })
  }
  raw.scenarios.S2 = out
  await closeDialogs(page)
}

// ---------- S6 双击/连点取消守卫（300ms 内点「取消生成」应被忽略） ----------
log('\n===== S6 复跑（取消守卫） =====')
raw.phase = '6'
{
  const out = {}
  const injected = await freshStudy()
  const gen = await openAiPanel(page)
  await sleep(800)
  const kindBtn = gen.getByRole('button', { name: /^(✓ )?例句$/ })
  if ((await kindBtn.getAttribute('aria-pressed')) !== 'true') await kindBtn.click()
  await gen.getByLabel('例句生成模式').selectOption('append')
  out.target = await waitPanelTarget(page, 1, 12000)
  st.delayMs = 1600
  const c0 = st.calls
  st.tags = []
  const btn = gen.getByRole('button', { name: '开始生成', exact: true })
  await btn.scrollIntoViewIfNeeded().catch(() => {})
  await btn.click()
  await sleep(320)
  const cancelBtn = gen.getByRole('button', { name: '取消生成', exact: true })
  out.cancelVisible320 = await cancelBtn.isVisible().catch(() => false)
  await shot('S6-01-running')
  // 直接点「取消生成」：距开始 < 800ms，应被忽略
  if (out.cancelVisible320) await cancelBtn.click({ timeout: 5000 }).catch((e) => { out.cancelErr = String(e?.message ?? e).slice(0, 120) })
  await sleep(500)
  out.panelAfterEarlyCancel = (await panelState())?.text?.slice(0, 400) ?? ''
  await shot('S6-02-early-cancel-click')
  const rv = await waitReview(30000)
  out.calls = st.calls - c0
  out.review = await reviewInfo(rv)
  out.cancelled = /已取消/.test(out.panelAfterEarlyCancel)
  st.delayMs = 0
  await shot('S6-03-review')
  if (out.cancelled) finding('F22', 'P0', '生成开始 320ms 内点取消仍取消', { actual: out.panelAfterEarlyCancel })
  if (!rv.ok) finding('F23', 'P0', '取消守卫后未进入审核', { actual: out.panelAfterEarlyCancel })
  raw.scenarios.S6 = out
  await closeDialogs(page)
}

// ---------- 终局 DB 取证（按计划词 id，含 S1 的 Q32A） ----------
const finalWord = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
  const get = (s) => new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
  const [words, packs, items, metas] = await Promise.all([get('words'), get('packs'), get('packItems'), get('meta')])
  const active = metas.find((m) => m.key === 'plan.activeId')?.value ?? null
  const addresses = words.filter((w) => String(w.headword).toLowerCase() === 'address').map((w) => ({
    id: w.id, deckId: w.deckId,
    meanings: (w.meanings ?? []).map((m, i) => ({ c: i + 1, examples: (m.examples ?? []).map((e) => e.en) })),
    examples: (w.examples ?? []).map((e) => e.en),
    phrases: (w.phrases ?? []).map((e) => e.en),
    mnemonics: (w.mnemonics ?? []).map((m) => ({ type: m.type, text: m.text, meaningId: m.meaningId })),
  }))
  const recent = packs.filter((p) => /AI 生成/.test(p.name ?? '')).slice(-14).map((p) => ({
    id: p.id, kind: p.kind, deckMeta: p.meta?.deckId ?? null,
    items: items.filter((i) => i.packId === p.id).map((i) => ({ status: i.status, skipReason: i.skipReason ?? null, wordId: i.wordId ?? null, meaningIndex: i.meaningIndex ?? null })),
  }))
  return { activePlanId: active, addresses, recent }
})

const probe = { at: new Date().toISOString(), build: raw.build, finalWord }
await writeFile(PROBE_PATH, JSON.stringify(probe, null, 2), 'utf8')
raw.consoleErrors = bag.consoleErrors.slice(-10)
raw.pageErrors = bag.pageErrors.slice(-10)
raw.mockCalls = st.calls
raw.finishedAt = new Date().toISOString()
await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
log('\nDONE ' + JSON.stringify(raw.findings))
await context.close()
