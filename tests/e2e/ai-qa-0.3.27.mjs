/** 0.3.27「AI 补充内容」QA：F01/F02 复测 + 替换本义 P0 + 草稿 + 选项刷新 + 错误/取消/UI。
 *  只读测试，不改 src。mock 覆盖状态分支；真实 API 仅语义替换 ×2 + 助记 ×1。 */
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  launch, newContext, BASE, OUT, ROOT, log, shot, assert, sleep, loadKey,
  installRouter, makeMockState, prepareClean, prepareWord, openAiPanel, closeDialogs,
  panelText, panelTarget, waitPanelTarget, listDrafts, listPacks, wordSnapshot,
  setupAi, waitSeededHome, clickHomeLearn, enterAnnotation,
} from './ai-qa-lib.mjs'

const KEY = await loadKey()
const RAW_PATH = process.env.QA_RAW || join(ROOT, 'docs/qa/ai-0.3.27-raw.json')
const raw = { startedAt: new Date().toISOString(), base: BASE, build: null, versionText: null, findings: [], scenarios: {}, consoleErrors: [], pageErrors: [], screenshots: [], cost: { realCalls: 0, prompt: 0, completion: 0 }, notes: [] }
let seq = 0
let currentBrowser = null
let partial = {}
function finding(sev, title, o = {}) {
  seq += 1
  const f = { id: o.id ?? `F${String(seq).padStart(2, '0')}`, severity: sev, title, spec: o.spec ?? '', expected: o.expected ?? '', actual: o.actual ?? '', steps: o.steps ?? '', evidence: o.evidence ?? [], console: o.console ?? [], stable: o.stable ?? true, note: o.note ?? '' }
  raw.findings.push(f)
  log(`  🐞 [${sev}] ${f.id} ${title}`)
  return f
}
async function saveRaw() { await writeFile(RAW_PATH, JSON.stringify(raw, null, 2), 'utf8') }
function mergeUsage(s) {
  raw.cost.realCalls = (raw.cost.realCalls || 0) + (s.realCalls || 0)
  raw.cost.prompt += s.realUsage?.prompt ?? 0
  raw.cost.completion += s.realUsage?.completion ?? 0
}
async function expectNoConsole(bag, scenario) {
  if (bag.consoleErrors.length) raw.consoleErrors.push({ scenario, console: bag.consoleErrors.slice(0, 5) })
  if (bag.pageErrors.length) raw.pageErrors.push({ scenario, page: bag.pageErrors.slice(0, 3) })
}
async function run(name, fn) {
  log(`\n===== ${name} =====`)
  const t0 = Date.now()
  const holder = {}
  partial = {}
  try {
    const out = await fn(currentBrowser, holder)
    raw.scenarios[name] = { ok: true, ms: Date.now() - t0, ...holder, ...(out ?? {}) }
    log(`✅ ${name} (${Math.round((Date.now() - t0) / 1000)}s)`)
  } catch (e) {
    raw.scenarios[name] = { ok: false, ms: Date.now() - t0, error: String(e?.stack ?? e), ...holder, ...partial }
    log(`❌ ${name}: ${e?.message ?? e}`)
  }
  await saveRaw()
}
const est = async (page) => {
  const t = await panelText(page)
  const m = t.match(/预计 ¥([\d.]+) \/ 单次上限/)
  return m ? Number(m[1]) : null
}
const dangerText = async (gen) => (await gen.locator('.mm-danger-text').allInnerTexts()).join(' | ').trim()

// ---------- S0 设置测试连接 + 构建 ----------
async function s0(browser) {
  const { context, page, bag } = await newContext(browser)
  const state = makeMockState()
  await installRouter(page, state)
  try {
    await prepareClean(page)
    await setupAi(page)
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
    await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded({ timeout: 20_000 })
    await sleep(600)
    const out = {}
    for (const mode of ['401', '402', '429']) {
      state.mode = mode
      await page.getByRole('button', { name: '测试连接', exact: true }).click()
      const el = page.getByText(/连接成功|连接失败/).first()
      await el.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
      await sleep(400)
      const text = (await el.innerText().catch(() => '')).replace(/\s+/g, ' ').trim()
      out[`test${mode}`] = { text, hasHttp: new RegExp(`HTTP\\s*${mode}`).test(text) }
    }
    state.mode = 'ok'
    await shot(page, 'S0-01-test-connect-429')
    out.versionText = (await page.locator('body').innerText()).match(/v0\.3\.\d+/)?.[0] ?? ''
    raw.versionText = out.versionText
    return out
  } finally {
    await expectNoConsole(bag, 'S0')
    await context.close()
  }
}

// ---------- S1 mock：F01/F02/错误/0 目标/草稿/取消/UI ----------
async function s1(browser) {
  const { context, page, bag } = await newContext(browser)
  const state = makeMockState()
  await installRouter(page, state)
  const out = { errors: {}, draft: {}, zero: {}, cancel: {}, ui: {} }
  try {
    await prepareClean(page)
    await setupAi(page)
    out.word = await prepareWord(page, { headword: 'address' })
    out.meaningCount = out.word.meaningCount
    const gen = await openAiPanel(page)
    await sleep(1200)
    out.panelInitial = (await panelText(page)).slice(0, 500)
    Object.assign(partial, out)
    out.defaultPressed = (await gen.locator('button[aria-pressed="true"]').allInnerTexts()).map((s) => s.trim())

    // F02：目标 1 vs 目标 2 费用应变化
    await gen.getByLabel('例句生成模式').selectOption('append')
    out.t1 = await waitPanelTarget(page, 1)
    out.est1 = await est(page)
    await gen.getByRole('button', { name: '指定含义', exact: true }).click()
    await sleep(300)
    await gen.getByRole('checkbox', { name: '选择含义 c1', exact: true }).click()
    out.meaningTarget1 = await waitPanelTarget(page, 1)
    out.estC1 = await est(page)
    await gen.getByRole('checkbox', { name: '选择含义 c2', exact: true }).click()
    out.meaningTarget2 = await waitPanelTarget(page, 2)
    out.estC1C2 = await est(page)
    if (!(out.est1 > 0)) finding('P2', '费用预估为 ¥0.00（目标 1）', { spec: 'SPEC §2/§3：目标数与费用预估必须重算/刷新', expected: '目标≥1 时预计费用 > ¥0.00', actual: `目标 1 预估 ${out.est1}`, steps: 'AI 面板→当前词→例句/追加更多', evidence: [await shot(page, 'S1-01-estimate')] })
    if (out.estC1C2 === out.estC1) finding('P2', '费用预估不随目标数变化', { spec: 'SPEC §2：scope 变化后费用预估立即重算', expected: '目标 c1(1) 与 c1+c2(2) 费用不同', actual: `c1=${out.estC1} c1+c2=${out.estC1C2}`, steps: '指定含义勾选 c1 / c1+c2 对比预计费用', evidence: [await shot(page, 'S1-01b-estimate-c2')] })
    await shot(page, 'S1-01-estimate')

    // F01：指定含义未勾选 → 0/禁用/提示（含旧目标残留采样）
    await gen.getByRole('checkbox', { name: '选择含义 c1', exact: true }).click()
    await gen.getByRole('checkbox', { name: '选择含义 c2', exact: true }).click()
    const samples = []
    for (let i = 0; i < 20; i += 1) {
      samples.push({ ms: i * 150, target: await panelTarget(page), disabled: await gen.getByRole('button', { name: '开始生成', exact: true }).isDisabled().catch(() => true) })
      await sleep(150)
    }
    out.f01Samples = samples
    out.f01Target = samples.at(-1).target
    out.f01Disabled = samples.at(-1).disabled
    out.f01Text = (await panelText(page)).slice(0, 700)
    out.f01Warn = /请至少选择一个含义/.test(out.f01Text) && /请先勾选要生成的含义/.test(out.f01Text)
    out.f01Max = Math.max(...samples.map((s) => s.target))
    if (!(out.f01Max === 0 && out.f01Target === 0 && out.f01Disabled && out.f01Warn)) {
      finding('P1', '「指定含义」未勾选时目标未归零/未禁用/未提示（F01 复测失败）', {
        spec: 'SPEC §2：指定含义未勾选时目标数为 0 并提示「请先勾选要生成的含义」；§7 目标 0 时开始生成禁用',
        expected: '目标=0、开始生成禁用、提示请先勾选',
        actual: `采样 ${samples.map((s) => `${s.ms}ms:${s.target}`).join(' ')}；disabled=${out.f01Disabled}；warn=${out.f01Warn}`,
        steps: '学习页→更多→AI 补内容→当前词→例句/追加更多→指定含义（不勾选）',
        evidence: [await shot(page, 'S1-02-f01-meanings-empty')],
      })
    }
    Object.assign(partial, out)
    await shot(page, 'S1-02-f01-meanings-empty')

    // 选项切换：勾 c 后目标/费用立即刷新；旧错误清空
    await gen.getByRole('checkbox', { name: '选择含义 c1', exact: true }).click()
    out.c1Target = await waitPanelTarget(page, 1)
    out.c1Est = await est(page)
    await gen.getByRole('checkbox', { name: '选择含义 c2', exact: true }).click()
    out.c1c2Target = await waitPanelTarget(page, 2)
    out.c1c2Est = await est(page)
    if (!(out.c1Target === 1 && out.c1c2Target === 2)) finding('P1', '勾选含义后目标数未刷新', { spec: 'SPEC §2：选择变化即刷新目标数', expected: '1→2', actual: `${out.c1Target}→${out.c1c2Target}`, steps: '指定含义依次勾选 c1/c2', evidence: [await shot(page, 'S1-03-meanings-selected')] })
    await shot(page, 'S1-03-meanings-selected')

    // 错误文案 401/402/429（mock）；同时验证切换 scope 清空旧错误
    await gen.getByRole('button', { name: '当前词', exact: true }).click()
    await gen.getByLabel('例句生成模式').selectOption('append')
    await waitPanelTarget(page, 1)
    for (const status of ['401', '402', '429']) {
      state.mode = status
      const callsBefore = state.calls
      await gen.getByRole('button', { name: '开始生成', exact: true }).click()
      await gen.locator('.mm-danger-text').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
      await sleep(500)
      out.errors[status] = { text: await dangerText(gen), calls: state.calls - callsBefore, hasHttp: new RegExp(`HTTP\\s*${status}|${status}\\b`).test(await dangerText(gen)) }
      await shot(page, `S1-04-error-${status}`)
      // 切 scope → 旧错误/旧 summary 立即清空
      await gen.getByRole('button', { name: '指定含义', exact: true }).click()
      await sleep(600)
      out.errors[status].errorAfterScope = await gen.locator('.mm-danger-text').count()
      out.errors[status].summaryAfterScope = (await panelText(page)).match(/完成 \d+ \/ \d+|已取消[^ ]*/)?.[0] ?? ''
      if (out.errors[status].errorAfterScope > 0) finding('P2', `切换范围后旧错误未清空（${status}）`, { spec: 'SPEC §2/§3：任意 scope/类型/模式变化后旧错误必须立即清空', expected: '错误区消失', actual: `仍有 ${out.errors[status].errorAfterScope} 条 .mm-danger-text：${out.errors[status].text}`, steps: `mock ${status} 生成失败→切换范围`, evidence: [await shot(page, `S1-04b-scope-after-${status}`)] })
    }
    state.mode = 'ok'
    out.draftsAfterErrors = await listDrafts(page)
    Object.assign(partial, out)
    if (out.draftsAfterErrors.length > 0) finding('P2', '生成失败后残留空草稿', { spec: 'SPEC §5：失败/超时且 0 条目应清理空草稿', expected: '无草稿', actual: JSON.stringify(out.draftsAfterErrors).slice(0, 300), steps: 'mock 401 失败后查 packs.draft', evidence: [] })

    // 0 目标：mock 生成 1 条例句并保存，再切「仅缺失」→ 0 + 提示 + 禁用 + 无草稿
    await gen.getByRole('button', { name: '当前词', exact: true }).click()
    await gen.getByLabel('例句生成模式').selectOption('append')
    await waitPanelTarget(page, 1)
    await gen.getByRole('button', { name: '开始生成', exact: true }).click()
    const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
    await review.waitFor({ state: 'visible', timeout: 30_000 })
    out.reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 300)
    await shot(page, 'S1-05-review')
    await review.getByRole('button', { name: /^保存已选/ }).click()
    await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 20_000 })
    await sleep(1200)
    out.afterApply = { drafts: await listDrafts(page), packs: (await listPacks(page)).map((p) => ({ kind: p.kind, draft: p.draft, status: p.status })) }
    Object.assign(partial, out)
    if (out.afterApply.drafts.length > 0) finding('P1', '审核并应用成功后草稿未清除', { spec: 'SPEC §5：审核并应用成功 → 立即清除 draft；重开面板不得再出现继续/放弃横幅', expected: '草稿 0 条', actual: `仍有 ${out.afterApply.drafts.length} 条：${JSON.stringify(out.afterApply.drafts).slice(0, 200)}`, steps: '生成例句→保存已选→查 packs', evidence: [await shot(page, 'S1-05b-after-apply')] })

    const gen2 = await openAiPanel(page)
    await sleep(800)
    out.afterReopenText = (await panelText(page)).slice(0, 500)
    out.afterReopenBanner = /继续上次生成|放弃草稿/.test(out.afterReopenText)
    if (out.afterReopenBanner) finding('P1', '保存后重开面板仍出现「继续/放弃草稿」横幅', { spec: 'SPEC §5：应用成功清除 draft，重开不得出现横幅', expected: '无横幅', actual: out.afterReopenText.slice(0, 200), steps: '保存已选→关闭→重开 AI 面板', evidence: [await shot(page, 'S1-06-reopen-no-banner')] })
    await gen2.getByLabel('例句生成模式').selectOption('missing')
    await sleep(1500)
    out.zero.target = await panelTarget(page)
    out.zero.text = (await panelText(page)).slice(0, 600)
    out.zero.prompt = /没有可生成的词（已有\/被排除）/.test(out.zero.text)
    out.zero.disabled = await gen2.getByRole('button', { name: '开始生成', exact: true }).isDisabled()
    out.zero.drafts = await listDrafts(page)
    Object.assign(partial, out)
    assert(out.zero.target === 0 && out.zero.disabled && out.zero.prompt && out.zero.drafts.length === 0, `0 目标应 0/禁用/提示/无草稿，实际 ${JSON.stringify(out.zero)}`)
    await shot(page, 'S1-07-zero-target')

    // 完成草稿：助记 append 生成 1 → 关闭审核框（不保存）→ 重开 → 开始生成应提示且不新建请求
    await gen2.getByRole('button', { name: '助记', exact: true }).click()
    await gen2.getByLabel('助记生成模式').selectOption('append')
    await waitPanelTarget(page, 1)
    await gen2.getByRole('button', { name: '开始生成', exact: true }).click()
    const review2 = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
    await review2.waitFor({ state: 'visible', timeout: 30_000 })
    await review2.getByRole('button', { name: '关闭', exact: true }).click()
    await closeDialogs(page)
    await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 15_000 })
    const gen3 = await openAiPanel(page)
    await sleep(1000)
    out.draft.bannerText = (await panelText(page)).slice(0, 400)
    out.draft.banner = /继续上次生成（1\/1）|已生成 1 \/ 总 1（草稿已保存）/.test(out.draft.bannerText)
    out.draft.draftsBefore = await listDrafts(page)
    Object.assign(partial, out)
    if (!out.draft.banner) finding('P1', '重开面板未显示草稿进度横幅', { spec: 'SPEC §5：关闭面板再打开，若有 draft → 显示继续/放弃或已生成 X/Y', expected: '继续上次生成（1/1）或已生成 1 / 总 1', actual: out.draft.bannerText.slice(0, 250), steps: '生成助记→关闭审核框与面板→重开', evidence: [await shot(page, 'S1-08-draft-banner')] })
    // 幽灵横幅：同一文案出现多次
    const bodyText = await page.locator('body').innerText()
    out.draft.bannerCount = (bodyText.match(/继续上次生成/g) ?? []).length
    if (out.draft.bannerCount > 1) finding('P2', '草稿横幅重复出现（幽灵/穿层）', { spec: 'SPEC §7：面板打开时底部/顶部不得出现幽灵横幅', expected: '横幅仅 1 处', actual: `「继续上次生成」出现 ${out.draft.bannerCount} 次`, steps: '带未完成草稿重开 AI 面板', evidence: [await shot(page, 'S1-08b-ghost-banner')] })
    await shot(page, 'S1-08-draft-banner')
    // 点开始生成：应提示「请先继续或放弃草稿」，不发请求、不丢草稿
    await gen3.getByLabel('助记生成模式').selectOption('append')
    await sleep(300)
    const callsBeforeStart = state.calls
    await gen3.getByRole('button', { name: '开始生成', exact: true }).click()
    await sleep(800)
    out.draft.startPrompt = (await panelText(page)).slice(0, 500)
    out.draft.startCalls = state.calls - callsBeforeStart
    out.draft.draftsAfterStart = await listDrafts(page)
    if (!/请先继续或放弃草稿|草稿已生成完成/.test(out.draft.startPrompt)) finding('P1', '有已完成草稿时点开始生成未提示', { spec: 'SPEC §5：已有未完成草稿时点开始生成必须提示「请先继续或放弃草稿」，禁止静默新建/清空', expected: '提示且不发请求', actual: out.draft.startPrompt.slice(0, 250), steps: '带完成草稿点开始生成', evidence: [await shot(page, 'S1-09-draft-start-prompt')] })
    if (out.draft.startCalls > 0) finding('P0', '有草稿时点开始生成仍发起新请求', { spec: 'SPEC §5：禁止静默新建', expected: '无新请求', actual: `${out.draft.startCalls} 次请求`, steps: '带完成草稿点开始生成', evidence: [await shot(page, 'S1-09b-draft-start-calls')] })
    if (out.draft.draftsAfterStart.length === 0) finding('P1', '点开始生成后旧草稿被清空', { spec: 'SPEC §5：禁止清空旧草稿', expected: '草稿保留', actual: '0 条', steps: '带完成草稿点开始生成', evidence: [] })
    await shot(page, 'S1-09-draft-start-prompt')
    // 放弃草稿 → 二次确认 → 草稿删除（失败不中断后续）
    try {
      await gen3.getByRole('button', { name: '放弃草稿', exact: true }).click({ timeout: 5_000 })
      const confirm = page.locator('.mm-dialog').filter({ hasText: '放弃草稿？' }).last()
      await confirm.waitFor({ state: 'visible', timeout: 8_000 })
      await confirm.getByRole('button', { name: '放弃', exact: true }).click()
      await sleep(1000)
      out.draft.afterDiscard = await listDrafts(page)
      out.draft.bannerAfterDiscard = /继续上次生成|已生成 1 \/ 总 1/.test(await panelText(page))
      await shot(page, 'S1-10-draft-discarded')
    } catch (e) {
      out.draft.discardError = String(e?.message ?? e).slice(0, 200)
    }
    Object.assign(partial, out)

    // 取消：mock 延迟 5s，点开始后立即取消（重新开面板，避免上一步状态影响）
    await closeDialogs(page)
    const genC = await openAiPanel(page)
    await sleep(500)
    await genC.getByLabel('助记生成模式').selectOption('append')
    await waitPanelTarget(page, 1)
    await sleep(300)
    state.delayMs = 5000
    await genC.getByRole('button', { name: '开始生成', exact: true }).click()
    await sleep(500)
    out.cancel.runningText = (await panelText(page)).slice(0, 300)
    out.cancel.startDisabledOrCancel = await genC.getByRole('button', { name: '取消生成', exact: true }).isVisible().catch(() => false)
    await shot(page, 'S1-11-running')
    await genC.getByRole('button', { name: '取消生成', exact: true }).click()
    await genC.locator('.mm-caption').filter({ hasText: /已取消/ }).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    await sleep(1200)
    out.cancel.afterText = (await panelText(page)).slice(0, 500)
    out.cancel.drafts = await listDrafts(page)
    state.delayMs = 0
    Object.assign(partial, out)
    if (!/已取消/.test(out.cancel.afterText)) finding('P2', '取消生成后无「已取消」提示', { spec: 'SPEC §4：取消保留已生成条目，提示「已取消，草稿已保存」', expected: '显示已取消', actual: out.cancel.afterText.slice(0, 250), steps: '生成中点取消', evidence: [await shot(page, 'S1-12-canceled')] })
    await shot(page, 'S1-12-canceled')
    await closeDialogs(page)

    // 清空草稿并重载，避免取消草稿阻塞长文本用例
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const q = indexedDB.open('momo-reword')
        q.onsuccess = () => resolve(q.result)
        q.onerror = () => reject(q.error)
      })
      const packs = await new Promise((resolve) => {
        const req = db.transaction('packs', 'readonly').objectStore('packs').getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve([])
      })
      const draftIds = packs.filter((p) => p.draft).map((p) => p.id)
      const tx = db.transaction(['packs', 'packItems'], 'readwrite')
      for (const id of draftIds) {
        tx.objectStore('packs').delete(id)
        const items = tx.objectStore('packItems').getAll()
        items.onsuccess = () => { for (const item of items.result) if (item.packId === id) tx.objectStore('packItems').delete(item.id) }
      }
      await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve })
    })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await clickHomeLearn(page)
    await enterAnnotation(page)

    // 长文本换行
    state.longText = true
    const gen4 = await openAiPanel(page)
    await sleep(500)
    await gen4.getByLabel('例句生成模式').selectOption('append')
    await waitPanelTarget(page, 1)
    await gen4.getByRole('button', { name: '开始生成', exact: true }).click()
    const review3 = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
    await review3.waitFor({ state: 'visible', timeout: 30_000 })
    Object.assign(partial, out)
    out.ui.longOverflow = await page.evaluate(() => ({
      sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
      rowSw: Math.max(...[...document.querySelectorAll('.mm-dialog .mm-row')].map((el) => el.scrollWidth)),
      rowCw: Math.max(...[...document.querySelectorAll('.mm-dialog .mm-row')].map((el) => el.clientWidth)),
    }))
    out.ui.longReviewText = (await review3.innerText()).replace(/\s+/g, ' ').slice(0, 200)
    await shot(page, 'S1-13-long-text')
    if (out.ui.longOverflow.sw > out.ui.longOverflow.cw + 1) finding('P2', '长文本横向溢出', { spec: 'SPEC §7：长文本换行、不被遮挡', expected: '无横向滚动', actual: JSON.stringify(out.ui.longOverflow), steps: 'mock 超长例句→审核框', evidence: [await shot(page, 'S1-13-long-text')] })
    await review3.getByRole('button', { name: /^关闭$/ }).click().catch(() => {})
    await closeDialogs(page)
    return out
  } finally {
    await expectNoConsole(bag, 'S1')
    await context.close()
  }
}

// ---------- S2 真实 API：替换本义 P0 + 助记草稿 ----------
async function s2(browser) {
  const { context, page, bag } = await newContext(browser)
  const state = makeMockState()
  state.mode = 'real'
  await installRouter(page, state)
  const out = {}
  try {
    await prepareClean(page)
    await setupAi(page, { key: KEY, maxCost: 3 })
    out.word = await prepareWord(page, { headword: 'address' })
    const gen = await openAiPanel(page)
    await sleep(1000)
    // 只选 semantics + replace
    for (const kind of ['例句', '词组', '助记', '本义/引申链']) {
      const pressed = await gen.getByRole('button', { name: new RegExp(`^(✓ )?${kind.replace('/', '\\/')}$`) }).getAttribute('aria-pressed')
      if (kind === '本义/引申链' ? pressed !== 'true' : pressed === 'true') await gen.getByRole('button', { name: new RegExp(`^(✓ )?${kind.replace('/', '\\/')}$`) }).click()
    }
    await gen.getByLabel('本义/引申链生成模式').selectOption('replace')
    out.semTarget1 = await waitPanelTarget(page, 1, 15_000)
    out.semKinds = (await gen.locator('button[aria-pressed="true"]').allInnerTexts()).map((s) => s.trim())
    await shot(page, 'S2-01-semantics-replace-ready')
    assert(out.semKinds.some((t) => t.includes('本义')), `类型应为本义，实际 ${JSON.stringify(out.semKinds)}`)

    const runReplace = async (label) => {
      const r = { label, calls: state.realCalls }
      await gen.getByRole('button', { name: '开始生成', exact: true }).click()
      const review = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
      await review.waitFor({ state: 'visible', timeout: 90_000 })
      r.reviewText = (await review.innerText()).replace(/\s+/g, ' ').slice(0, 500)
      r.items = await review.getByRole('checkbox', { name: /^选择 / }).count()
      r.replaceNotice = /将替换/.test(r.reviewText)
      await shot(page, `S2-02-review-${label}`)
      await review.getByRole('button', { name: /^保存已选/ }).click()
      await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 30_000 })
      await sleep(1500)
      r.annotation = await page.evaluate(() => ({
        core: [...document.querySelectorAll('.core-senses .core-sense-line')].map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
        chains: [...document.querySelectorAll('.derivation-chain')].map((el) => el.innerText.replace(/\s+/g, ' ').trim()),
        bodyHasEmpty: /暂无释义数据/.test(document.querySelector('.meanings')?.innerText ?? ''),
      }))
      r.snapshot = await wordSnapshot(page, out.word.headword)
      r.packs = (await listPacks(page)).map((p) => ({ id: p.id, kind: p.kind, status: p.status, draft: p.draft }))
      r.drafts = await listDrafts(page)
      r.realStatuses = state.realStatuses.slice()
      return r
    }
    out.replace1 = await runReplace('1')
    out.realUsage1 = { ...state.realUsage }
    out.realCalls1 = state.realCalls
    Object.assign(partial, out)
    await shot(page, 'S2-03-annotation-after-replace1')
    if (!(out.replace1.annotation.core.length > 0 && !out.replace1.annotation.bodyHasEmpty)) {
      finding('P0', '替换本义保存后注解面本义区为空（task-124 未修复）', {
        spec: 'SPEC §6：替换本义 P0 不变量——应用后 coreSenses/meaningMap 非空且为新内容；注解面显示本义 1..n、链，绝不出现空白本义区',
        expected: '注解面本义 1..n 非空+显示链',
        actual: `core=${JSON.stringify(out.replace1.annotation.core)} empty=${out.replace1.annotation.bodyHasEmpty} review=${out.replace1.reviewText.slice(0, 200)} snapshot.core=${JSON.stringify(out.replace1.snapshot?.coreSenses)?.slice(0, 200)}`,
        steps: '学习页 address→更多→AI 补内容→仅本义/替换该词本义→生成→保存已选',
        evidence: [await shot(page, 'S2-03-annotation-after-replace1')], console: bag.consoleErrors.slice(0, 3),
      })
    }
    if (out.replace1.snapshot && !(Array.isArray(out.replace1.snapshot.coreSenses) && out.replace1.snapshot.coreSenses.length > 0)) {
      raw.notes.push({ kind: 'p0-store', msg: 'Word.coreSenses 为空但注解面已有本义（内容存于 pack/effective）', core: out.replace1.annotation.core.length })
    }

    // 第二次替换：重开面板→替换→保存；应幂等（无重复本义/无 0/0 空包）
    const gen2 = await openAiPanel(page)
    await sleep(800)
    out.reopenBannerAfterSave = /继续上次生成|放弃草稿/.test(await panelText(page))
    if (out.reopenBannerAfterSave) finding('P1', '保存本义后重开面板仍有草稿横幅', { spec: 'SPEC §5：应用成功清除 draft', expected: '无横幅', actual: (await panelText(page)).slice(0, 200), steps: '保存→重开', evidence: [await shot(page, 'S2-04-reopen')] })
    await gen2.getByLabel('本义/引申链生成模式').selectOption('replace')
    await waitPanelTarget(page, 1, 15_000)
    out.replace2 = await runReplace('2')
    out.realUsage2 = { ...state.realUsage }
    out.realCalls2 = state.realCalls
    Object.assign(partial, out)
    await shot(page, 'S2-05-annotation-after-replace2')
    const labels1 = out.replace1.annotation.core.map((s) => s.replace(/^本义\d+「|」$/g, ''))
    const labels2 = out.replace2.annotation.core.map((s) => s.replace(/^本义\d+「|」$/g, ''))
    out.idempotent = {
      coreCount: [out.replace1.annotation.core.length, out.replace2.annotation.core.length],
      chains: [out.replace1.annotation.chains.length, out.replace2.annotation.chains.length],
      duplicateLabels: labels2.length !== new Set(labels2).size,
      labelsChanged: JSON.stringify(labels1) !== JSON.stringify(labels2),
      emptyPacks: out.replace2.packs.filter((p) => p.kind === 'semantics' && p.status !== 'applied'),
    }
    if (out.replace2.annotation.core.length === 0) finding('P0', '第二次替换后本义区为空', { spec: 'SPEC §6：反复应用幂等且本义非空', expected: '本义 1..n', actual: JSON.stringify(out.replace2.annotation), steps: '再次替换本义并保存', evidence: [await shot(page, 'S2-05-annotation-after-replace2')] })
    if (out.idempotent.duplicateLabels) finding('P1', '二次替换产生重复本义 label', { spec: 'SPEC §6：反复应用幂等', expected: 'label 唯一', actual: JSON.stringify(labels2), steps: '二次替换', evidence: [] })

    // 助记真实生成→保存→重开无横幅
    const gen3 = await openAiPanel(page)
    await sleep(600)
    await gen3.getByRole('button', { name: /^(✓ )?本义\/引申链$/ }).click()
    await gen3.getByRole('button', { name: /^(✓ )?助记$/ }).click()
    await gen3.getByLabel('助记生成模式').selectOption('append')
    out.mnTarget = await waitPanelTarget(page, 1, 15_000)
    await gen3.getByRole('button', { name: '开始生成', exact: true }).click()
    const review3 = page.locator('.mm-dialog').filter({ hasText: '审核生成内容' }).last()
    await review3.waitFor({ state: 'visible', timeout: 90_000 })
    out.mnemonicReview = (await review3.innerText()).replace(/\s+/g, ' ').slice(0, 400)
    await shot(page, 'S2-06-mnemonic-review')
    await review3.getByRole('button', { name: /^保存已选/ }).click()
    await page.waitForFunction(() => !document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]'), { timeout: 30_000 })
    await sleep(1500)
    out.mnemonicSnapshot = await wordSnapshot(page, out.word.headword)
    out.draftsAfterMnemonic = await listDrafts(page)
    const gen4 = await openAiPanel(page)
    await sleep(800)
    out.mnemonicReopen = (await panelText(page)).slice(0, 300)
    out.mnemonicReopenBanner = /继续上次生成|放弃草稿/.test(out.mnemonicReopen)
    if (out.mnemonicReopenBanner) finding('P1', '助记保存后重开面板仍有草稿横幅', { spec: 'SPEC §5', expected: '无横幅', actual: out.mnemonicReopen.slice(0, 200), steps: '助记生成→保存→重开', evidence: [await shot(page, 'S2-07-mnemonic-reopen')] })
    await shot(page, 'S2-07-mnemonic-reopen')
    await closeDialogs(page)
    out.realUsage = { ...state.realUsage }
    out.realCalls = state.realCalls
    out.realStatuses = state.realStatuses
    mergeUsage(out)
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
        raw.build = (await page.content()).match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
        raw.versionText = (await page.locator('body').innerText()).match(/v0\.3\.\d+/)?.[0] ?? null
        log(`build=${raw.build} version=${raw.versionText}`)
      } finally { await context.close() }
    }
    const scenarios = [['S0 设置与连通性', s0], ['S1 选项/错误/草稿/取消/UI', s1], ['S2 真实API替换本义', s2]]
    for (const [name, fn] of scenarios) {
      if (only.length && !only.some((k) => name.startsWith(k))) continue
      await run(name, (b, h) => fn(b, h))
    }
  } finally {
    await browser.close().catch(() => {})
    await saveRaw()
    log(`\n📄 ${RAW_PATH} findings=${raw.findings.length} realCalls=${raw.cost.realCalls} tokens=${raw.cost.prompt}/${raw.cost.completion}`)
  }
}
main().catch((e) => { console.error(e); process.exit(1) })
