/** 0.3.26「AI 补充内容」独立 QA（只读测试；不改 src） */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  launch, newContext, BASE, OUT, ROOT, log, shot, assert, sleep, loadKey,
  installRouter, makeMockState, prepareClean, prepareWord, openAiPanel, closeDialogs,
  panelText, panelTarget, waitPanelTarget, listDrafts, listPacks, wordSnapshot,
  getSetting, putSetting, setupAi, clickHomeLearn, enterAnnotation, boardWord,
  waitSeededHome, injectPlanForWord,
} from './ai-qa-lib.mjs'

const KEY = await loadKey()
const RAW_PATH = process.env.QA_RAW || join(ROOT, 'docs/qa/ai-0.3.26-raw.json')
const raw = { startedAt: new Date().toISOString(), base: BASE, build: null, versionText: null, findings: [], scenarios: {}, consoleErrors: [], pageErrors: [], screenshots: [], notes: [] }
const REAL_START = { calls: 0 }
let findingSeq = 0
let currentBrowser = null
function finding(sev, title, opts = {}) {
  findingSeq += 1
  const f = { id: opts.id ?? `F${String(findingSeq).padStart(2, '0')}`, severity: sev, title, spec: opts.spec ?? '', expected: opts.expected ?? '', actual: opts.actual ?? '', steps: opts.steps ?? '', evidence: opts.evidence ?? [], console: opts.console ?? [], stable: opts.stable ?? true, note: opts.note ?? '' }
  raw.findings.push(f)
  log(`  🐞 [${sev}] ${f.id} ${title}`)
  return f
}
async function saveRaw() { await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8') }
async function expectNoConsole(bag, scenario) {
  if (bag.consoleErrors.length) raw.consoleErrors.push({ scenario, console: bag.consoleErrors.slice(0, 5) })
  if (bag.pageErrors.length) raw.pageErrors.push({ scenario, page: bag.pageErrors.slice(0, 3) })
}
async function run(name, fn) {
  log(`\n===== ${name} =====`)
  const t0 = Date.now()
  const holder = {}
  try {
    const out = await fn(currentBrowser, holder)
    raw.scenarios[name] = { ok: true, ms: Date.now() - t0, ...holder, ...(out ?? {}) }
    log(`✅ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`)
  } catch (e) {
    raw.scenarios[name] = { ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e), ...holder }
    log(`❌ ${name}: ${e?.message ?? e}`)
  }
  await saveRaw()
}

// ---------- S1 设置 / 连通性 ----------
async function s1(browser, out = {}) {
  const { context, page, bag } = await newContext(browser)
  const state = makeMockState()
  await installRouter(page, state)
  out.text = {}
  try {
    await prepareClean(page)
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
    await page.getByText('AI 扩充（可选）').first().waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded()
    await sleep(500)
    const enable = page.getByRole('switch', { name: '启用 AI 扩充' })
    if ((await enable.getAttribute('aria-checked')) !== 'true') await enable.click()
    await sleep(500)
    out.initialKeyState = (await page.locator('body').innerText()).match(/API Key\s*(未配置|已配置[^\n]*)/)?.[1] ?? ''
    assert(/未配置/.test(out.initialKeyState), `初始应显示未配置，实际 ${out.initialKeyState}`)
    await page.getByLabel('AI baseURL').fill('https://api.deepseek.com')
    await page.getByLabel('AI 模型').fill('deepseek-chat')
    await page.getByLabel('AI API Key').fill(KEY)
    const t0 = Date.now()
    await page.getByRole('button', { name: '保存 Key', exact: true }).click()
    await page.waitForFunction(() => /已配置：/.test(document.body.innerText), { timeout: 20_000 })
    out.maskDelayMs = Date.now() - t0
    out.maskedLine = (await page.locator('body').innerText()).match(/已配置：[^\n]*/)?.[0] ?? ''
    out.maskOk = /^已配置：sk-…[0-9a-z]{4}$/i.test(out.maskedLine.trim())
    if (out.maskDelayMs > 1500) finding('P2', 'Key 保存后掩码回显延迟（非即时刷新）', {
      spec: 'SPEC §1：API Key 页面只显示掩码；设置保存后应即时反映', expected: '点击「保存 Key」后立即显示「已配置：sk-…xxxx」', actual: `约 ${out.maskDelayMs}ms 后才出现掩码（期间仍显示未配置）`, steps: '设置→AI 扩充→填 Key→保存 Key；观察 API Key 行文案',
      evidence: [await shot(page, 'S1-01-key-masked')], stable: true,
    })
    await shot(page, 'S1-01-key-masked')

    // 真实测试连接
    state.mode = 'real'
    const t1 = Date.now()
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await page.getByText(/连接成功|连接失败/).first().waitFor({ state: 'visible', timeout: 45_000 })
    out.testSuccess = (await page.getByText(/连接成功|连接失败/).first().innerText()).trim()
    out.testSuccessMs = Date.now() - t1
    REAL_START.calls += 1
    assert(/连接成功/.test(out.testSuccess), `真实 Key 测试连接应成功，实际 ${out.testSuccess}`)
    await shot(page, 'S1-02-test-success')

    // 失败文案：401 / 402 / 429 / 408 / network
    const runFail = async (mode, label) => {
      state.mode = mode
      await page.getByRole('button', { name: '测试连接', exact: true }).click()
      const el = page.getByText(/连接失败/).first()
      await el.waitFor({ state: 'visible', timeout: 40_000 }).catch(() => {})
      await sleep(300)
      const text = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
      state.mode = 'ok'
      return { mode, label, text }
    }
    out.fail401 = await runFail('401', '401')
    out.fail402 = await runFail('402', '402')
    out.fail429 = await runFail('429', '429')
    out.fail408 = await runFail('408', '408')
    out.failNetwork = await runFail('network', 'network')
    for (const r of [out.fail401, out.fail402, out.fail429, out.fail408]) {
      const hasStatus = new RegExp(`HTTP\\s*${r.label}`).test(r.text)
      if (!hasStatus) finding('P2', `测试连接失败文案缺少 HTTP 状态（${r.label}）`, {
        spec: 'SPEC §1：失败显示底层原因（HTTP 状态 + 响应体摘要），不得只显示「超时」',
        expected: `文案含 HTTP ${r.label} 与响应体摘要`, actual: r.text || '(无文案)',
        steps: `设置→AI 扩充→测试连接（mock ${r.label}）`,
        evidence: [await shot(page, `S1-03-test-fail-${r.label}`)], stable: true,
      })
    }
    await shot(page, 'S1-03-test-fail-429')

    // 清除 Key
    await page.getByRole('button', { name: '清除 Key', exact: true }).click()
    await page.waitForFunction(() => /未配置/.test(document.body.innerText), { timeout: 20_000 })
    out.cleared = true
    // session 模式刷新失效
    await page.getByLabel('Key 存储方式').selectOption('session')
    await sleep(300)
    await page.getByLabel('AI API Key').fill('sk-SESSION-QA-12345678')
    await page.getByRole('button', { name: '保存 Key', exact: true }).click()
    await page.waitForFunction(() => /已配置：/.test(document.body.innerText), { timeout: 20_000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded().catch(() => {})
    await sleep(1000)
    const sessionBody = await page.locator('body').innerText()
    out.sessionAfterReload = /未配置/.test(sessionBody)
    assert(out.sessionAfterReload, 'session Key 刷新后应失效')
    // 恢复 persistent 真实 Key
    await page.getByLabel('Key 存储方式').selectOption('persistent')
    await sleep(300)
    await page.getByLabel('AI API Key').fill(KEY)
    await page.getByRole('button', { name: '保存 Key', exact: true }).click()
    await page.waitForFunction(() => /已配置：/.test(document.body.innerText), { timeout: 20_000 })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded().catch(() => {})
    await sleep(800)
    const pageHtml = await page.content()
    out.fullKeyInDom = pageHtml.includes(KEY)
    out.fullKeyInConsole = bag.pageTexts.some((t) => t.includes(KEY))
    out.maskedAfterReload = (await page.locator('body').innerText()).match(/已配置：[^\n]*/)?.[0] ?? ''
    assert(!out.fullKeyInDom, '页面 DOM 不得出现完整 Key')
    assert(!out.fullKeyInConsole, 'console 不得出现完整 Key')
    assert(/sk-…/.test(out.maskedAfterReload), `重载后应显示掩码，实际 ${out.maskedAfterReload}`)
    out.aiVersion = (await page.locator('body').innerText()).match(/版本\s*(v[0-9.]+)/)?.[1] ?? ''
    await shot(page, 'S1-04-after-reload-mask')
    return out
  } finally {
    await expectNoConsole(bag, 'S1')
    await context.close()
  }
}

// ---------- S2 面板范围/类型/模式/目标 ----------
async function s2(browser, out = {}) {
  const { context, page, bag } = await newContext(browser)
  const state = makeMockState()
  await installRouter(page, state)
  out.samples = {}
  try {
    await prepareClean(page)
    await setupAi(page)
    // 空词库
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const q = indexedDB.open('momo-reword')
        q.onsuccess = () => resolve(q.result)
        q.onerror = () => reject(q.error)
      })
      await new Promise((resolve, reject) => {
        const tx = db.transaction('decks', 'readwrite')
        tx.objectStore('decks').put({ id: 'qa-empty-deck', name: 'QA空词库（0 词）', description: '', source: 'manual', isDefault: false, wordCount: 0, dataVersion: 1, createdAt: Date.now(), updatedAt: Date.now() })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    })
    // 小词库（2 词：1 有例句 / 1 无例句）用于确定「选择词库」目标数
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const q = indexedDB.open('momo-reword')
        q.onsuccess = () => resolve(q.result)
        q.onerror = () => reject(q.error)
      })
      const words = await new Promise((resolve) => {
        const q = db.transaction('words', 'readonly').objectStore('words').getAll()
        q.onsuccess = () => resolve(q.result)
      })
      const src = JSON.parse(JSON.stringify(words.find((w) => w.headwordLower === 'address')))
      const mk = (name, withExample, order) => ({
        ...src, id: `qa-small:${name}`, deckId: 'qa-small', headword: name, headwordLower: name, order,
        examples: withExample ? src.examples : [], phrases: [], mnemonics: [],
        meanings: src.meanings.map((m) => ({ ...m, examples: [] })),
      })
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['words', 'decks'], 'readwrite')
        tx.objectStore('words').put(mk('qaword1', true, 1))
        tx.objectStore('words').put(mk('qaword2', false, 2))
        tx.objectStore('decks').put({ id: 'qa-small', name: 'QA小词库（2 词）', description: '', source: 'manual', isDefault: false, wordCount: 2, dataVersion: 1, createdAt: Date.now(), updatedAt: Date.now() })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    })
    out.injected = await prepareWord(page, { headword: 'address' })
    out.headword = out.injected.headword
    const gen = await openAiPanel(page)
    await sleep(1200)
    out.panelInitial = (await panelText(page)).slice(0, 1200)
    out.scopes = ['今日要学', '当前词库', '当前词', '指定含义', '选择词库', '自定义选词'].filter((t) => out.panelInitial.includes(t))
    out.kinds = ['例句', '词组', '助记', '本义/引申链'].filter((t) => out.panelInitial.includes(t))
    assert(out.scopes.length === 6, `范围应有 6 项，实际 ${JSON.stringify(out.scopes)}`)
    assert(out.kinds.length === 4, `类型应有 4 项，实际 ${JSON.stringify(out.kinds)}`)
    out.defaultPressed = (await gen.locator('button[aria-pressed="true"]').allInnerTexts()).map((s) => s.trim())
    out.examplesModes = await gen.getByLabel('例句生成模式').locator('option').allInnerTexts()
    out.examplesModeDefault = await gen.getByLabel('例句生成模式').inputValue()
    await shot(page, 'S2-01-panel-default')

    // 只选例句 + 追加更多 → 1
    await gen.getByLabel('例句生成模式').selectOption('append')
    out.targetAppend = await waitPanelTarget(page, 1)
    assert(out.targetAppend === 1, `当前词 append 例句目标应 1，实际 ${out.targetAppend}`)
    // 加词组/助记/本义 → 4
    await gen.getByRole('button', { name: /^(✓ )?词组$/ }).click()
    await gen.getByLabel('词组生成模式').selectOption('append')
    await gen.getByRole('button', { name: /^(✓ )?助记$/ }).click()
    await gen.getByLabel('助记生成模式').selectOption('append')
    await gen.getByRole('button', { name: /^(✓ )?本义\/引申链$/ }).click()
    await sleep(500)
    out.semanticsModes = await gen.getByLabel('本义/引申链生成模式').locator('option').allInnerTexts()
    await gen.getByLabel('本义/引申链生成模式').selectOption('replace')
    out.targetAllKinds = await waitPanelTarget(page, 4)
    out.startEnabledAll = !(await gen.getByRole('button', { name: '开始生成', exact: true }).isDisabled())
    out.estimateAt4 = (await panelText(page)).match(/预计 ¥[\d.]+ \/ 单次上限 [^\s]+/)?.[0] ?? ''
    assert(out.targetAllKinds === 4, `4 类型各 1 目标应=4，实际 ${out.targetAllKinds}`)
    assert(out.startEnabledAll, '有目标时开始生成应可点')
    await shot(page, 'S2-02-all-kinds')

    // 回到仅例句 append，目标 1；再切「指定含义」未勾选 → 必须 0 + 提示 + 禁用
    await gen.getByRole('button', { name: /^(✓ )?词组$/ }).click()
    await gen.getByRole('button', { name: /^(✓ )?助记$/ }).click()
    await gen.getByRole('button', { name: /^(✓ )?本义\/引申链$/ }).click()
    await gen.getByLabel('例句生成模式').selectOption('append')
    await waitPanelTarget(page, 1)
    const samples = []
    await gen.getByRole('button', { name: '指定含义', exact: true }).click()
    for (let i = 0; i < 25; i += 1) {
      samples.push({ ms: i * 120, target: await panelTarget(page), disabled: await gen.getByRole('button', { name: '开始生成', exact: true }).isDisabled().catch(() => true), warn: /请至少选择|请先勾选/.test(await panelText(page)) })
      await sleep(120)
    }
    out.meaningsSamples = samples
    out.meaningsFinal = samples[samples.length - 1]
    out.meaningsMax = Math.max(...samples.map((s) => s.target))
    if (samples[samples.length - 1].target !== 0 || !samples[samples.length - 1].disabled) {
      finding('P1', '「指定含义」未勾选时目标数未归零/开始生成仍可点（旧目标残留）', {
        spec: 'SPEC §2：指定含义未勾选时目标数为 0 并提示「请先勾选要生成的含义」；§7 开始生成在目标 0 时禁用',
        expected: '切到指定含义后目标=0、开始生成禁用、提示请先勾选',
        actual: `采样 ${samples.map((s) => `${s.ms}ms:${s.target}`).join(' ')}；最终 target=${samples[samples.length - 1].target} disabled=${samples[samples.length - 1].disabled}`,
        steps: '学习页→更多→AI 补内容→当前词→例句/追加更多（目标 1）→点「指定含义」不勾选',
        evidence: [await shot(page, 'S2-03-meanings-stale')], stable: true,
      })
    }
    await shot(page, 'S2-03-meanings-stale')
    // 勾选 c1 / c1+c2
    await gen.getByRole('checkbox', { name: '选择含义 c1', exact: true }).click()
    out.targetC1 = await waitPanelTarget(page, 1)
    await gen.getByRole('checkbox', { name: '选择含义 c2', exact: true }).click()
    out.targetC1C2 = await waitPanelTarget(page, 2)
    out.staleWarningAfterSelect = (await panelText(page)).includes('请至少选择一个含义')
    assert(out.targetC1 === 1 && out.targetC1C2 === 2, `勾选含义目标应 1→2，实际 ${out.targetC1}/${out.targetC1C2}`)
    await gen.getByRole('checkbox', { name: '选择含义 c1', exact: true }).click()
    await gen.getByRole('checkbox', { name: '选择含义 c2', exact: true }).click()
    out.targetNone = await waitPanelTarget(page, 0)
    await shot(page, 'S2-04-meanings-selected')

    // 自定义选词：未选词库/未搜索
    await gen.getByRole('button', { name: '自定义选词', exact: true }).click()
    await sleep(700)
    out.customEmptyText = (await panelText(page)).slice(0, 900)
    out.customPrompt = /请先选择词库或输入搜索\/字母前缀/.test(out.customEmptyText)
    out.customCount0 = /已选 0 \/ 共 0（单次 ≤500）/.test(out.customEmptyText)
    out.customStartDisabled = await gen.getByRole('button', { name: '开始生成', exact: true }).isDisabled()
    assert(out.customPrompt, `自定义选词空态应提示选择词库/搜索，实际 ${out.customEmptyText.slice(0, 300)}`)
    await shot(page, 'S2-05-custom-empty')

    // 选择词库：先选空词库，再选 2 词小词库（append 目标应为 2）
    await gen.getByRole('button', { name: '选择词库', exact: true }).click()
    await sleep(800)
    out.deckButtons = (await gen.locator('button.mm-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).slice(0, 8)
    const emptyBtn = gen.getByRole('button', { name: /QA空词库（0 词）/ }).first()
    out.emptyDeckFound = (await emptyBtn.count()) > 0
    if (out.emptyDeckFound) {
      await emptyBtn.click()
      await sleep(1800)
      out.emptyDeckText = (await panelText(page)).slice(0, 1000)
      out.emptyDeckTarget = await panelTarget(page)
      out.emptyDeckDisabled = await gen.getByRole('button', { name: '开始生成', exact: true }).isDisabled()
      out.emptyDeckPrompt = /没有可生成的词（已有\/被排除）/.test(out.emptyDeckText)
      if (!(out.emptyDeckTarget === 0 && out.emptyDeckDisabled && out.emptyDeckPrompt)) {
        finding('P1', '选择空词库后目标数/空态未刷新（旧目标残留）', { spec: 'SPEC §2：任意 scope 变化后目标数必须立即重算；§3 目标 0 显示提示并禁用', expected: '目标 0 + 「没有可生成的词（已有/被排除）」+ 开始生成禁用', actual: `target=${out.emptyDeckTarget}, disabled=${out.emptyDeckDisabled}, prompt=${out.emptyDeckPrompt}, text=${out.emptyDeckText.slice(0, 260)}`, steps: 'AI 面板→当前词/例句/追加更多（目标 1）→选择词库→点「QA空词库（0 词）」', evidence: [await shot(page, 'S2-06-empty-deck')], stable: true })
      }
    }
    const smallBtn = gen.getByRole('button', { name: /QA小词库（2 词）/ }).first()
    out.smallDeckFound = (await smallBtn.count()) > 0
    if (out.smallDeckFound) {
      await smallBtn.click()
      const samplesDeck = []
      for (let i = 0; i < 16; i += 1) { samplesDeck.push(await panelTarget(page)); await sleep(250) }
      out.deckSamples = samplesDeck
      out.deckTarget = samplesDeck[samplesDeck.length - 1]
      out.deckTargetExpected = 2
      if (out.deckTarget !== 2) {
        finding('P1', '「选择词库」选中词库后目标数不刷新（旧目标残留）', { spec: 'SPEC §2：任意 scope 变化后目标数、费用预估必须立即重算；§3 选择变化即刷新目标数', expected: '选择 2 词小词库（append 例句）后目标=2', actual: `目标保持 ${out.deckTarget}（4s 采样：${samplesDeck.join(',')}）`, steps: 'AI 面板→例句/追加更多（目标 1）→选择词库→点「QA小词库（2 词）」', evidence: [await shot(page, 'S2-07-deck-stale')], stable: true })
      }
      // 触发一次类型/模式变化后应恢复正确
      await gen.getByLabel('例句生成模式').selectOption('missing')
      await sleep(1200)
      out.deckTargetMissingAfterMode = await panelTarget(page)
      await gen.getByLabel('例句生成模式').selectOption('append')
      out.deckTargetAppendAfterMode = await waitPanelTarget(page, 2, 10_000)
      out.deckRefreshAfterMode = out.deckTargetAppendAfterMode === 2
      await shot(page, 'S2-07b-deck-after-mode')
    }

    // 回到当前词，仅例句 仅缺失 → 0 目标提示 + 禁用；0 目标不建草稿
    await gen.getByRole('button', { name: '当前词', exact: true }).click()
    await sleep(300)
    const kindsNow = (await gen.locator('button[aria-pressed="true"]').allInnerTexts()).map((s) => s.trim())
    if (kindsNow.some((t) => t.includes('词组'))) await gen.getByRole('button', { name: /^(✓ )?词组$/ }).click()
    if (kindsNow.some((t) => t.includes('助记'))) await gen.getByRole('button', { name: /^(✓ )?助记$/ }).click()
    if (kindsNow.some((t) => t.includes('本义'))) await gen.getByRole('button', { name: /^(✓ )?本义\/引申链$/ }).click()
    await gen.getByLabel('例句生成模式').selectOption('missing')
    out.targetMissing = await waitPanelTarget(page, 0, 10_000)
    out.zeroText = (await panelText(page)).slice(0, 800)
    out.zeroPrompt = /没有可生成的词（已有\/被排除）/.test(out.zeroText)
    out.zeroStartDisabled = await gen.getByRole('button', { name: '开始生成', exact: true }).isDisabled()
    out.draftsAfterOpen = await listDrafts(page)
    assert(out.zeroPrompt && out.zeroStartDisabled && out.draftsAfterOpen.length === 0, `0 目标应提示+禁用+无草稿；target=${out.targetMissing}, disabled=${out.zeroStartDisabled}, prompt=${out.zeroPrompt}, drafts=${out.draftsAfterOpen.length}`)
    await shot(page, 'S2-08-zero-target')

    out.estimateAt0 = (await panelText(page)).match(/预计 ¥[\d.]+ \/ 单次上限 [^\s]+/)?.[0] ?? ''
    if (out.estimateAt4 === out.estimateAt0 && out.estimateAt4.includes('¥0.00')) {
      finding('P2', '费用预估始终 ¥0.00，不随目标数变化', { spec: 'SPEC §2/§3：scope/类型/模式变化后目标数与费用预估必须重算/刷新', expected: '目标 4 与目标 0 的预计费用不同（>0 时随目标数估算）', actual: `目标 4：${out.estimateAt4}；目标 0：${out.estimateAt0}`, steps: 'AI 面板切换类型/模式，对比「预计 ¥…」行', evidence: [await shot(page, 'S2-09-estimate')], stable: true })
    }
    return out
  } finally {
    await expectNoConsole(bag, 'S2')
    await context.close()
  }
}

// ---------- main ----------
const only = (process.env.QA_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean)
async function main() {
  await mkdir(OUT, { recursive: true })
  const browser = await launch()
  currentBrowser = browser
  try {
    {
      const { context, page } = await newContext(browser)
      try {
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        const html = await page.content()
        raw.build = html.match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
        raw.versionText = (await page.locator('body').innerText()).match(/v0\.3\.\d+/)?.[0] ?? null
        log(`build=${raw.build} version=${raw.versionText}`)
      } finally { await context.close() }
    }
    const scenarios = [['S1 设置与连通性', s1], ['S2 范围/类型/模式', s2]]
    for (const [name, fn] of scenarios) {
      if (only.length && !only.some((k) => name.startsWith(k))) continue
      await run(name, (b, h) => fn(b, h))
    }
  } finally {
    await browser.close().catch(() => {})
    await saveRaw()
    log(`\n📄 ${RAW_PATH}  findings=${raw.findings.length}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
