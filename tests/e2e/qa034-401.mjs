/** 0.3.34「AI 补内容」401 错误面板小回归。
 *  目标构建 index-0wc4VVru.js，127.0.0.1:4173，复用 /tmp/qa034-profile（自 qa032 复制并清 SW/Cache）。
 *  只 mock（不调真实 API，花费 ¥0）；只写 tests/e2e、docs；不改 src。
 *  必验：401 只显示错误行（无进度/上限/草稿摘要）、无草稿横幅、错误后开始生成可点且成功重试进入审核。 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  ROOT, log, sleep, waitSeededHome, clickHomeLearn, enterAnnotation,
  openAiPanel, waitPanelTarget, listDrafts, injectPlanForWord, setupAi,
} from './ai-qa-lib.mjs'

const BASE = 'http://127.0.0.1:4173/'
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.34')
const PROFILE = process.env.QA_PROFILE || '/tmp/qa034-profile'
const RAW_PATH = join(ROOT, 'docs/qa/ai-0.3.34-401.json')
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
const EXPECTED_BUILD = 'index-0wc4VVru.js'
await mkdir(OUT, { recursive: true })

const raw = {
  startedAt: new Date().toISOString(), base: BASE, build: null, versionText: null, profile: PROFILE,
  scenario: {}, findings: [], consoleErrors: [], pageErrors: [], cost: { realCalls: 0, yuan: 0 },
  notes: ['全程 mock /v1/chat/completions；未读取 .secrets，未调用真实 API。'],
}
const shot = async (page, name) => { const p = join(OUT, `${name}.png`); await page.screenshot({ path: p }).catch(() => {}); return `docs/assets/qa/ai-0.3.34/${name}.png` }
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
const bag = { consoleErrors: [], pageErrors: [] }
page.on('console', (m) => { if (m.type() === 'error') bag.consoleErrors.push(m.text().slice(0, 400)) })
page.on('pageerror', (e) => bag.pageErrors.push(String(e?.stack ?? e).slice(0, 900)))
page.on('dialog', (d) => d.dismiss().catch(() => {}))

// ---------- mock provider ----------
const st = { calls: 0, mode: 'ok', tags: [], log: [] }
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
  const tag = `Q34${String.fromCharCode(65 + st.tags.length)}`
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
  st.tags.push({ tag, kind, targets: targets.length, sent: items.length })
  st.log.push({ kind, tag, targets: targets.length, sent: items.length })
  return JSON.stringify({ items })
}

await page.route('**/v1/chat/completions', async (route) => {
  st.calls += 1
  const req = route.request()
  let body = {}
  try { body = req.postDataJSON() ?? {} } catch { /* noop */ }
  const user = String((body?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '')
  if (user.includes('只用于连通性测试')) {
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: 'ok' } }] }) })
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

// ---------- page helpers ----------
const panelEl = () => page.locator('.mm-dialog[aria-label="AI 扩充内容"]')
const panelState = async () => page.evaluate(() => {
  const dlg = document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]')
  if (!dlg) return null
  const startBtn = [...dlg.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '开始生成')
  return {
    text: (dlg.innerText || '').replace(/\s+/g, ' ').trim(),
    danger: [...dlg.querySelectorAll('.mm-danger-text')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()),
    start: startBtn ? { exists: true, disabled: !!startBtn.disabled, visible: !!(startBtn.offsetWidth || startBtn.offsetHeight) } : { exists: false },
    draftButtons: [...dlg.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter((t) => t === '继续' || t === '放弃草稿'),
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
const setKinds = async (gen, wanted) => {
  for (const kind of ['例句', '词组', '助记', '本义/引申链']) {
    const btn = gen.getByRole('button', { name: new RegExp(`^(✓ )?${kind.replace('/', '\\/')}$`) })
    if ((await btn.count()) === 0) continue
    const pressed = (await btn.getAttribute('aria-pressed')) === 'true'
    if (pressed !== wanted.includes(kind)) await btn.click()
  }
}
const reviewDialog = () => page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()

try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await waitSeededHome(page, 60000)
  raw.build = (await page.content()).match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
  await page.goto(BASE + '#/me', { waitUntil: 'domcontentloaded' })
  await sleep(700)
  raw.versionText = (await page.locator('body').innerText()).match(/v0\.3\.\d+/)?.[0] ?? null
  raw.swBlocked = await page.evaluate(() => !navigator.serviceWorker?.controller)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitSeededHome(page, 60000)
  log(`build=${raw.build} version=${raw.versionText} profile=${PROFILE}`)
  if (raw.build !== EXPECTED_BUILD) throw new Error(`构建不符：${raw.build}`)
  if (raw.versionText !== 'v0.3.34') throw new Error(`版本不符：${raw.versionText}`)

  await setupAi(page, { key: 'sk-QA-MOCK-KEY', maxCost: 3 })
  raw.settings = await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('momo-reword'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const rows = await new Promise((res) => { const r = db.transaction('settings', 'readonly').objectStore('settings').getAll(); r.onsuccess = () => res(r.result) })
    const m = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    return { enabled: m['ai.enabled'], provider: m['ai.provider'], keyStorage: m['ai.keyStorage'], hasKey: !!m['ai.apiKey'], maxCost: m['ai.maxCostPerRun'] }
  })

  await clearDrafts()
  const injected = await injectPlanForWord(page, 1, { headword: 'address' })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitSeededHome(page, 60000)
  await clickHomeLearn(page)
  await enterAnnotation(page)
  const gen = await openAiPanel(page)
  await sleep(500)
  await setKinds(gen, ['例句'])
  await gen.getByLabel('例句生成模式').selectOption('append')
  const target = await waitPanelTarget(page, 1, 12000)
  const before = await panelState()
  await shot(page, 'S1-01-ready')

  const start = gen.getByRole('button', { name: '开始生成', exact: true })
  const startBefore = { count: await start.count(), enabled: await start.isEnabled(), target }
  // ---- 401 ----
  st.mode = '401'
  const callsBefore = st.calls
  await start.click()
  const errVisible = await panelEl().getByText(/HTTP 401/).first().waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false)
  await sleep(1800)
  const after401 = await panelState()
  const drafts = await listDrafts(page)
  await shot(page, 'S1-02-error-401')

  const text401 = `${after401?.text ?? ''} ${(after401?.danger ?? []).join(' ')}`
  raw.scenario = {
    word: injected, target,
    panelBefore: before?.text ?? '',
    startBefore,
    errorVisible: errVisible,
    panelAfter401: after401,
    draftCount: drafts.length,
    mockCalls: st.calls - callsBefore,
    assertions: {
      http401InErrorLine: /HTTP\s*401/.test((after401?.danger ?? []).join(' ')),
      noGeneratedProgress: !/已生成\s*\d+\s*\/\s*总\s*\d+/.test(text401),
      noBatchLimitText: !/本次已达上限/.test(text401),
      noDraftSavedText: !/草稿已保存/.test(text401),
      noDraftBanner: (after401?.draftButtons ?? []).length === 0 && !/继续|放弃草稿/.test(after401?.text ?? ''),
      noDraftInDb: drafts.length === 0,
      startUsableAfterError: !!after401?.start?.exists && !after401.start.disabled && after401.start.visible,
      onlyErrorLine: (after401?.danger ?? []).length === 1,
    },
  }
  log(`401 panel: ${after401?.text ?? '<missing>'}`)
  if (!raw.scenario.assertions.http401InErrorLine) finding('C01', 'P1', '401 错误行未含 HTTP 401', { actual: after401?.danger })
  if (!raw.scenario.assertions.noGeneratedProgress) finding('C02', 'P1', '401 仍显示「已生成 X / 总 Y」', { actual: after401?.text })
  if (!raw.scenario.assertions.noBatchLimitText) finding('C03', 'P1', '401 仍显示「本次已达上限」', { actual: after401?.text })
  if (!raw.scenario.assertions.noDraftSavedText) finding('C04', 'P1', '401 仍显示「草稿已保存」', { actual: after401?.text })
  if (!raw.scenario.assertions.noDraftBanner) finding('C05', 'P1', '401 后仍有草稿横幅（继续/放弃草稿）', { actual: after401?.text })
  if (!raw.scenario.assertions.noDraftInDb) finding('C06', 'P1', '401 后 DB 仍残留草稿', { actual: drafts })
  if (!raw.scenario.assertions.startUsableAfterError) finding('C07', 'P1', '401 后「开始生成」不可用', { actual: after401?.start })
  if (!raw.scenario.assertions.onlyErrorLine) finding('C08', 'P2', '错误行不止一条', { actual: after401?.danger })

  // ---- direct retry (same button, same panel) ----
  st.mode = 'ok'
  const callsBeforeRetry = st.calls
  const retryStart = gen.getByRole('button', { name: '开始生成', exact: true })
  const retryEnabled = await retryStart.isEnabled().catch(() => false)
  await retryStart.click()
  const review = reviewDialog()
  const reviewShown = await review.waitFor({ state: 'visible', timeout: 45000 }).then(() => true).catch(() => false)
  let reviewText = ''
  let reviewItems = 0
  if (reviewShown) {
    reviewItems = await review.getByRole('checkbox', { name: /^选择 / }).count()
    reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 900)
    await shot(page, 'S1-03-retry-review')
  } else {
    await shot(page, 'S1-03-retry-failed')
  }
  raw.scenario.retry = {
    clickReady: retryEnabled,
    mockCalls: st.calls - callsBeforeRetry,
    reviewShown,
    reviewItems,
    reviewText,
    mockTags: st.tags.slice(),
    draftsAfter: (await listDrafts(page)).length,
  }
  if (!retryEnabled) finding('C09', 'P1', '重试时「开始生成」不可用')
  if (!reviewShown) finding('C10', 'P1', '错误后直接重试未进入生成（审核框未出现）', { actual: await panelState() })
  if (reviewShown && reviewItems < 1) finding('C11', 'P1', '重试进入审核但条目为 0', { actual: reviewText })
  if (raw.scenario.retry.mockCalls < 1) finding('C12', 'P1', '重试未发出 mock 请求')

  // 重试成功后的 panel 不应再残留 401
  const afterRetryPanel = await panelState().catch(() => null)
  raw.scenario.panelAfterRetry = afterRetryPanel
} catch (e) {
  raw.scenario.error = String(e?.stack ?? e).slice(0, 2000)
  finding('X00', 'P1', '脚本异常', { actual: raw.scenario.error })
  await shot(page, 'S1-99-error').catch(() => {})
} finally {
  raw.consoleErrors = bag.consoleErrors.slice(-20)
  raw.pageErrors = bag.pageErrors.slice(-10)
  raw.cost = { realCalls: 0, yuan: 0 }
  raw.finishedAt = now()
  await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8')
  log(`\nDONE findings=${raw.findings.length} calls=${st.calls} build=${raw.build} version=${raw.versionText}`)
  await context.close()
}
