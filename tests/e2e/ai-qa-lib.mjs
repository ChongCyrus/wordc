/** 0.3.26 AI 补内容 QA 公共工具（仅测试用，不改 src） */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..')
const TOOLS = join(ROOT, 'tools/e2e')
export const CHROMIUM = process.env.E2E_CHROMIUM || join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
export const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/'
export const OUT = process.env.QA_OUT || join(ROOT, 'docs/assets/qa/ai-0.3.26')
export const VIEWPORT = { width: 390, height: 844 }

export function loadKey() {
  return readFile(join(ROOT, '.secrets/deepseek-key'), 'utf8').then((t) => t.trim())
}

export async function launch() {
  await mkdir(OUT, { recursive: true })
  return chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: LIB },
  })
}

export async function newContext(browser, viewport = VIEWPORT) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', deviceScaleFactor: 1 })
  const page = await context.newPage()
  const bag = { consoleErrors: [], pageErrors: [], pageTexts: [] }
  page.on('console', (msg) => {
    const text = msg.text()
    bag.pageTexts.push(text)
    if (msg.type() === 'error') bag.consoleErrors.push(text.slice(0, 500))
  })
  page.on('pageerror', (err) => bag.pageErrors.push(String(err?.stack ?? err).slice(0, 1200)))
  return { context, page, bag }
}

export async function shot(page, name) {
  const path = join(OUT, `${process.env.QA_SHOT_PREFIX || ''}${name}.png`)
  await page.screenshot({ path }).catch(() => {})
  return path
}

export function log(...args) {
  console.log(...args)
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败：${msg}`)
}

// ---------- DB ----------
export async function dbOpen(page) {
  return page.evaluate(async () => {
    const req = indexedDB.open('momo-reword')
    return await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(true)
      req.onerror = () => reject(req.error)
    })
  })
}

export async function putSetting(page, key, value) {
  return page.evaluate(
    async ({ key, value }) => {
      const db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('momo-reword')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      await new Promise((resolve, reject) => {
        const tx = db.transaction('settings', 'readwrite')
        tx.objectStore('settings').put({ key, value, updatedAt: Date.now() })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      return true
    },
    { key, value },
  )
}

export async function getSetting(page, key) {
  return page.evaluate(async (k) => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('momo-reword')
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return await new Promise((resolve) => {
      const r = db.transaction('settings', 'readonly').objectStore('settings').get(k)
      r.onsuccess = () => resolve(r.result?.value)
      r.onerror = () => resolve(undefined)
    })
  }, key)
}

export async function setupAi(page, { key = 'sk-QA-TEST-KEY', baseUrl = 'https://api.deepseek.com', model = 'deepseek-chat', maxCost = 3 } = {}) {
  await putSetting(page, 'ai.enabled', true)
  await putSetting(page, 'ai.provider', 'deepseek')
  await putSetting(page, 'ai.baseUrl', baseUrl)
  await putSetting(page, 'ai.model', model)
  await putSetting(page, 'ai.apiKey', key)
  await putSetting(page, 'ai.keyStorage', 'persistent')
  await putSetting(page, 'ai.transport', 'proxy')
  await putSetting(page, 'ai.maxCostPerRun', maxCost)
  await putSetting(page, 'ai.jsonMode', true)
}

export async function resolveDeckId(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('momo-reword')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    const settings = await new Promise((resolve) => {
      const req = db.transaction('settings', 'readonly').objectStore('settings').getAll()
      req.onsuccess = () => resolve(req.result)
    })
    const selected = settings.find((row) => row.key === 'data.selectedDeckId')?.value
    if (typeof selected === 'string' && selected) return selected
    const decks = await new Promise((resolve) => {
      const req = db.transaction('decks', 'readonly').objectStore('decks').getAll()
      req.onsuccess = () => resolve(req.result)
    })
    return decks.find((d) => d.isDefault)?.id ?? decks[0]?.id ?? ''
  })
}

export async function listDrafts(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('momo-reword')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    const packs = await new Promise((resolve) => {
      const req = db.transaction('packs', 'readonly').objectStore('packs').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve([])
    })
    const out = []
    for (const pack of packs.filter((p) => p.draft)) {
      const items = await new Promise((resolve) => {
        const req = db.transaction('packItems', 'readonly').objectStore('packItems').getAll()
        req.onsuccess = () => resolve(req.result.filter((row) => row.packId === pack.id))
        req.onerror = () => resolve([])
      })
      out.push({ id: pack.id, name: pack.name, kind: pack.kind, status: pack.status, draft: pack.draft, done: items.length, items: items.map((i) => ({ status: i.status, headword: i.headword, meaningIndex: i.meaningIndex })) })
    }
    return out
  })
}

export async function listPacks(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('momo-reword')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    const packs = await new Promise((resolve) => {
      const req = db.transaction('packs', 'readonly').objectStore('packs').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve([])
    })
    return packs.map((p) => ({ id: p.id, name: p.name, kind: p.kind, status: p.status, source: p.source, draft: p.draft ?? null }))
  })
}

export async function wordSnapshot(page, headword) {
  return page.evaluate(async (hw) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('momo-reword')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    const words = await new Promise((resolve) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve([])
    })
    const word = words.find((w) => String(w.headword).toLowerCase() === String(hw).toLowerCase())
    if (!word) return null
    const items = await new Promise((resolve) => {
      const req = db.transaction('packItems', 'readonly').objectStore('packItems').getAll()
      req.onsuccess = () => resolve(req.result.filter((row) => row.wordId === word.id))
      req.onerror = () => resolve([])
    })
    const states = await new Promise((resolve) => {
      const req = db.transaction('states', 'readonly').objectStore('states').get(word.id)
      req.onsuccess = () => resolve(req.result ?? null)
      req.onerror = () => resolve(null)
    })
    return {
      id: word.id,
      headword: word.headword,
      meanings: (word.meanings ?? []).map((m) => ({ id: m.meaningId, pos: m.pos, cn: m.cn, examples: m.examples?.length ?? 0 })),
      coreSenses: word.coreSenses ?? null,
      meaningMap: word.meaningMap ?? null,
      examples: (word.examples ?? []).map((e) => ({ en: e.en, cn: e.cn, meaningId: e.meaningId })),
      phrases: (word.phrases ?? []).map((e) => ({ en: e.en, cn: e.cn, meaningId: e.meaningId })),
      mnemonics: (word.mnemonics ?? []).map((m) => ({ type: m.type, text: m.text })),
      appliedItems: items.filter((i) => i.status === 'applied').map((i) => ({ kind: i.payload?.coreSenses ? 'semantics' : i.payload?.examples ? 'examples' : i.payload?.phrases ? 'phrases' : 'mnemonics', packId: i.packId, meaningIndex: i.meaningIndex, payload: i.payload })),
      state: states ? { dueAt: states.dueAt, reps: states.reps, phase: states.phase, lastRating: states.lastRating, updatedAt: states.updatedAt } : null,
    }
  }, headword)
}

// ---------- app helpers ----------
export async function waitSeededHome(page, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const ready = await page.evaluate(async () => {
      const text = document.body.innerText
      const hasKpi = document.querySelectorAll('.mm-kpi').length >= 3
      if (!(hasKpi && /开始学习|继续学习|查看今日/.test(text) && /待复习/.test(text) && /待新学/.test(text))) return false
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const counts = await Promise.all(['decks', 'words'].map((store) => new Promise((resolve) => {
          const req = db.transaction(store, 'readonly').objectStore(store).count()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(0)
        })))
        return counts[0] >= 1 && counts[1] >= 1
      } catch { return false }
    })
    if (ready) return true
    await sleep(250)
  }
  throw new Error('等待种子首页超时')
}

export async function waitDefaultPacksSeeded(page, timeout = 120_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const ok = await page.evaluate(async () => {
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const row = await new Promise((resolve) => {
          const req = db.transaction('meta', 'readonly').objectStore('meta').get('packs.defaultSeeded')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(null)
        })
        return Boolean(row?.value?.version)
      } catch { return false }
    }).catch(() => false)
    if (ok) return true
    await sleep(250)
  }
  return false
}

export async function clickHomeLearn(page) {
  await waitDefaultPacksSeeded(page)
  const btn = page.getByRole('button', { name: /开始学习|继续学习/ }).first()
  await btn.waitFor({ state: 'visible', timeout: 20_000 })
  await btn.click()
  await page.waitForURL(/\/study/, { timeout: 15_000 })
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
}

export async function enterAnnotation(page) {
  await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height * 0.45))
  await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 20_000 })
}

export async function boardWord(page) {
  return (await page.locator('.word-text').first().innerText()).trim()
}

/** 计划只包含指定词（n 为重复次数；headword/maxMeanings 二选一） */
export async function injectPlanForWord(page, count, options = {}) {
  const deckId = await resolveDeckId(page)
  return page.evaluate(async ({ n, deck, options }) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open('momo-reword')
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    const words = (await new Promise((resolve) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll()
      req.onsuccess = () => resolve(req.result)
    })).filter((w) => w.deckId === deck)
    const withMeanings = words.filter((w) => Array.isArray(w.meanings) && w.meanings.length > 0)
    let target = null
    if (options.headword) target = withMeanings.find((w) => String(w.headword).toLowerCase() === String(options.headword).toLowerCase()) ?? null
    else if (options.maxMeanings) target = withMeanings.reduce((best, w) => (!best || w.meanings.length > best.meanings.length ? w : best), null)
    else target = withMeanings[0] ?? null
    if (!target) throw new Error(`词库 ${deck} 找不到符合条件单词 ${JSON.stringify(options)}`)
    const now = Date.now()
    const d = new Date(now)
    const pad = (x) => String(x).padStart(2, '0')
    const dateKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const planId = `${dateKey}:${deck}`
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['states', 'reviewLogs', 'meta'], 'readwrite')
      tx.objectStore('states').delete(target.id)
      tx.objectStore('meta').delete(`session:${target.id}`)
      const logs = tx.objectStore('reviewLogs').getAll()
      logs.onsuccess = () => { for (const log of logs.result) if (log.wordId === target.id) tx.objectStore('reviewLogs').delete(log.id) }
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    const plan = {
      id: planId, date: dateKey, deckId: deck, wordIds: Array(n).fill(target.id), index: 0,
      sources: { [target.id]: 'goal' },
      goals: { dailyGoal: n, dueCount: 0, newBudget: n, extraCount: 0 },
      ratings: [], createdAt: now, updatedAt: now, completedAt: null,
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['plans', 'meta'], 'readwrite')
      tx.objectStore('plans').put(plan)
      tx.objectStore('meta').put({ key: 'plan.activeId', value: planId, updatedAt: now })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return { wordId: target.id, headword: target.headword, meaningCount: target.meanings.length, meanings: target.meanings.map((m) => ({ id: m.meaningId, cn: m.cn, pos: m.pos })) }
  }, { n: count, deck: deckId, options })
}

export async function openAiPanel(page) {
  await page.locator('.study-topbar [aria-label="更多"]').first().click()
  await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).first().click()
  const gen = page.locator('.mm-dialog[aria-label="AI 扩充内容"]')
  await gen.waitFor({ state: 'visible', timeout: 15_000 })
  return gen
}

export async function closeDialogs(page) {
  for (let i = 0; i < 5; i += 1) {
    if ((await page.locator('.mm-mask').count()) === 0) return
    const dlg = page.locator('.mm-dialog').last()
    const btn = dlg.getByRole('button', { name: /^关闭$|^取消$|^取消生成$/ }).last()
    if ((await btn.count()) > 0) await btn.click().catch(() => {})
    else await page.keyboard.press('Escape').catch(() => {})
    await sleep(300)
  }
}

// ---------- mock provider ----------
export function makeMockState() {
  return { calls: 0, mode: 'ok', delayMs: 0, log: [], hangRoutes: [], partial: null, semanticsLabels: null, resolveHang: null }
}

/** 拦截代理路径；mode: ok/401/402/429/408/network/hang/partial */
export async function installMock(page, state) {
  await page.route('**/v1/chat/completions', async (route) => {
    state.calls += 1
    if (state.hangRoutes) state.hangRoutes.push(route)
    if (state.delayMs > 0) await sleep(state.delayMs)
    const req = route.request()
    let body = {}
    try { body = req.postDataJSON() ?? {} } catch { body = {} }
    const user = String((body?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '')
    if (state.mode === 'network') return route.abort('failed')
    if (state.mode === 'hang') {
      state.log.push({ kind: 'hang', user: user.slice(0, 60) })
      if (state.resolveHang) await new Promise((resolve) => { state.hangResolve = resolve })
      return
    }
    const status = { 401: 401, 402: 402, 429: 429, 408: 408 }[state.mode]
    if (status) {
      state.log.push({ kind: 'error', status })
      return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: state.mode === '401' ? 'invalid api key' : state.mode === '402' ? 'insufficient balance' : state.mode === '429' ? 'rate limit' : 'timeout' } }) })
    }
    const content = user.includes('只用于连通性测试') ? 'ok' : buildMockContent(user, state)
    if (content == null) {
      state.log.push({ kind: 'unparsed', user: user.slice(0, 120) })
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) })
  })
}

export function buildMockContent(user, state) {
  let kind = null
  let targets = null
  const km = /kind = (examples|phrases|mnemonics)/.exec(user)
  if (km) {
    kind = km[1]
    const start = user.indexOf('targets = ')
    const end = user.indexOf('\n请只输出', start)
    if (start < 0) return null
    try { targets = JSON.parse(user.slice(start + 10, end > start ? end : undefined)) } catch { return null }
  } else {
    const start = user.indexOf('targets = ')
    if (start < 0) return null
    let end = user.indexOf('\n请先通读', start)
    if (end < 0) end = user.indexOf('\n', start)
    try { targets = JSON.parse(user.slice(start + 10, end > start ? end : undefined)) } catch { return null }
    kind = 'semantics'
  }
  if (!Array.isArray(targets)) return null
  const items = []
  let idx = 0
  for (const t of targets) {
    idx += 1
    if (state.partial && idx === state.partial.skipIndex) continue
    if (kind === 'semantics') {
      const meanings = Array.isArray(t.meanings) ? t.meanings : []
      const labels = state.semanticsLabels ?? ['核心义', '引申义']
      const coreSenses = [
        { index: 1, label: labels[0], gloss: '核心含义说明', confidence: 'high' },
        { index: 2, label: labels[1], gloss: '引申含义说明', confidence: 'medium' },
      ]
      const meaningMap = meanings.map((m, i) => ({ meaningIndex: m.meaningIndex ?? i + 1, coreSenseIndex: i % 2 === 0 ? 1 : 2, steps: [labels[0], `使用场景${i + 1}`] }))
      items.push({ headword: t.headword, coreSenses, meaningMap })
    } else if (kind === 'examples') {
      const en = state.longText ? `${'QAlong '.repeat(30)}${idx} for ${t.headword}` : `QA mock example ${idx} for ${t.headword}`
      const item = { headword: t.headword, examples: [{ en, cn: `QA 例句翻译 ${idx}` }] }
      if (t.meaningIndex != null) item.meaningIndex = t.meaningIndex
      items.push(item)
    } else if (kind === 'phrases') {
      const item = { headword: t.headword, phrases: [{ en: `${t.headword} up`, cn: `QA 词组翻译 ${idx}` }] }
      if (t.meaningIndex != null) item.meaningIndex = t.meaningIndex
      items.push(item)
    } else {
      const item = { headword: t.headword, mnemonics: [{ type: 'assoc', text: `QA 助记：联想法 ${idx}` }] }
      if (t.meaningIndex != null) item.meaningIndex = t.meaningIndex
      items.push(item)
    }
  }
  state.log.push({ kind, targetCount: targets.length, itemCount: items.length })
  return JSON.stringify({ items })
}

// ---------- unified router: mock or real upstream ----------
/** state.mode: real | ok | 401 | 402 | 429 | 408 | network | hang | partial */
export async function installRouter(page, state) {
  state.realCalls = state.realCalls || 0
  state.realUsage = state.realUsage || { prompt: 0, completion: 0 }
  state.realStatuses = state.realStatuses || []
  await page.route('**/v1/chat/completions', async (route) => {
    state.calls += 1
    const req = route.request()
    let body = {}
    try { body = req.postDataJSON() ?? {} } catch { body = {} }
    const user = String((body?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? '')
    if (state.mode === 'real') {
      try {
        const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: req.headers()['authorization'] || '' },
          body: req.postData() || '',
        })
        const text = await res.text()
        state.realCalls += 1
        state.realStatuses.push(res.status)
        try {
          const j = JSON.parse(text)
          const u = j.usage ?? {}
          state.realUsage.prompt += Number(u.prompt_tokens ?? 0)
          state.realUsage.completion += Number(u.completion_tokens ?? 0)
          state.realUsage.total = (state.realUsage.total ?? 0) + Number(u.total_tokens ?? 0)
        } catch { /* ignore */ }
        state.log.push({ kind: 'real', status: res.status, user: user.slice(0, 40), contentLen: text.length })
        return route.fulfill({ status: res.status, contentType: res.headers.get('content-type') || 'application/json', headers: { 'access-control-allow-origin': '*' }, body: text })
      } catch (e) {
        state.log.push({ kind: 'real-error', error: String(e).slice(0, 120) })
        return route.fulfill({ status: 502, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'QA upstream fetch failed' } }) })
      }
    }
    if (state.delayMs > 0) await sleep(state.delayMs)
    if (state.mode === 'network') {
      state.log.push({ kind: 'network' })
      return route.abort('failed')
    }
    if (state.mode === 'hang') {
      state.log.push({ kind: 'hang' })
      await new Promise((resolve) => { state.releaseHang = resolve })
      return route.fulfill({ status: 504, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: 'released' } }) }).catch(() => {})
    }
    const status = { 401: 401, 402: 402, 429: 429, 408: 408 }[state.mode]
    if (status) {
      state.log.push({ kind: 'error', status })
      return route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ error: { message: status === 401 ? 'invalid api key' : status === 402 ? 'insufficient balance' : status === 429 ? 'rate limit' : 'timeout' } }) })
    }
    const content = user.includes('只用于连通性测试') ? 'ok' : buildMockContent(user, state)
    if (content == null) {
      state.log.push({ kind: 'unparsed', user: user.slice(0, 160) })
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) })
    }
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) })
  })
}

/** 跳过首次启动 20MB 内置内容包 seed（它在本机要数分钟），得到确定性空内容环境。
 *  只保留内置词库/单词；packs/packItems/contentRejects 清空。 */
export async function prepareClean(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitSeededHome(page)
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const q = indexedDB.open('momo-reword')
      q.onsuccess = () => resolve(q.result)
      q.onerror = () => reject(q.error)
    })
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['meta', 'packs', 'packItems', 'contentRejects'], 'readwrite')
      tx.objectStore('meta').put({ key: 'packs.defaultSeeded', value: { version: 6 }, updatedAt: Date.now() })
      tx.objectStore('packs').clear()
      tx.objectStore('packItems').clear()
      tx.objectStore('contentRejects').clear()
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitSeededHome(page)
  return true
}

export async function prepareWord(page, options = {}) {
  const injected = await injectPlanForWord(page, 1, options)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitSeededHome(page)
  await clickHomeLearn(page)
  await enterAnnotation(page)
  return injected
}

export async function panelText(page) {
  return (await page.locator('.mm-dialog[aria-label="AI 扩充内容"]').innerText()).replace(/\s+/g, ' ')
}

export async function panelTarget(page) {
  const text = await panelText(page)
  return Number(text.match(/目标：(\d+)/)?.[1] ?? -1)
}

export async function waitPanelTarget(page, expected, timeout = 8000) {
  const deadline = Date.now() + timeout
  let got = -2
  while (Date.now() < deadline) {
    got = await panelTarget(page).catch(() => -2)
    if (got === expected) return got
    await sleep(200)
  }
  return got
}
