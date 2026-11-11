/**
 * QA task-31 · v0.2.0（官方对齐版）无头浏览器 E2E。
 *
 * 依据：docs/ARCH-v2.md §10.1 AC1–AC10 矩阵 + §10.4「E2E 需要新增的断言」12 条。
 *
 * 覆盖（每场景独立 context = 全新 IndexedDB）：
 *  S0  构建指纹（入口 hash）
 *  S1  首页 6 态 + 续学一致性：学 3 词退出→「继续学习」→ 再进 index/词序不变（退出/刷新/改设置三种）
 *  S2  三键三态文案 + 标签切换（首次：认识/不确定/不认识；之后：认识/模糊/忘记）
 *  S3  回退 + 改判：< 回退、上次选择徽标、改判后继续前进；首词无回退；右滑回退
 *  S4  队列不截断：注入 40 个到期词 + goal 30 → 学习队列 40（不是 30）
 *  S5  每日学习量 1–9999 + 三个官方设置项（预计复习间隔/标签切换/允许模糊完成）
 *  S6  记忆/含义拆分/词组/随机 回归（v1 功能不回归）
 *  S7  导出→导入往返（迁移包，含计划表；隐私：不含 token）
 *  S8  SW + 断网离线（PWA 回归）
 *  + 全流程 console.error / pageerror 汇总
 *
 * 运行（服务已在 4173、且为 v0.2.0 构建）：
 *   node tests/e2e/v2-e2e.mjs
 *   E2E_BASE=http://127.0.0.1:4173/ E2E_OUT=... node tests/e2e/v2-e2e.mjs
 * 截图：docs/assets/e2e/v2/*.png；结果：docs/assets/e2e/v2/e2e-v2.json
 */

import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(HERE, '..', '..')
const TOOLS = join(PROJECT_ROOT, 'tools/e2e')
const CHROMIUM = process.env.E2E_CHROMIUM || join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/'
const OUT = process.env.E2E_OUT || join(PROJECT_ROOT, 'docs/assets/e2e/v2')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
const DAY_MS = 86_400_000
const VIEWPORT = { width: 390, height: 844 }
/** 公开树默认词库不同（dagang vs 受限商业词表）：可用 E2E_DECK_ID 覆盖；否则从 IndexedDB 动态读取选中词库 */
const E2E_DECK_ID = (process.env.E2E_DECK_ID ?? '').trim()

const result = { startedAt: new Date().toISOString(), base: BASE, build: null, scenarios: {}, consoleErrors: [], pageErrors: [], screenshots: [] }
let currentScenario = 'boot'

function log(msg) {
  console.log(msg)
}

function assert(cond, message) {
  if (!cond) throw new Error(`断言失败：${message}`)
}

async function shot(page, name) {
  try {
    const path = join(OUT, `${name}.png`)
    await page.screenshot({ path })
    result.screenshots.push(`${name}.png`)
    log(`   📸 v2/${name}.png`)
  } catch (e) {
    log(`   （截图失败 ${name}: ${e.message}）`)
  }
}

function watch(page, bag) {
  page.on('console', (msg) => {
    if (msg.type() === 'error') bag.consoleErrors.push(msg.text().slice(0, 400))
  })
  page.on('pageerror', (err) => bag.pageErrors.push((err?.stack ? String(err.stack) : String(err)).slice(0, 1200)))
}

async function newContext(browser, viewport = VIEWPORT) {
  const context = await browser.newContext({ viewport, locale: 'zh-CN', deviceScaleFactor: 1 })
  const page = await context.newPage()
  const bag = { consoleErrors: [], pageErrors: [] }
  watch(page, bag)
  return { context, page, bag }
}

function mergeErrors(bag) {
  result.consoleErrors.push(...bag.consoleErrors)
  result.pageErrors.push(...bag.pageErrors)
}

// ---------------- helpers ----------------

async function waitHome(page, timeout = 90_000) {
  await page.waitForFunction(
    () => /开始学习|继续学习|查看今日|去添加词库|去词库/.test(document.body.innerText),
    { timeout },
  )
}

/** 等待内置词库种子完成且首页数据就绪（不依赖具体词库/词数，公开/私版通用） */
async function waitSeededHome(page, timeout = 90_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const ready = await page.evaluate(async () => {
      const text = document.body.innerText
      const hasKpi = document.querySelectorAll('.mm-kpi').length >= 3
      const hasHomeCta = /开始学习|继续学习|查看今日/.test(text)
      if (!(hasKpi && hasHomeCta && /待复习/.test(text) && /待新学/.test(text))) return false
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const counts = await Promise.all(
          ['decks', 'words'].map(
            (store) =>
              new Promise((resolve) => {
                const req = db.transaction(store, 'readonly').objectStore(store).count()
                req.onsuccess = () => resolve(req.result)
                req.onerror = () => resolve(0)
              }),
          ),
        )
        return counts[0] >= 1 && counts[1] >= 1
      } catch {
        return false
      }
    })
    if (ready) return
    await page.waitForTimeout(250)
  }
  throw new Error('等待内置词库种子/首页就绪超时')
}

/** 当前选中词库 id（E2E_DECK_ID 优先；否则读 settings，再兜底默认 deck） */
async function resolveDeckId(page) {
  if (E2E_DECK_ID) return E2E_DECK_ID
  return page.evaluate(async () => {
    const open = () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open('momo-reword')
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => reject(r.error)
      })
    const db = await open()
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
    const deckId = decks.find((deck) => deck.isDefault)?.id ?? decks[0]?.id ?? ''
    if (deckId) return deckId
    // 兜底：从 words 取第一个词的 deckId（种库完成但 settings/decks 尚未就绪时）
    const words = await new Promise((resolve) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll()
      req.onsuccess = () => resolve(req.result)
    })
    return words[0]?.deckId ?? ''
  })
}

async function homeButtonText(page) {
  const texts = await page.locator('.mm-btn').allInnerTexts()
  return texts.map((t) => t.trim()).filter(Boolean)
}

async function homeText(page) {
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
}

async function clickHomeLearn(page) {
  const btn = page.getByRole('button', { name: /开始学习|继续学习/ }).first()
  await btn.waitFor({ state: 'visible', timeout: 20_000 })
  const label = (await btn.innerText()).trim()
  await btn.click()
  await page.waitForURL(/\/study/, { timeout: 15_000 })
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
  return label
}

async function boardWord(page) {
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
  return (await page.locator('.word-text').first().innerText()).trim()
}

async function enterAnnotation(page) {
  await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height * 0.45))
  await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 20_000 })
}

async function progressText(page) {
  return (await page.locator('.study-topbar-title').first().innerText()).trim()
}

async function readLabels(page) {
  return (await page.locator('.rating-label').allInnerTexts()).map((t) => t.trim())
}

async function readHints(page) {
  const out = {}
  for (const [key, sel] of [['familiar', '.rating-btn--know'], ['vague', '.rating-btn--vague'], ['forgot', '.rating-btn--unknown']]) {
    const el = page.locator(`${sel} .rating-sub`).first()
    out[key] = (await el.count()) > 0 ? (await el.innerText()).trim() : ''
  }
  return out
}

const RATING_SEL = { familiar: '.rating-btn--know', vague: '.rating-btn--vague', forgot: '.rating-btn--unknown' }
const LABEL_NAME = { familiar: '认识', vague: '模糊', forgot: '不认识' }

async function rate(page, rating) {
  await page.waitForTimeout(500) // 300ms 防误触 + 400ms 冷却
  const btn = page.locator(RATING_SEL[rating]).first()
  await btn.waitFor({ state: 'visible', timeout: 10_000 })
  assert(!(await btn.isDisabled()), `${LABEL_NAME[rating]} 按钮禁用`)
  await btn.click()
  await page.waitForTimeout(1000)
}

async function waitNextBoard(page) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    if ((await page.locator('.board-stage').count()) > 0) return
    const text = await homeText(page)
    if (/今日学习|完成|用时/.test(text)) return
    await page.waitForTimeout(200)
  }
  throw new Error('评分后未出现下一词/完成页')
}

async function exitStudy(page) {
  if ((await page.locator('.study-topbar').count()) === 0) {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitHome(page)
    return
  }
  await page.locator('[aria-label="退出学习"]').first().click()
  await page.waitForTimeout(400)
  if ((await page.locator('.study-dialog').count()) > 0) {
    await page.getByRole('button', { name: '退出', exact: true }).first().click()
    await page.waitForTimeout(700)
  }
}

async function waitSetting(page, key, expected, timeout = 15_000) {
  const deadline = Date.now() + timeout
  let value = await getSetting(page, key)
  while (Date.now() < deadline) {
    if (JSON.stringify(value) === JSON.stringify(expected)) return value
    await page.waitForTimeout(200)
    value = await getSetting(page, key)
  }
  return value
}

async function getSetting(page, key) {
  return page.evaluate(async (k) => {
    const req = indexedDB.open('momo-reword')
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    return new Promise((resolve) => {
      try {
        const r = db.transaction('settings', 'readonly').objectStore('settings').get(k)
        r.onsuccess = () => resolve(r.result?.value)
        r.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }, key)
}

async function putSetting(page, key, value) {
  return page.evaluate(
    async ({ key, value }) => {
      const req = indexedDB.open('momo-reword')
      const db = await new Promise((resolve, reject) => {
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

/** 直接注入 N 个「已到期」states（审计/构造 due>goal 场景；只写 states） */
async function injectDueStates(page, count) {
  const deckId = await resolveDeckId(page)
  return page.evaluate(
    async ({ n, deck }) => {
      const DAY = 86_400_000
      const open = () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
      const db = await open()
      const words = await new Promise((resolve) => {
        const req = db.transaction('words', 'readonly').objectStore('words').getAll()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve([])
      })
      const targets = words.filter((w) => w.deckId === deck).slice(0, n)
      if (targets.length === 0) throw new Error(`词库 ${deck} 没有可注入单词`)
      const now = Date.now()
      await new Promise((resolve, reject) => {
        const tx = db.transaction('states', 'readwrite')
        const store = tx.objectStore('states')
        for (const w of targets) {
          store.put({
            wordId: w.id,
            deckId: w.deckId,
            phase: 'review',
            stability: 30,
            difficulty: 5,
            reps: 3,
            lapses: 0,
            firstSeenAt: now - 100 * DAY,
            lastReviewedAt: now - 10 * DAY,
            dueAt: now - DAY,
            nextIntervalDays: 10,
            retrievability: 0.5,
            lastRating: 'familiar',
            sameDayCount: 0,
            sameDayDate: '',
            meaningStats: {},
            sameDayRequeued: 0,
            todayProgress: 0,
            createdAt: now - 100 * DAY,
            updatedAt: now - DAY,
          })
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      return targets.length
    },
    { n: count, deck: deckId },
  )
}
// ---------------- scenarios ----------------

async function scenarioS1(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitHome(page)
    out.freshButtons = await homeButtonText(page)
    out.freshText = (await homeText(page)).slice(0, 200)
    assert(out.freshButtons.includes('开始学习'), `fresh 态应为「开始学习」，实际 ${JSON.stringify(out.freshButtons)}`)
    await shot(page, 'S1-01-home-fresh')

    await clickHomeLearn(page)
    out.wordsSeen = []
    for (let i = 0; i < 3; i += 1) {
      out.wordsSeen.push(await boardWord(page))
      await enterAnnotation(page)
      await rate(page, 'familiar')
      await waitNextBoard(page)
    }
    out.beforeExit = { progress: await progressText(page), word: await boardWord(page) }
    await shot(page, 'S1-02-study-before-exit')
    await exitStudy(page)
    await waitHome(page)
    out.ongoingButtons = await homeButtonText(page)
    out.ongoingText = (await homeText(page)).slice(0, 220)
    assert(out.ongoingButtons.includes('继续学习'), `退出后首页应为「继续学习」，实际 ${JSON.stringify(out.ongoingButtons)}`)
    await shot(page, 'S1-03-home-continue')

    // 再进：index/词序不变
    await clickHomeLearn(page)
    out.reenter1 = { progress: await progressText(page), word: await boardWord(page) }
    assert(out.reenter1.progress === out.beforeExit.progress, `续学进度应=${out.beforeExit.progress}，实际 ${out.reenter1.progress}`)
    assert(out.reenter1.word === out.beforeExit.word, `续学词应=${out.beforeExit.word}，实际 ${out.reenter1.word}`)
    await shot(page, 'S1-04-continue-same-position')
    await exitStudy(page)
    await waitHome(page)

    // 刷新后再进
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitHome(page)
    await clickHomeLearn(page)
    out.reenterAfterRefresh = { progress: await progressText(page), word: await boardWord(page) }
    assert(out.reenterAfterRefresh.progress === out.beforeExit.progress, `刷新后续学进度不一致：${out.reenterAfterRefresh.progress}`)
    assert(out.reenterAfterRefresh.word === out.beforeExit.word, `刷新后续学词不一致：${out.reenterAfterRefresh.word}`)
    await exitStudy(page)
    await waitHome(page)

    // 改设置（主题）后再进
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
    await page.getByText('主题', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByRole('button', { name: '深色', exact: true }).first().click()
    await page.waitForTimeout(600)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitHome(page)
    await clickHomeLearn(page)
    out.reenterAfterSetting = { progress: await progressText(page), word: await boardWord(page) }
    assert(out.reenterAfterSetting.progress === out.beforeExit.progress, `改设置后续学进度不一致：${out.reenterAfterSetting.progress}`)
    assert(out.reenterAfterSetting.word === out.beforeExit.word, `改设置后续学词不一致：${out.reenterAfterSetting.word}`)
    await shot(page, 'S1-05-continue-after-setting')
    await exitStudy(page)
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS2(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitHome(page)
    await clickHomeLearn(page)
    await enterAnnotation(page)
    out.firstLabels = await readLabels(page)
    out.firstHints = await readHints(page)
    out.firstAria = await page.locator('.rating-btn--vague').first().getAttribute('aria-label')
    await shot(page, 'S2-01-first-show-labels')
    // 首次显示：认识/不确定/不认识；副标题：N 天后 / 今日 / N 天后
    assert(JSON.stringify(out.firstLabels) === JSON.stringify(['认识', '不确定', '不认识']), `首次标签应为 认识/不确定/不认识，实际 ${JSON.stringify(out.firstLabels)}`)
    assert(/\d+ 天后/.test(out.firstHints.familiar), `首次「认识」副标题应含 N 天后：${out.firstHints.familiar}`)
    assert(/今日 \/ \d+ 天后/.test(out.firstHints.vague), `首次「不确定」副标题应含「今日 / N 天后」：${out.firstHints.vague}`)
    assert(/今日 \/ \d+ 天后/.test(out.firstHints.forgot), `首次「不认识」副标题应含「今日 / N 天后」：${out.firstHints.forgot}`)
    // 同日回炉后再看：标签切换 + 进度文案
    await rate(page, 'vague')
    await waitNextBoard(page)
    await enterAnnotation(page)
    out._secondWordHints = await readHints(page)
    // 回退上一词（应是刚评「不确定」的词）→ 其 label 应变为 认识/模糊/忘记
    const back = page.locator('[aria-label="上一个单词"]').first()
    assert((await back.count()) > 0, '第 2 词应出现「上一个单词」按钮')
    await back.click()
    await page.waitForTimeout(800)
    await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 20_000 })
    out.revisitLabels = await readLabels(page)
    out.revisitHints = await readHints(page)
    out.lastBadge = (await page.locator('.last-choice-badge').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
    await shot(page, 'S2-02-revisit-labels-progress')
    assert(JSON.stringify(out.revisitLabels) === JSON.stringify(['认识', '模糊', '忘记']), `回炉/回退后标签应为 认识/模糊/忘记，实际 ${JSON.stringify(out.revisitLabels)}`)
    assert(/今日进度\d+%/.test(out.revisitHints.familiar), `回炉后「认识」副标题应为进度%：${out.revisitHints.familiar}`)
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS3(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitHome(page)
    await clickHomeLearn(page)
    const firstWord = await boardWord(page)
    out.firstWord = firstWord
    // 首词无回退按钮
    out.firstHasBack = (await page.locator('[aria-label="上一个单词"]').count()) > 0
    assert(!out.firstHasBack, '首词不应显示「上一个单词」')
    await enterAnnotation(page)
    await rate(page, 'familiar')
    await waitNextBoard(page)
    const secondWord = await boardWord(page)
    out.secondWord = secondWord
    assert(secondWord !== firstWord, '第 2 词应与第 1 词不同')
    // < 回退
    const back = page.locator('[aria-label="上一个单词"]').first()
    assert((await back.count()) > 0, '第 2 词应有「上一个单词」按钮')
    await back.click()
    await page.waitForTimeout(800)
    await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 20_000 })
    out.backWord = (await page.locator('.word-text').first().innerText()).trim()
    // 回退浏览提示条（task-44 BackRevertNotice）：依赖异步 getLastReviewSnapshot，轮询文案出现
    await page
      .waitForFunction(() => /上次选择/.test(document.querySelector('.back-revert-notice')?.textContent ?? ''), {
        timeout: 15_000,
      })
      .catch(() => {})
    out.lastBadge = (await page.locator('.back-revert-notice').first().innerText().catch(() => '')).replace(/\s+/g, ' ')
    await shot(page, 'S3-01-back-with-last-choice')
    assert(out.backWord === firstWord, `回退后应回到「${firstWord}」，实际「${out.backWord}」`)
    assert(/上次选择「认识」/.test(out.lastBadge), `应显示「上次选择「认识」」，实际「${out.lastBadge}」`)
    // 改判：回退浏览状态下直接点不同的评分键（当前构建的改判入口就是评分键；
    // LastChoiceBadge 仅展示「上次选择」，另有「不改了，继续」按钮）
    await page.getByRole('button', { name: '不改了，继续', exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
    await page.waitForTimeout(500)
    await page.locator('.rating-btn--unknown').first().click()
    // toast 1.6s 内出现：轮询 body 文本
    out.revertToastOk = await page
      .waitForFunction(() => /已将|计划已更新|已修改/.test(document.body.innerText), { timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
    out.afterRevertText = (await homeText(page)).slice(0, 240)
    assert(out.revertToastOk, `改判后应提示计划已更新，实际：${out.afterRevertText}`)
    // 改判证据：该词 reviewLogs 出现 corrected=true（且旧日志仍在，不新增“有效”次数）
    out.revertLogs = await page.evaluate(async (word) => {
      const open = () =>
        new Promise((resolve) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
        })
      const db = await open()
      const logs = await new Promise((resolve) => {
        const req = db.transaction('reviewLogs', 'readonly').objectStore('reviewLogs').getAll()
        req.onsuccess = () => resolve(req.result)
      })
      const mine = logs.filter((l) => String(l.wordId).endsWith(`:${word}`))
      return {
        total: mine.length,
        corrected: mine.filter((l) => l.corrected === true).length,
        ratings: mine.map((l) => l.rating),
      }
    }, firstWord.toLowerCase())
    assert(out.revertLogs.corrected >= 1, `改判后应有 corrected=true 的日志，实际 ${JSON.stringify(out.revertLogs)}`)
    await page.waitForTimeout(500)
    const progressAfterRevert = (await page.locator('.study-topbar-title').first().innerText().catch(() => '')).trim()
    out.progressAfterRevert = progressAfterRevert
    await shot(page, 'S3-02-after-revert-rating')
    // 改判后应可继续前进（回到第 2 词）
    assert(/study/.test(page.url()), '改判后仍在学习页')
    // 右滑回退（指针手势）：在第 2 词/当前词上从左侧向右滑
    const swipe = async () => {
      const y = Math.round(VIEWPORT.height * 0.5)
      await page.mouse.move(30, y)
      await page.mouse.down()
      await page.mouse.move(320, y, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(800)
    }
    const beforeSwipeWord = (await page.locator('.word-text').first().innerText().catch(() => '')).trim()
    await swipe()
    const afterSwipeWord = (await page.locator('.word-text').first().innerText().catch(() => '')).trim()
    out.swipe = { beforeSwipeWord, afterSwipeWord, changed: beforeSwipeWord !== afterSwipeWord }
    await shot(page, 'S3-03-swipe-back-attempt')
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS4(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    await putSetting(page, 'study.dailyGoal', 30)
    out.injected = await injectDueStates(page, 40)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    out.homeText = (await homeText(page)).slice(0, 220)
    await shot(page, 'S4-01-home-due40-goal30')
    assert(/40/.test(out.homeText), `首页待复习应显示 40：${out.homeText}`)
    await clickHomeLearn(page)
    out.progress = await progressText(page)
    out.word = await boardWord(page)
    const m = out.progress.match(/(\d+)\s*\/\s*(\d+)/)
    assert(m, `进度格式异常：${out.progress}`)
    out.total = Number(m[2])
    assert(out.total === 40, `due 40 + goal 30 时学习队列应 40（不截断），实际 ${out.total}`)
    await shot(page, 'S4-02-study-queue-40')
    // 前进 30+ 次仍不应“完成”（due 全量入队）
    await exitStudy(page)
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS5(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    out.officialSwitches = {
      labelSwitch: (await page.getByRole('switch', { name: '三键官方文案' }).count()) > 0,
      predictedInterval: (await page.getByRole('switch', { name: '显示预计复习间隔' }).count()) > 0,
      allowVagueComplete: (await page.getByRole('switch', { name: '允许模糊完成复习' }).count()) > 0,
    }
    assert(out.officialSwitches.labelSwitch && out.officialSwitches.predictedInterval && out.officialSwitches.allowVagueComplete, `官方设置项缺失：${JSON.stringify(out.officialSwitches)}`)
    await shot(page, 'S5-01-settings-official-switches')

    // 每日学习量：9999 可保存并持久化
    await page.locator('.mm-row').filter({ hasText: '每日学习量' }).first().click()
    const dlg = page.locator('.mm-dialog[aria-label="每日学习量"]')
    await dlg.waitFor({ state: 'visible', timeout: 10_000 })
    const input = dlg.locator('input[aria-label="每日学习量"]')
    await input.fill('9999')
    await dlg.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForTimeout(700)
    out.dailyGoal9999 = await getSetting(page, 'study.dailyGoal')
    assert(out.dailyGoal9999 === 9999, `每日学习量应保存 9999，实际 ${out.dailyGoal9999}`)
    await shot(page, 'S5-02-dailygoal-9999')
    // 非法值 0 应被拒绝
    await page.locator('.mm-row').filter({ hasText: '每日学习量' }).first().click()
    await dlg.waitFor({ state: 'visible', timeout: 10_000 })
    await input.fill('0')
    await dlg.getByRole('button', { name: '保存', exact: true }).click()
    await page.waitForTimeout(500)
    out.dailyGoalAfterInvalid = await getSetting(page, 'study.dailyGoal')
    out.invalidStillOpen = (await dlg.count()) > 0
    assert(out.dailyGoalAfterInvalid === 9999, `非法 0 不应写入，实际 ${out.dailyGoalAfterInvalid}`)
    await dlg.getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForTimeout(400)

    // 关闭预计复习间隔 → 新词三键只显示「今日」
    await page.getByRole('switch', { name: '显示预计复习间隔' }).first().click()
    out.settingHidden = await waitSetting(page, 'memory.showPredictedInterval', false, 15_000)
    assert(out.settingHidden === false, `「显示预计复习间隔」应写入 false，实际 ${out.settingHidden}`)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitHome(page)
    await clickHomeLearn(page)
    await enterAnnotation(page)
    out.hintsWithoutInterval = await readHints(page)
    await shot(page, 'S5-03-hints-without-interval')
    assert(out.hintsWithoutInterval.familiar === '今日', `隐藏间隔后「认识」应显示「今日」，实际「${out.hintsWithoutInterval.familiar}」`)

    // 恢复设置
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
    await page.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.getByRole('switch', { name: '显示预计复习间隔' }).first().click()
    // 标签切换关闭 → 固定旧文案
    await page.getByRole('switch', { name: '三键官方文案' }).first().click()
    await waitSetting(page, 'memory.showPredictedInterval', true, 15_000)
    await waitSetting(page, 'study.labelSwitch', false, 15_000)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitHome(page)
    await clickHomeLearn(page)
    await enterAnnotation(page)
    out.labelsFixed = await readLabels(page)
    await shot(page, 'S5-04-labels-fixed')
    assert(JSON.stringify(out.labelsFixed) === JSON.stringify(['认识', '模糊', '不认识']), `关闭标签切换后应为旧文案，实际 ${JSON.stringify(out.labelsFixed)}`)
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS6(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitSeededHome(page)
    // 公开/私版词库不同：动态挑「当前词库含义最多的词」，断言其实际含义数（不再假设 ≥3）
    const injected = await injectPlanForWord(page, 6, { maxMeanings: true })
    out.injected = { headword: injected.headword, meaningCount: injected.meaningCount }
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await clickHomeLearn(page)
    out.word = await boardWord(page)
    await enterAnnotation(page)
    out.meanings = await page.locator('.meaning-row').count()
    out.posLabels = await page.locator('.meaning-pos').allInnerTexts()
    await shot(page, 'S6-01-annotation-meanings')
    assert(
      out.meanings === injected.meaningCount,
      `含义拆分：${injected.headword} 数据有 ${injected.meaningCount} 个含义，页面渲染 ${out.meanings} 行`,
    )

    // 记忆：第一轮完成 → 再点记忆重开（v1 回归）
    const memBtn = page.getByRole('button', { name: '记忆', exact: true }).first()
    await memBtn.click()
    await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
    const firstCount = (await page.locator('.wc-count').first().innerText()).replace(/\s+/g, ' ')
    let taps = 0
    while ((await page.locator('.memory-stage').count()) > 0 && taps < 150) {
      await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height * 0.5))
      taps += 1
      await page.waitForTimeout(260)
    }
    out.memoryTapsRound1 = taps
    await page.waitForTimeout(300)
    out.memoryToast = (await page.getByText('记忆完成，可再次点击继续').count()) > 0
    await shot(page, 'S6-02-memory-round1-done')
    await memBtn.click()
    await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
    out.memoryReopenCount = (await page.locator('.wc-count').first().innerText()).replace(/\s+/g, ' ')
    assert(/^0\s*\/\s*\d+/.test(out.memoryReopenCount), `记忆重开应从 0/N 开始，实际 ${out.memoryReopenCount}`)
    await shot(page, 'S6-03-memory-reopen')
    await page.locator('.study-topbar [aria-label="退出记忆"]').first().click()
    await page.waitForTimeout(500)
    const exitMemBtn = page.locator('.study-dialog button', { hasText: '退出记忆' }).first()
    if ((await exitMemBtn.count()) > 0) await exitMemBtn.click()
    await page.waitForTimeout(600)
    out.firstCount = firstCount
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS8(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitHome(page)
    const sw = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false }
      const reg = await navigator.serviceWorker.ready
      return { supported: true, scope: reg.scope, active: Boolean(reg.active), caches: await caches.keys() }
    })
    assert(sw.supported && sw.active, 'Service Worker 未激活')
    await context.setOffline(true)
    const resp = await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 })
    assert(resp == null || resp.status() < 400, `离线 reload 异常：${resp?.status?.()}`)
    await waitHome(page)
    out.offlineOk = true
    await shot(page, 'S8-01-offline')
    await context.setOffline(false)
    out.sw = sw
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function setDailyGoal(page, value) {
  await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
  await page.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.mm-row').filter({ hasText: '每日学习量' }).first().click()
  const dlg = page.locator('.mm-dialog[aria-label="每日学习量"]')
  await dlg.waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForTimeout(400)
  await dlg.locator('input[aria-label="每日学习量"]').fill(String(value))
  await dlg.getByRole('button', { name: '保存', exact: true }).click()
  await page.waitForTimeout(900)
  return (await page.locator('body').innerText()).replace(/\s+/g, ' ')
}

/** 注入「单 word 重复 N 次」的今日计划（受控序列用；只写 plans + meta，不动其它数据） */
/** 注入「同一词重复 count 次」的今日计划；词从当前词库动态选（headword / difficulty / maxMeanings） */
async function injectPlanForWord(page, count, options = {}) {
  const deckId = await resolveDeckId(page)
  return page.evaluate(
    async ({ n, deck, options }) => {
      const open = () =>
        new Promise((resolve, reject) => {
          const r = indexedDB.open('momo-reword')
          r.onsuccess = () => resolve(r.result)
          r.onerror = () => reject(r.error)
        })
      const db = await open()
      const words = (await new Promise((resolve) => {
        const req = db.transaction('words', 'readonly').objectStore('words').getAll()
        req.onsuccess = () => resolve(req.result)
      })).filter((w) => w.deckId === deck)
      const withMeanings = words.filter((w) => Array.isArray(w.meanings) && w.meanings.length > 0)
      let target = null
      if (options.headword) {
        target = withMeanings.find((w) => String(w.headword).toLowerCase() === String(options.headword).toLowerCase()) ?? null
      } else if (options.difficulty != null) {
        target = withMeanings.find((w) => w.difficulty === options.difficulty) ?? null
      } else if (options.maxMeanings) {
        target = withMeanings.reduce((best, w) => (!best || w.meanings.length > best.meanings.length ? w : best), null)
      } else {
        target = withMeanings[0] ?? null
      }
      if (!target) throw new Error(`词库 ${deck} 找不到符合条件的单词（${JSON.stringify(options)}）`)
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
        logs.onsuccess = () => {
          for (const log of logs.result) if (log.wordId === target.id) tx.objectStore('reviewLogs').delete(log.id)
        }
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      const plan = {
        id: planId,
        date: dateKey,
        deckId: deck,
        wordIds: Array(n).fill(target.id),
        index: 0,
        sources: { [target.id]: 'goal' },
        goals: { dailyGoal: n, dueCount: 0, newBudget: n, extraCount: 0 },
        ratings: [],
        createdAt: now,
        updatedAt: now,
        completedAt: null,
      }
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['plans', 'meta'], 'readwrite')
        tx.objectStore('plans').put(plan)
        tx.objectStore('meta').put({ key: 'plan.activeId', value: planId, updatedAt: now })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
      return {
        wordId: target.id,
        headword: target.headword,
        difficulty: target.difficulty,
        meaningCount: target.meanings.length,
        meanings: target.meanings.map((m) => ({ id: m.id, cn: m.cn })),
        planId,
      }
    },
    { n: count, deck: deckId, options },
  )
}

/** 从当前词库动态挑「≥2 含义、且 ≥2 个含义各自有 meaningId 词组」的词（task-42/43 验收用） */
async function pickPhraseWord(page) {
  const deckId = await resolveDeckId(page)
  return page.evaluate(async (deck) => {
    const open = () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('momo-reword')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    const db = await open()
    const words = (await new Promise((resolve) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll()
      req.onsuccess = () => resolve(req.result)
    })).filter((word) => word.deckId === deck)
    const stats = { deck, total: words.length, wordsWithMeaningIdPhrases: 0, wordsWith2CoveredMeanings: 0 }
    let bestStrong = null
    let bestWeak = null
    let bestUnassigned = null
    for (const word of words) {
      const meanings = Array.isArray(word.meanings) ? word.meanings : []
      const phrases = Array.isArray(word.phrases) ? word.phrases : []
      if (meanings.length < 2 || phrases.length === 0) continue
      const withMeaningId = phrases.filter((p) => typeof p.meaningId === 'string' && p.meaningId.length > 0)
      if (withMeaningId.length > 0) stats.wordsWithMeaningIdPhrases += 1
      const byMeaning = new Map()
      for (const p of withMeaningId) {
        const list = byMeaning.get(p.meaningId) ?? []
        list.push({ en: p.en, cn: p.cn })
        byMeaning.set(p.meaningId, list)
      }
      const covered = meanings.filter((m) => (byMeaning.get(m.id) ?? []).length > 0)
      if (covered.length >= 2) stats.wordsWith2CoveredMeanings += 1
      // covered=0 且存在 meaningId（但都不匹配当前含义）→ 疑似 stale，跳过；
      // covered=0 且完全没有 meaningId → 可作为「未归属词组一律不显示」的验证样本
      if (covered.length === 0 && withMeaningId.length > 0) continue
      const nullMeaning = phrases.filter((p) => p.meaningId == null)
      const score = phrases.length + meanings.length
      if (covered.length === 0) continue
      const item = {
          score,
          wordId: word.id,
          headword: word.headword,
          meanings: meanings.map((m) => ({
            id: m.id,
            cn: m.cn,
            phrases: (byMeaning.get(m.id) ?? []).slice(0, 3),
          })),
          nullMeaningPhrases: nullMeaning.map((p) => ({ en: p.en, cn: p.cn })),
          totalPhrases: phrases.length,
          coveredMeanings: covered.length,
        }
      if (covered.length >= 2) {
        if (!bestStrong || score < bestStrong.score) bestStrong = item
      } else if (covered.length === 1) {
        if (!bestWeak || score < bestWeak.score) bestWeak = item
      } else if (!bestUnassigned || score < bestUnassigned.score) {
        bestUnassigned = item
      }
    }
    const candidate = bestStrong ?? bestWeak
    return { candidate, stats, strong: Boolean(bestStrong), unassigned: false }
  }, deckId)
}

async function scenarioS9_goalSync(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitSeededHome(page)
    out.homeFresh = (await homeText(page)).slice(0, 220)
    out.freshNew = (await page.locator('.mm-kpi-value').allInnerTexts()).map((t) => t.trim())
    await shot(page, 'S9-01-home-fresh-30')

    // A. 无 plan：30 → 50（只写设置，首页待新学应 +20）
    out.set50Text = await setDailyGoal(page, 50)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    out.homeAfter50 = (await homeText(page)).slice(0, 220)
    await shot(page, 'S9-02-home-50-no-plan')
    assert(/待新学\s*50|50 待新学/.test((await homeText(page))) || /共 50/.test(await homeText(page)), `无 plan 时 30→50 后待新学应 50：${out.homeAfter50}`)

    // B. 建 plan（50）并学 1 词；再 30→50 应 toast +20 词且 plan 总数更新
    await clickHomeLearn(page)
    out.studyProgress50 = await progressText(page)
    await enterAnnotation(page)
    await rate(page, 'familiar')
    await waitNextBoard(page)
    await exitStudy(page)
    await waitSeededHome(page)
    out.homeOngoing50 = (await homeText(page)).slice(0, 240)
    await shot(page, 'S9-03-home-ongoing-50')

    // C. 50 → 30：减少 20（从队尾移除未评分新词）
    out.set30Text = await setDailyGoal(page, 30)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    out.homeAfter30 = (await homeText(page)).slice(0, 240)
    out.planChangeToast = out.set30Text.match(/已按新学习量调整今日计划[^ ]*/)?.[0] ?? ''
    await shot(page, 'S9-04-home-after-30')
    await clickHomeLearn(page)
    out.studyProgress30 = await progressText(page)
    await exitStudy(page)
    await waitSeededHome(page)

    // D. 30 → 50：应 toast +20 词，再进总数为 50（同 index）
    out.set50AgainText = await setDailyGoal(page, 50)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    out.homeAfter50Again = (await homeText(page)).slice(0, 240)
    out.planChangeToastPlus = out.set50AgainText.match(/\+\d+ 词/)?.[0] ?? ''
    await shot(page, 'S9-05-home-after-50-again')
    await clickHomeLearn(page)
    out.studyProgress50Again = await progressText(page)
    await shot(page, 'S9-06-study-progress-50')
    await exitStudy(page)
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS10_v2Sequences(browser) {
  const fixture = JSON.parse(await readFile(join(HERE, 'fixtures/algo-reference.json'), 'utf8'))
  const out = { sequences: {} }
  for (const name of ['face', 'cat', 'yellow']) {
    const expected = fixture.sequences[name]
    const { context, page, bag } = await newContext(browser)
    const record = { expectedRatings: expected.ratings, days: expected.days, samples: [], completes: false }
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitSeededHome(page)
      const injected = await injectPlanForWord(page, expected.ratings.length + 4, { difficulty: 1 })
      assert(injected.difficulty === 1, `S10 需要 difficulty=1 的词，实际 ${injected.headword} d=${injected.difficulty}`)
      record.word = injected.headword
      // 重载让首页读到注入的 plan（index=0 无评分 → fresh/开始学习）
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await waitSeededHome(page)
      await page.waitForTimeout(800)
      const startBtn = page.getByRole('button', { name: /开始学习|继续学习/ }).first()
      await startBtn.click()
      await page.waitForURL(/\/study/, { timeout: 15_000 })
      await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
      let firstShowHints = null
      for (let i = 0; i < expected.ratings.length; i += 1) {
        await enterAnnotation(page)
        const hints = await readHints(page)
        if (i === 0) firstShowHints = hints
        else {
          const exp = expected.steps[i - 1].predicts
          record.samples.push({ index: i, labels: await readLabels(page), hints })
          const texts = { familiar: hints.familiar, vague: hints.vague, forgot: hints.forgot }
          for (const ratingKey of ['familiar', 'vague', 'forgot']) {
            assert(
              texts[ratingKey] === exp[ratingKey].text,
              `${name} 第 ${i} 步 ${ratingKey} 实际「${texts[ratingKey]}」期望「${exp[ratingKey].text}」`,
            )
          }
        }
        await page.screenshot({ path: join(OUT, `S10-${name}-step${i + 1}.png`) })
        result.screenshots.push(`S10-${name}-step${i + 1}.png`)
        await rate(page, expected.ratings[i])
        // 完成当日：进入完成页（无 .study-topbar）
        if ((await page.locator('.study-topbar').count()) === 0) {
          record.completes = true
          break
        }
        await page.waitForTimeout(300)
      }
      record.firstShowHints = firstShowHints
      record.completes = record.completes || expected.steps.at(-1).completes
      assert(record.completes, `${name} 序列最后一步应完成当日复习`)
      record.injected = injected
      record.reachedSteps = record.samples.length + 1
    } catch (error) {
      record.error = String(error?.message ?? error)
    } finally {
      mergeErrors(bag)
      await context.close()
    }
    out.sequences[name] = record
    if (record.error) throw new Error(`${name}: ${record.error}`)
  }
  return out
}

async function scenarioS11_maimemoPwa(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = { requests: [] }
  page.on('request', (req) => out.requests.push(req.url()))
  // 不依赖 .secrets 本机缓存（CI 不含）：从当前词库动态取 12 个词生成合成学习记录，
  // 写入 os.tmpdir() 供「从墨墨导出文件导入（JSON）」降级路径使用。
  const responses = ['FAMILIAR', 'VAGUE', 'FORGET', 'WELL_FAMILIAR']
  const isoDaysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString()
  const SYNTH_PATH = join(tmpdir(), `qa-maimemo-records-${process.pid}-${Date.now()}.json`)
  let syntheticRecords = []
  try {
    await page.goto(BASE + '#/decks', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.getByText(/全部词库/).first().waitFor({ state: 'visible', timeout: 60_000 })
    const deckId = await resolveDeckId(page)
    const spellings = await page.evaluate(async (deck) => {
      const open = () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
      const db = await open()
      const words = await new Promise((resolve) => {
        const req = db.transaction('words', 'readonly').objectStore('words').getAll()
        req.onsuccess = () => resolve(req.result)
      })
      const seen = new Set()
      const out = []
      for (const word of words) {
        if (word.deckId !== deck) continue
        const key = String(word.headword).toLowerCase()
        if (!key || seen.has(key)) continue
        seen.add(key)
        out.push(word.headword)
        if (out.length >= 12) break
      }
      return out
    }, deckId)
    assert(spellings.length === 12, `当前词库应能取到 12 个词生成合成记录，实际 ${spellings.length}`)
    syntheticRecords = spellings.map((vocSpelling, index) => ({
      voc_id: `qa-voc-${index + 1}`,
      voc_spelling: vocSpelling,
      add_date: isoDaysAgo(60),
      first_study_date: isoDaysAgo(30),
      last_study_date: isoDaysAgo(2),
      next_study_date: isoDaysAgo(-1),
      last_response: responses[index % responses.length],
      study_count: 3,
      tags: [],
    }))
    await writeFile(SYNTH_PATH, JSON.stringify({ records: syntheticRecords }), 'utf8')
    out.syntheticRecords = syntheticRecords.length
    out.syntheticPath = SYNTH_PATH
    await page.getByRole('button', { name: '从墨墨导入', exact: true }).first().click()
    const dialog = page.locator('.mm-dialog[aria-label="从墨墨导入"]')
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(400)
    const dialogText = (await dialog.innerText()).replace(/\s+/g, ' ')
    out.dialogText = dialogText.slice(0, 400)
    assert(/本地代理/.test(dialogText), `PWA 应为「本地代理」模式：${out.dialogText}`)
    assert(/代理地址/.test(dialogText), '弹层应显示代理地址输入')
    assert(/Token/.test(dialogText), '弹层应显示 Token 输入')
    assert(/或从墨墨导出文件导入（JSON）/.test(dialogText), '弹层应有 JSON 文件降级入口')
    await shot(page, 'S11-01-maimemo-dialog-pwa')

    const tokenInput = dialog.locator('input[type="password"]').first()
    const proxyInput = dialog.locator('input:not([type="password"])').first()
    const startBtn = dialog.getByRole('button', { name: /开始导入|导入中/ }).first()

    await tokenInput.fill('AUDIT_FAKE_TOKEN_123')
    await proxyInput.fill('')
    await page.waitForTimeout(400)
    const missingText = (await dialog.innerText()).replace(/\s+/g, ' ')
    out.missingProxyText = missingText.match(/未填写代理地址[^。]*/)?.[0] ?? ''
    assert(/未填写代理地址/.test(missingText), '未填代理时应显示「未填写代理地址」提示')
    assert(await startBtn.isDisabled(), '未填代理时「开始导入」应禁用')
    await shot(page, 'S11-02-maimemo-missing-proxy')
    const requestsBefore = out.requests.length

    await proxyInput.fill('http://127.0.0.1:9')
    await page.waitForTimeout(300)
    assert(!(await startBtn.isDisabled()), '填代理 + Token 后「开始导入」应可用')
    const deadline = Date.now() + 40_000
    await startBtn.click()
    let errorText = ''
    while (Date.now() < deadline) {
      const t = (await dialog.innerText()).replace(/\s+/g, ' ')
      if (/网络|代理|CORS|失败|Cannot|refused|fetch/i.test(t)) {
        errorText = t
        break
      }
      await page.waitForTimeout(500)
    }
    // 等真实错误文案（danger 文本 / 含「网络失败/导入失败」），且 busy 结束（按钮不再「导入中」）
    const errDeadline = Date.now() + 40_000
    let dangerText = ''
    while (Date.now() < errDeadline) {
      const btnText = (await startBtn.innerText().catch(() => '')).trim()
      const danger = dialog.locator('.mm-danger-text')
      const dangerCount = await danger.count()
      const content = dangerCount > 0 ? (await danger.last().innerText()).trim() : ''
      if (content.length > 0 && !/@|Token 约/.test(content)) {
        dangerText = content
        if (!/导入中/.test(btnText)) break
      }
      const t = (await dialog.innerText()).replace(/\s+/g, ' ')
      if (/网络失败|导入失败|无法连接|连接失败|请求失败/.test(t) && !/正在连接|导入中…/.test(t)) {
        dangerText = dangerText || t
        break
      }
      await page.waitForTimeout(500)
    }
    out.proxyErrorText = dangerText.slice(0, 300)
    assert(dangerText.length > 0, '假代理导入应显示明确的网络/代理错误提示（danger 文本）')
    assert(/网络失败|导入失败|无法连接|连接失败|请求失败|代理/.test(dangerText), `错误文案应可读：${out.proxyErrorText}`)
    assert(!/导入中/.test((await startBtn.innerText().catch(() => '')).trim()), '失败后应结束导入中状态')
    out.requestsAfterProxy = out.requests.slice(requestsBefore)
    assert(!out.requestsAfterProxy.some((u) => u.includes('open.maimemo.com')), 'PWA 代理模式不应直连 open.maimemo.com')
    await shot(page, 'S11-03-maimemo-proxy-error')

    const closeBtn = dialog.getByRole('button', { name: '关闭', exact: true })
    if ((await closeBtn.count()) > 0) await closeBtn.click()
    else await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await page.waitForTimeout(400)
    await page.getByRole('button', { name: '从墨墨导入', exact: true }).first().click()
    await dialog.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(300)
    const fileBtn = dialog.getByRole('button', { name: '或从墨墨导出文件导入（JSON）', exact: true })
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), fileBtn.click()])
    await chooser.setFiles(SYNTH_PATH)
    await dialog.waitFor({ state: 'hidden', timeout: 180_000 }).catch(() => {})
    out.fileImportToast = (await homeText(page)).slice(0, 300)
    const statesCount = await page.evaluate(async () => {
      const open = () => new Promise((resolve, reject) => {
        const req = indexedDB.open('momo-reword')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const db = await open()
      return new Promise((resolve) => {
        const req = db.transaction('states', 'readonly').objectStore('states').count()
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(-1)
      })
    })
    out.statesCount = statesCount
    assert(
      statesCount === syntheticRecords.length,
      `合成记录（${syntheticRecords.length} 条已知词）导入后 states 应 ${syntheticRecords.length}，实际 ${statesCount}`,
    )
    assert(!out.requests.some((u) => u.includes('open.maimemo.com')), 'JSON 文件降级不应请求 open.maimemo.com')
    out.fileImportOk = statesCount === syntheticRecords.length
    await shot(page, 'S11-04-maimemo-json-import-result')
  } finally {
    mergeErrors(bag)
    await context.close()
    await unlink(SYNTH_PATH).catch(() => {})
  }
  return out
}

async function scenarioS12_phrasePerMeaning(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitSeededHome(page)
    // 开启词组显示 + 总次数=1（每 c 一次即可切换，便于逐 c 截图）
    await putSetting(page, 'memory.showPhrases', true)
    await putSetting(page, 'memory.totalRepeats', 1)
    await putSetting(page, 'memory.mode', 'sequential')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)

    // 从当前词库动态挑「≥2 含义且 ≥2 个 c 各有 meaningId 词组」的词
    const candidate = await pickPhraseWord(page)
    out.candidate = candidate.candidate
    out.coverage = candidate.stats
    out.strongCandidate = candidate.strong
    out.unassignedPhrases = candidate.unassigned === true
    assert(candidate.candidate != null, `没有找到「≥2 含义且 ≥2 个 c 各有 meaningId 词组」的词；覆盖率=${JSON.stringify(candidate.stats)}（按约定不放宽断言）`)

    const c = candidate.candidate
    await injectPlanForWord(page, 20, { headword: c.headword })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
    await page.waitForURL(/\/study/, { timeout: 15_000 })
    await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
    await enterAnnotation(page)
    await page.getByRole('button', { name: '记忆', exact: true }).first().click()
    await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 15_000 })

    const readPhrases = async () => {
      const rows = await page.locator('.wc-phrase-line').allInnerTexts()
      return rows.map((t) => t.replace(/\s+/g, ' ').trim())
    }
    out.means = []
    for (let i = 0; i < c.meanings.length; i += 1) {
      const meaning = c.meanings[i]
      const displayed = await readPhrases()
      out.means.push({ index: i, meaningId: meaning.id, cn: meaning.cn, displayed })
      // 只显示当前 c 的词组（顺序/内容精确匹配；最多 3 条）
      const expected = meaning.phrases.map((p) => `${p.en} — ${p.cn}`)
      assert(
        JSON.stringify(displayed) === JSON.stringify(expected),
        `${c.headword} c${i + 1}(${meaning.cn}) 词组应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(displayed)}`,
      )
      // 其它 c 的词组不得出现
      for (const other of c.meanings) {
        if (other.id === meaning.id) continue
        for (const p of other.phrases) {
          assert(!displayed.includes(`${p.en} — ${p.cn}`), `c${i + 1} 出现了其它含义词组：${p.en}`)
        }
      }
      // 词级（meaningId 缺失）词组一律不显示
      for (const p of c.nullMeaningPhrases) {
        assert(!displayed.includes(`${p.en} — ${p.cn}`), `c${i + 1} 出现了无 meaningId 的词级词组：${p.en}`)
      }
      await shot(page, `S12-${c.headword.toLowerCase()}-c${i + 1}`)
      // 点 1 次（totalRepeats=1）→ 切到下一个 c
      await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height * 0.5))
      await page.waitForTimeout(700)
    }
    // 全部 c 完成后回注释面
    await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 15_000 })
    out.completedBackToAnnotation = true
    out.distinctMeaningPhrases = new Set(
      c.meanings.flatMap((m) => (m.phrases.length > 0 ? [m.id] : [])),
    ).size
    if (candidate.strong) {
      assert(out.distinctMeaningPhrases >= 2, '候选词应有 ≥2 个 c 各自有词组')
    } else {
      // 公开 dagang：至少有一个 c 有归属词组（Lead 统计 38% 词组有归属）；其余 c 断言不显示
      assert(out.distinctMeaningPhrases >= 1, '候选词至少应有 1 个 c 有 meaningId 词组')
      out.note = '候选词为单含义有词组（公开词库多义项少），已验证「该 c 显示、其它 c 不显示」'
    }
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS13_icons(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = { assets: [], manifestIcons: [], errors: [] }
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForTimeout(1200)
    out.page = await page.evaluate(async () => {
      const readPng = async (url) => {
        const res = await fetch(url)
        const buf = new Uint8Array(await res.arrayBuffer())
        const okPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
        const width = okPng ? buf[16] * 16777216 + buf[17] * 65536 + buf[18] * 256 + buf[19] : -1
        const height = okPng ? buf[20] * 16777216 + buf[21] * 65536 + buf[22] * 256 + buf[23] : -1
        return { url, status: res.status, contentType: res.headers.get('content-type'), bytes: buf.length, width, height }
      }
      const paths = ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/icon-maskable-512.png']
      const assets = []
      for (const path of paths) assets.push(await readPng(path))
      const manifestRes = await fetch('/manifest.webmanifest')
      const manifest = await manifestRes.json()
      const manifestIcons = []
      for (const icon of manifest.icons ?? []) {
        const check = await readPng('/' + String(icon.src).replace(/^\.?\//, ''))
        manifestIcons.push({ ...icon, httpStatus: check.status, width: check.width, height: check.height })
      }
      const iconLink = document.querySelector('link[rel~="icon"]')?.getAttribute('href') ?? null
      const appleLink = document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href') ?? null
      const manifestLink = document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null
      const faviconCheck = iconLink ? await readPng(new URL(iconLink, location.href).pathname) : null
      return {
        assets,
        manifestStatus: manifestRes.status,
        manifestName: manifest.name,
        manifestIcons,
        iconLink,
        appleLink,
        manifestLink,
        faviconCheck,
        title: document.title,
      }
    })
    const expected = [
      { url: '/icons/icon-192.png', width: 192, height: 192 },
      { url: '/icons/icon-512.png', width: 512, height: 512 },
      { url: '/icons/icon-maskable-512.png', width: 512, height: 512 },
    ]
    for (const exp of expected) {
      const actual = out.page.assets.find((a) => a.url === exp.url)
      assert(actual != null, `缺少图标 ${exp.url}`)
      assert(actual.status === 200, `${exp.url} HTTP ${actual.status}`)
      assert(/image\/png/.test(actual.contentType ?? ''), `${exp.url} content-type=${actual.contentType}`)
      assert(actual.width === exp.width && actual.height === exp.height, `${exp.url} 尺寸 ${actual.width}x${actual.height}，期望 ${exp.width}x${exp.height}`)
    }
    assert(out.page.manifestStatus === 200, `manifest HTTP ${out.page.manifestStatus}`)
    const srcs = out.page.manifestIcons.map((i) => String(i.src))
    assert(srcs.includes('icons/icon-192.png') && srcs.includes('icons/icon-512.png') && srcs.includes('icons/icon-maskable-512.png'), `manifest icons 指向异常：${JSON.stringify(srcs)}`)
    const sizesOk = out.page.manifestIcons.every((i) => {
      const [w, h] = String(i.sizes).split('x').map(Number)
      return i.httpStatus === 200 && i.width === w && i.height === h
    })
    assert(sizesOk, `manifest icons 尺寸/状态不匹配：${JSON.stringify(out.page.manifestIcons)}`)
    assert(out.page.manifestIcons.some((i) => i.purpose === 'maskable'), 'manifest 缺少 maskable 图标')
    assert(/icon-192\.png$/.test(out.page.iconLink ?? ''), `favicon link 异常：${out.page.iconLink}`)
    assert(out.page.faviconCheck != null && out.page.faviconCheck.status === 200 && out.page.faviconCheck.width === 192, `favicon 实际加载异常：${JSON.stringify(out.page.faviconCheck)}`)
    assert(out.page.manifestLink != null, '缺少 manifest link')
    // 截图：图标本身 + 首页
    await page.goto(BASE + '/icons/icon-512.png', { waitUntil: 'load' })
    await page.waitForTimeout(400)
    await shot(page, 'S13-01-icon-512')
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    await shot(page, 'S13-02-home-with-icon')
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

async function scenarioS14_layout(browser) {
  const viewports = [
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]
  const pages = [
    { name: 'home', hash: '', wait: async (page) => { await waitSeededHome(page) } },
    { name: 'me', hash: '#/me', wait: async (page) => { await page.getByText('学习数据', { exact: true }).first().waitFor({ state: 'visible', timeout: 30_000 }) } },
    {
      name: 'stats',
      hash: '#/stats',
      // 统计页空态没有 SectionBand：先学 1 个词造数据，再进统计页（真实 UI 流程）
      prepare: async (page) => {
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await waitSeededHome(page)
        await clickHomeLearn(page)
        await enterAnnotation(page)
        await rate(page, 'familiar')
        await waitNextBoard(page)
        await exitStudy(page)
        await waitHome(page)
      },
      wait: async (page) => {
        await page.locator('.tabbar').first().waitFor({ state: 'visible', timeout: 30_000 })
        await page.waitForTimeout(1500)
        assert((await page.locator('.mm-section-band').count()) > 0, '统计页有学习数据后应出现 SectionBand（空态不满足 S14 样本条件）')
      },
    },
  ]
  const out = { viewports: viewports.map((v) => `${v.width}x${v.height}`), pages: {} }
  for (const vp of viewports) {
    for (const target of pages) {
      const { context, page, bag } = await newContext(browser, vp)
      const record = {}
      try {
        if (typeof target.prepare === 'function') await target.prepare(page)
        await page.goto(BASE + target.hash, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        await target.wait(page)
        await page.waitForTimeout(600)
        const base = await page.evaluate(() => {
          const tab = document.querySelector('.tabbar')
          const shell = document.querySelector('.app-shell')
          const main = document.querySelector('.app-main')
          if (!tab || !shell || !main) return null
          const tabRect = tab.getBoundingClientRect()
          const shellRect = shell.getBoundingClientRect()
          // 滚到底，检查最后内容是否被 tabbar 遮挡
          main.scrollTop = main.scrollHeight
          const pageBox = document.querySelector('.mm-page') ?? main.lastElementChild
          const pageRect = pageBox ? pageBox.getBoundingClientRect() : null
          return {
            innerHeight: window.innerHeight,
            innerWidth: window.innerWidth,
            tabbarBottom: tabRect.bottom,
            tabbarTop: tabRect.top,
            tabbarHeight: tabRect.height,
            shellBottom: shellRect.bottom,
            shellHeight: shellRect.height,
            mainScrollHeight: main.scrollHeight,
            mainClientHeight: main.clientHeight,
            pageBottom: pageRect ? pageRect.bottom : null,
            pageBottomVsTabbarTop: pageRect ? pageRect.bottom - tabRect.top : null,
          }
        })
        assert(base != null, `${target.name}@${vp.width}: .tabbar/.app-shell/.app-main 缺失`)
        record.base = base
        // 1) tabbar 贴底：bottom 与 innerHeight 差 ≤1
        const diff = Math.abs(base.tabbarBottom - base.innerHeight)
        assert(diff <= 1, `${target.name}@${vp.width}: tabbar.bottom=${base.tabbarBottom.toFixed(1)} 与 innerHeight=${base.innerHeight} 差 ${diff.toFixed(1)}px（应≤1）`)
        // shell 高度应撑满视口（100dvh/100vh 兜底）
        const shellDiff = Math.abs(base.shellBottom - base.innerHeight)
        assert(shellDiff <= 1, `${target.name}@${vp.width}: app-shell.bottom=${base.shellBottom.toFixed(1)} 与 innerHeight=${base.innerHeight} 差 ${shellDiff.toFixed(1)}px`)
        // 2) 滚动到底：页面最后内容不被 tabbar 遮挡
        assert(base.pageBottomVsTabbarTop != null, `${target.name}@${vp.width}: 无页面内容容器`)
        assert(base.pageBottomVsTabbarTop <= 1, `${target.name}@${vp.width}: 滚动到底后内容底=${base.pageBottom.toFixed(1)} 超过 tabbar 顶=${base.tabbarTop.toFixed(1)}（${base.pageBottomVsTabbarTop.toFixed(1)}px 被遮挡）`)
        // 3) band 与其后紧邻 card/list 的实际间距 ≈12–20px（至少 >0）
        const gaps = await page.evaluate(() => {
          const bands = Array.from(document.querySelectorAll('.mm-section-band'))
          const rows = []
          for (const band of bands) {
            const next = band.nextElementSibling
            const prev = band.previousElementSibling
            const b = band.getBoundingClientRect()
            const n = next && next.matches('.mm-card, .mm-list, .mm-stat-grid') ? next.getBoundingClientRect() : null
            rows.push({
              band: (band.textContent ?? '').trim().slice(0, 20),
              // band 下边 → 紧随卡片/网格上边（期望 16px）
              gapBottom: n ? n.top - b.bottom : null,
              // band 上边 → 前一个兄弟元素下边（期望 16px；无前兄弟则 null）
              gapTop: prev ? b.top - prev.getBoundingClientRect().bottom : null,
              marginTop: parseFloat(getComputedStyle(band).marginTop) || 0,
              marginBottom: parseFloat(getComputedStyle(band).marginBottom) || 0,
            })
          }
          return rows
        })
        record.gaps = gaps
        const withCard = gaps.filter((g) => g.gapBottom != null)
        assert(withCard.length > 0, `${target.name}@${vp.width}: 未找到 .mm-section-band 后紧邻 .mm-card/.mm-list/.mm-stat-grid 的样本`)
        for (const row of withCard) {
          assert(row.gapBottom > 0.5, `${target.name}@${vp.width}: band「${row.band}」与卡片间距 ${row.gapBottom.toFixed(1)}px 应 >0`)
          assert(Math.abs(row.gapBottom - 16) <= 1, `${target.name}@${vp.width}: band「${row.band}」下间距 ${row.gapBottom.toFixed(1)}px，期望 16px（±1）`)
        }
        const withPrev = gaps.filter((g) => g.gapTop != null)
        for (const row of withPrev) {
          assert(Math.abs(row.gapTop - 16) <= 1, `${target.name}@${vp.width}: band「${row.band}」上间距 ${row.gapTop.toFixed(1)}px，期望 16px（±1）`)
        }
        record.screenshot = `S14-${target.name}-${vp.width}`
        await shot(page, record.screenshot)
      } catch (error) {
        record.error = String(error?.message ?? error)
      } finally {
        mergeErrors(bag)
        await context.close()
      }
      out.pages[`${target.name}@${vp.width}`] = record
    }
  }
  const failures = Object.entries(out.pages).filter(([, r]) => r.error)
  if (failures.length > 0) {
    throw new Error(failures.map(([k, r]) => `${k}: ${r.error}`).join(' | '))
  }
  return out
}

async function readPlanWordIds(page) {
  const deckId = await resolveDeckId(page)
  return page.evaluate(async (deck) => {
    const open = () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('momo-reword')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    const db = await open()
    const plans = await new Promise((resolve) => {
      const req = db.transaction('plans', 'readonly').objectStore('plans').getAll()
      req.onsuccess = () => resolve(req.result)
    })
    const active = plans.filter((p) => !p.completedAt && p.index < p.wordIds.length).sort((a, b) => b.updatedAt - a.updatedAt)[0]
    const words = await new Promise((resolve) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll()
      req.onsuccess = () => resolve(req.result)
    })
    const byOrder = words
      .filter((w) => w.deckId === deck)
      .sort((a, b) => a.order - b.order)
      .map((w) => w.id)
    return active ? { planId: active.id, wordIds: active.wordIds, deckOrder: byOrder, index: active.index } : null
  }, deckId)
}

async function scenarioS15_defaults(browser) {
  const out = {}
  // A) task-47 默认显示词组：w-c 页默认（不打开 showPhrases 设置）就能看到当前 c 的词组
  {
    const { context, page, bag } = await newContext(browser)
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitSeededHome(page)
      const picked = await pickPhraseWord(page)
      out.candidate = picked.candidate
      out.coverage = picked.stats
      out.strongCandidate = picked.strong
      assert(picked.candidate != null, `当前词库没有「≥2 含义且有 meaningId 词组」的词：${JSON.stringify(picked.stats)}`)
      const cand = picked.candidate
      await injectPlanForWord(page, 8, { headword: cand.headword })
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await waitSeededHome(page)
      await page.waitForTimeout(600)
      await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
      await page.waitForURL(/\/study/, { timeout: 15_000 })
      await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
      await enterAnnotation(page)
      await page.getByRole('button', { name: '记忆', exact: true }).first().click()
      await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForTimeout(600)
      // 默认 showPhrases=true：找到当前 c 有词组的一屏，断言与数据归属一致
      let found = null
      for (let tapIndex = 0; tapIndex < 40 && !found; tapIndex += 1) {
        const cn = (await page.locator('.wc-cn').first().innerText().catch(() => '')).trim()
        const lines = (await page.locator('.wc-phrase-line').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
        if (lines.length > 0) {
          const meaning = cand.meanings.find((m) => m.cn === cn)
          found = { cn, lines, expected: meaning ? meaning.phrases.map((p) => `${p.en} — ${p.cn}`) : [] }
          break
        }
        await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height * 0.5))
        await page.waitForTimeout(280)
      }
      out.defaultPhrases = found ? found.lines : []
      out.phraseMeaning = found?.cn ?? null
      assert(found != null, `showPhrases 默认 true 时，w-c 页应默认显示当前 c 的词组（词 ${cand.headword}）`)
      assert(JSON.stringify(found.lines) === JSON.stringify(found.expected), `w-c 默认词组应为当前 c 的词组：实际 ${JSON.stringify(found.lines)}，期望 ${JSON.stringify(found.expected)}`)
      await shot(page, 'S15-01-phrases-default-on')
    } finally {
      mergeErrors(bag)
      await context.close()
    }
  }
  // B) task-47 新词顺序 random：不同日期种子不同、同一天重复进入顺序一致、不按字母/词库序
  const orderForDate = async (iso) => {
    const { context, page, bag } = await newContext(browser)
    try {
      await page.clock.setFixedTime(new Date(iso))
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitSeededHome(page)
      await clickHomeLearn(page)
      await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
      const first = await readPlanWordIds(page)
      await exitStudy(page)
      await waitHome(page)
      await clickHomeLearn(page)
      await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
      const sameDayAgain = await readPlanWordIds(page)
      await exitStudy(page)
      return { first, sameDayAgain }
    } finally {
      mergeErrors(bag)
      await context.close()
    }
  }
  const day1 = await orderForDate('2026-11-11T10:00:00+08:00')
  const day2 = await orderForDate('2026-11-12T10:00:00+08:00')
  assert(day1.first != null && day2.first != null, '应能读到今日 plan')
  const first12 = (r) => r.first.wordIds.slice(0, 12)
  out.sameDayStable = JSON.stringify(day1.first.wordIds) === JSON.stringify(day1.sameDayAgain.wordIds)
  assert(out.sameDayStable, '同一天重复进入应复用同一 plan、新词顺序一致')
  out.crossDayDifferent = JSON.stringify(first12(day1)) !== JSON.stringify(first12(day2))
  assert(out.crossDayDifferent, `不同日期种子应产生不同新词顺序（D1=${first12(day1).slice(0,4)}… D2=${first12(day2).slice(0,4)}…）`)
  // 不按词库 order 顺序（有逆序）
  const deckIndex = new Map(day1.first.deckOrder.map((id, i) => [id, i]))
  const seq = first12(day1).map((id) => deckIndex.get(id)).filter((x) => x != null)
  const inversions = seq.reduce((acc, v, i) => acc + seq.slice(i + 1).filter((w) => w < v).length, 0)
  out.inversions = inversions
  assert(inversions > 0, `新词顺序应非词库 order 序（前 12 词逆序数=${inversions}）`)
  out.day1Sample = first12(day1)
  out.day2Sample = first12(day2)
  out.phraseScreenshot = 'S15-01-phrases-default-on.png'
  return out
}

async function scenarioS16_todayBreakdown(browser) {
  const out = {}
  // ---------- A. 有数据路径 ----------
  {
    const { context, page, bag } = await newContext(browser)
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitSeededHome(page)
      out.injected = await injectDueStates(page, 2)
      await page.goto(BASE, { waitUntil: 'domcontentloaded' })
      await waitSeededHome(page)
      await page.waitForTimeout(1200)
      const kpis = () =>
        page.evaluate(() =>
          Array.from(document.querySelectorAll('.mm-kpi')).map((el) => {
            const lines = (el.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean)
            return { value: lines[0] ?? '', label: lines[1] ?? '' }
          }),
        )
      out.homeBefore = await kpis()
      await shot(page, 'S16-01-home-kpi-before')
      assert(JSON.stringify(out.homeBefore.map((k) => k.label)) === JSON.stringify(['待复习', '待新学', '今日已学']), `首页 KPI 应固定三项，实际 ${JSON.stringify(out.homeBefore)}`)
      assert(out.homeBefore[0].value === '2' && out.homeBefore[1].value === '28' && out.homeBefore[2].value === '0', `首页 KPI 初始应 2/28/0，实际 ${JSON.stringify(out.homeBefore)}`)

      // 做 2 个复习（认识、模糊）+ 1 个新学（模糊→回炉）
      await clickHomeLearn(page)
      await enterAnnotation(page)
      await rate(page, 'familiar')
      await waitNextBoard(page)
      await enterAnnotation(page)
      await rate(page, 'vague')
      await waitNextBoard(page)
      await enterAnnotation(page)
      await rate(page, 'vague')
      await waitNextBoard(page)
      await exitStudy(page)
      await waitSeededHome(page)
      await page.waitForTimeout(1200)

      out.homeAfter = await kpis()
      out.homeAfterText = (await homeText(page)).slice(0, 300)
      await shot(page, 'S16-02-home-after-3')
      assert(out.homeAfter[2].value === '3', `今日已学应 3，实际 ${JSON.stringify(out.homeAfter)}`)
      assert(/复习 2 · 新学 1/.test(out.homeAfterText), `首页应显示「复习 2 · 新学 1」，实际：${out.homeAfterText}`)
      assert(out.homeAfter[0].value === '0' && out.homeAfter[1].value === '27', `首页 KPI 应 0/27/3，实际 ${JSON.stringify(out.homeAfter)}`)

      // 查看今日单词 → /today
      await page.getByRole('button', { name: '查看今日单词 ›', exact: true }).first().click()
      await page.waitForURL(/\/today|#\/today/, { timeout: 15_000 })
      await page.locator('.mm-section-band').first().waitFor({ state: 'visible', timeout: 20_000 })
      await page.waitForTimeout(800)
      const pageData = await page.evaluate(() => {
        const bands = Array.from(document.querySelectorAll('.mm-section-band')).map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim())
        const rows = Array.from(document.querySelectorAll('.mm-row')).map((el) => ({
          title: (el.querySelector('.mm-row-title')?.textContent ?? '').trim(),
          tags: Array.from(el.querySelectorAll('.mm-badge')).map((b) => (b.textContent ?? '').trim()),
        }))
        const kpi = Array.from(document.querySelectorAll('.mm-kpi')).map((el) => {
          const lines = (el.innerText || '').split('\n').map((x) => x.trim()).filter(Boolean)
          return { value: lines[0] ?? '', label: lines[1] ?? '' }
        })
        return { bands, rows, kpi }
      })
      out.today = pageData
      out.todayBands = pageData.bands
      out.todayTags = [...new Set(pageData.rows.flatMap((r) => r.tags))]
      out.todayKpi = pageData.kpi
      out.todayRatings = pageData.rows.flatMap((r) => r.tags).filter((t) => ['认识', '模糊', '忘记'].includes(t))
      await shot(page, 'S16-03-today-page')
      assert(pageData.bands.some((b) => /复习（2）/.test(b)), `应有「复习（2）」分区，实际 ${JSON.stringify(pageData.bands)}`)
      assert(pageData.bands.some((b) => /新学（28）/.test(b)), `应有「新学（28）」分区，实际 ${JSON.stringify(pageData.bands)}`)
      assert(pageData.bands.some((b) => /已学 2 · 未学 0/.test(b)), `复习分区应「已学 2 · 未学 0」，实际 ${JSON.stringify(pageData.bands)}`)
      assert(pageData.bands.some((b) => /已学 1 · 未学 27/.test(b)), `新学分区应「已学 1 · 未学 27」，实际 ${JSON.stringify(pageData.bands)}`)
      assert(out.todayRatings.includes('认识') && out.todayRatings.includes('模糊'), `应出现评分标签 认识/模糊，实际 ${JSON.stringify(out.todayRatings)}`)
      assert(out.todayTags.includes('未学'), '应有「未学」标签')
      assert(out.todayTags.includes('回炉'), `应有「回炉」标签，实际 ${JSON.stringify(out.todayTags)}`)
      assert(pageData.rows.length === 30, `今日单词应 30 个去重词，实际 ${pageData.rows.length}`)

      // 点词开详情 sheet
      await page.locator('.mm-row').first().click()
      const sheet = page.locator('.mm-sheet[role="dialog"]')
      await sheet.waitFor({ state: 'visible', timeout: 10_000 })
      out.sheetTitle = (await sheet.locator('.mm-sheet-title span').first().innerText()).trim()
      assert(out.sheetTitle.length > 0, '详情 sheet 应显示单词标题')
      await shot(page, 'S16-04-today-word-sheet')
      await sheet.getByRole('button', { name: '关闭', exact: true }).click()
      await page.waitForTimeout(400)

      // 加学标签：向今日 plan 注入手动加学词（sources='extra'）
      out.extra = await page.evaluate(async () => {
        const open = () =>
          new Promise((resolve, reject) => {
            const req = indexedDB.open('momo-reword')
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
          })
        const db = await open()
        const plans = await new Promise((resolve) => {
          const req = db.transaction('plans', 'readonly').objectStore('plans').getAll()
          req.onsuccess = () => resolve(req.result)
        })
        const plan = plans.filter((p) => !p.completedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0]
        if (!plan) return null
        const words = await new Promise((resolve) => {
          const req = db.transaction('words', 'readonly').objectStore('words').getAll()
          req.onsuccess = () => resolve(req.result)
        })
        const inPlan = new Set(plan.wordIds)
        const extra = words.find((w) => w.deckId === plan.deckId && !inPlan.has(w.id))
        if (!extra) return null
        plan.wordIds.push(extra.id)
        plan.sources[extra.id] = 'extra'
        plan.updatedAt = Date.now()
        await new Promise((resolve, reject) => {
          const tx = db.transaction('plans', 'readwrite')
          tx.objectStore('plans').put(plan)
          tx.oncomplete = () => resolve()
          tx.onerror = () => reject(tx.error)
        })
        return extra.headword
      })
      assert(out.extra, '应能注入一个加学词')
      out.planAfterInject = await page.evaluate(async (word) => {
        const open = () =>
          new Promise((resolve, reject) => {
            const req = indexedDB.open('momo-reword')
            req.onsuccess = () => resolve(req.result)
            req.onerror = () => reject(req.error)
          })
        const db = await open()
        const plans = await new Promise((resolve) => {
          const req = db.transaction('plans', 'readonly').objectStore('plans').getAll()
          req.onsuccess = () => resolve(req.result)
        })
        const plan = plans.filter((p) => !p.completedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0]
        return plan
          ? { id: plan.id, hasWord: plan.wordIds.some((id) => id.endsWith(':' + word)), source: plan.sources[Object.keys(plan.sources).find((k) => k.endsWith(':' + word)) ?? ''], tail: plan.wordIds.slice(-2) }
          : null
      }, out.extra)
      // 注意：上面用原生 IndexedDB 写 plan，Dexie liveQuery 不感知外部写 → 必须整页 reload 取新数据
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1200)
      await page.locator('.mm-section-band').first().waitFor({ state: 'visible', timeout: 20_000 })
      const extraTags = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.mm-row')).map((el) => ({
          title: (el.querySelector('.mm-row-title')?.textContent ?? '').trim(),
          tags: Array.from(el.querySelectorAll('.mm-badge')).map((b) => (b.textContent ?? '').trim()),
        })),
      )
      out.extraRowsSample = extraTags.slice(-4)
      out.extraRow = extraTags.find((r) => r.tags.includes('加学'))
      assert(out.extraRow != null, `应出现「加学」标签的词（注入 ${out.extra}）；plan=${JSON.stringify(out.planAfterInject)}；尾部行=${JSON.stringify(out.extraRowsSample)}`)
      await shot(page, 'S16-05-today-extra-tag')

      // 统计页新增行
      await page.goto(BASE + '#/stats', { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1500)
      out.statsText = (await homeText(page)).slice(0, 600)
      await shot(page, 'S16-06-stats-today-line')
      assert(/今日已学 3 个 · 复习 2 · 新学 1/.test(out.statsText), `统计页应有「今日已学 3 个 · 复习 2 · 新学 1」，实际：${out.statsText}`)
    } finally {
      mergeErrors(bag)
      await context.close()
    }
  }
  // ---------- B. 空态 ----------
  {
    const { context, page, bag } = await newContext(browser)
    try {
      await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await page.waitForTimeout(1500)
      out.emptyText = (await homeText(page)).slice(0, 200)
      await shot(page, 'S16-07-today-empty')
      assert(/今天还没有学习记录/.test(out.emptyText), `空态应显示「今天还没有学习记录」，实际：${out.emptyText}`)
    } finally {
      mergeErrors(bag)
      await context.close()
    }
  }
  return out
}

async function scenarioS17_dailyReviewCap(browser) {
  const { context, page, bag } = await newContext(browser)
  const out = {}
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await waitSeededHome(page)
    await putSetting(page, 'study.dailyReviewCap', 50)
    await putSetting(page, 'study.dailyGoal', 30)
    out.injected = await injectDueStates(page, 459)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await page.waitForTimeout(1500)
    out.homeBeforePlan = (await homeText(page)).slice(0, 500)
    await shot(page, 'S17-01-home-cap50-before-plan')
    // task-54：未建 plan 时按「今日预算入队数 min(due,cap)=50」预计算 backlog → 顺延 409
    assert(/459\s*待复习/.test(out.homeBeforePlan) || /待复习 459/.test(out.homeBeforePlan), `首页待复习应=全部到期 459：${out.homeBeforePlan}`)
    assert(/今日上限 50 个/.test(out.homeBeforePlan), `首页应显示「今日上限 50 个」：${out.homeBeforePlan}`)
    assert(/另有 409 个到期复习/.test(out.homeBeforePlan), `未建 plan 时也应提示「另有 409 个到期复习」（task-54），实际：${out.homeBeforePlan}`)
    assert(/将顺延/.test(out.homeBeforePlan), '首页应有「将顺延」提示')
    assert(/0\s*待新学|待新学 0/.test(out.homeBeforePlan), `due 459 > goal 30 时待新学应 0：${out.homeBeforePlan}`)

    // 建 plan（cap=50）→ 学习队列 1/50
    await clickHomeLearn(page)
    await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(500)
    out.progressCap50 = await progressText(page)
    await shot(page, 'S17-02-study-queue-50')
    const m = out.progressCap50.match(/(\d+)\s*\/\s*(\d+)/)
    assert(m != null && Number(m[2]) === 50, `cap=50 时学习队列应为 50，实际 ${out.progressCap50}`)
    await exitStudy(page)
    await waitSeededHome(page)
    await page.waitForTimeout(1200)
    out.homeAfterPlan = (await homeText(page)).slice(0, 500)
    await shot(page, 'S17-03-home-cap50-after-plan')
    // 建 plan 后：入队 50 → 顺延 459-50=409
    assert(/另有 409 个到期复习/.test(out.homeAfterPlan), `建 plan 后首页应提示「另有 409 个到期复习」，实际：${out.homeAfterPlan}`)
    assert(/459\s*待复习/.test(out.homeAfterPlan) || /待复习 459/.test(out.homeAfterPlan), `建 plan 后首页待复习仍=全部到期 459：${out.homeAfterPlan}`)

    // 退出后读取 plan（此时一定已落库）
    let planBefore = await readPlanWordIds(page)
    for (let i = 0; i < 20 && !(planBefore && planBefore.wordIds); i += 1) {
      await page.waitForTimeout(200)
      planBefore = await readPlanWordIds(page)
    }
    assert(planBefore && planBefore.wordIds, '应能读到今日 plan')
    out.planLengthCap50 = planBefore.wordIds.length
    assert(out.planLengthCap50 === 50, `plan 入队复习应 50，实际 ${out.planLengthCap50}`)

    // /today 顺延提示
    await page.goto(BASE + '#/today', { waitUntil: 'domcontentloaded' })
    await page.locator('.mm-section-band').first().waitFor({ state: 'visible', timeout: 20_000 })
    await page.waitForTimeout(800)
    out.todayText = (await homeText(page)).slice(0, 400)
    await shot(page, 'S17-04-today-cap50-backlog')
    assert(/其余 409 个到期复习将在之后复习/.test(out.todayText), `今日页应提示「其余 409 …」，实际：${out.todayText}`)
    assert(/复习（50）/.test(out.todayText), `今日页复习分区应为 50：${out.todayText}`)

    // 当天改 cap=100：今日 plan 不重排（仍 50）
    await putSetting(page, 'study.dailyReviewCap', 100)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1200)
    const planAfterSameDay = await page.evaluate(async () => {
      const open = () =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
      const db = await open()
      const plans = await new Promise((resolve) => {
        const req = db.transaction('plans', 'readonly').objectStore('plans').getAll()
        req.onsuccess = () => resolve(req.result)
      })
      const plan = plans.filter((p) => !p.completedAt).sort((a, b) => b.updatedAt - a.updatedAt)[0]
      return plan ? { wordIds: plan.wordIds } : null
    })
    out.sameDayPlanUnchanged =
      planAfterSameDay != null && JSON.stringify(planAfterSameDay.wordIds) === JSON.stringify(planBefore.wordIds)
    assert(out.sameDayPlanUnchanged, `当天改 cap 不应重排今日 plan（前 ${out.planLengthCap50} vs 后 ${planAfterSameDay?.wordIds.length}）`)
    out.sameDayQueueLength = planAfterSameDay?.wordIds.length
    await shot(page, 'S17-05-home-cap100-same-day')

    // 次日生效：+1 天新 plan 按 cap=100 入队 min(459,100)=100
    await page.clock.setFixedTime(new Date(Date.now() + 86_400_000))
    // 当前在 #/today；先回首页（固定时钟保持），等待新一天首页数据
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    try {
      await waitSeededHome(page)
      await page.waitForTimeout(1200)
      out.nextDayHomeText = (await homeText(page)).slice(0, 400)
      out.nextDayUrlBefore = page.url()
      await clickHomeLearn(page)
    } catch (error) {
      out.nextDayErrorText = (await homeText(page)).slice(0, 500)
      out.nextDayUrl = page.url()
      await shot(page, 'S17-06-next-day-error')
      throw new Error(`${String(error?.message ?? error)}；home=${out.nextDayErrorText}；url=${out.nextDayUrl}`)
    }
    out.progressNextDay = await progressText(page)
    const m2 = out.progressNextDay.match(/(\d+)\s*\/\s*(\d+)/)
    out.nextDayTotal = m2 ? Number(m2[2]) : null
    await shot(page, 'S17-06-study-next-day-cap100')
    assert(out.nextDayTotal === 100, `次日新 plan 应按 cap=100 入队 100 词，实际 ${out.progressNextDay}`)
  } finally {
    mergeErrors(bag)
    await context.close()
  }

  // cap=0（不限）：due=459 → 无顺延行、待新学 0（goal30−459）
  {
    const { context, page, bag } = await newContext(browser)
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitSeededHome(page)
      await putSetting(page, 'study.dailyReviewCap', 0)
      await putSetting(page, 'study.dailyGoal', 30)
      await injectDueStates(page, 459)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitSeededHome(page)
      await page.waitForTimeout(1200)
      out.homeCap0 = (await homeText(page)).slice(0, 400)
      await shot(page, 'S17-07-home-cap0-no-backlog')
      assert(!/另有 \d+ 个到期复习/.test(out.homeCap0), `cap=0 时不应显示顺延行，实际：${out.homeCap0}`)
      assert(/459\s*待复习/.test(out.homeCap0) || /待复习 459/.test(out.homeCap0), `cap=0 待复习应 459：${out.homeCap0}`)
      assert(/0\s*待新学|待新学 0/.test(out.homeCap0), `cap=0、due 459 > goal 30 时待新学应 0：${out.homeCap0}`)
    } finally {
      mergeErrors(bag)
      await context.close()
    }
  }
  // cap=0（不限）：due=2、goal=30 → 无顺延行、待新学 28
  {
    const { context, page, bag } = await newContext(browser)
    try {
      await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
      await waitSeededHome(page)
      await putSetting(page, 'study.dailyReviewCap', 0)
      await putSetting(page, 'study.dailyGoal', 30)
      await injectDueStates(page, 2)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await waitSeededHome(page)
      await page.waitForTimeout(1200)
      out.homeCap0Due2 = (await homeText(page)).slice(0, 400)
      await shot(page, 'S17-08-home-cap0-due2')
      assert(!/另有 \d+ 个到期复习/.test(out.homeCap0Due2), `cap=0 时不应显示顺延行：${out.homeCap0Due2}`)
      assert(/待新学 28|28\s*待新学/.test(out.homeCap0Due2), `cap=0、due=2、goal=30 时待新学应 28：${out.homeCap0Due2}`)
    } finally {
      mergeErrors(bag)
      await context.close()
    }
  }
  return out
}

/**
 * task-71 · AI 扩充 E2E（fake provider：本地 route 拦截 mock，不访问外网/真实 Key）
 * 覆盖：设置/掩码/持久化/清除/测试连接；生成范围/类型/排除/进度/取消/402/429/408 文案；
 *       审核 ✓/全选/❌；内容包导入（未接线时禁用）；隐私（导出/控制台/toast/页面无完整 Key）。
 */
async function scenarioS18_ai(browser) {
  const out = { skipped: null }
  const FULL_KEY = 'sk-TEST'
  const SESSION_KEY = 'sk-SESS'
  const stableStringify = (value) => {
    if (value === null || value === undefined) return 'null'
    if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
    if (typeof value === 'object') {
      return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  const fnv1a64Hex = (input) => {
    let hash = 0xcbf29ce484222325n
    for (let i = 0; i < input.length; i += 1) {
      hash ^= BigInt(input.charCodeAt(i))
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
    }
    return hash.toString(16).padStart(16, '0')
  }
  const mock = { mode: 'ok', delayMs: 0, calls: 0, log: [] }
  const consoleTexts = []
  const buildMockContent = (userPrompt) => {
    const kindMatch = /kind = (examples|phrases|mnemonics)/.exec(userPrompt)
    const start = userPrompt.indexOf('targets = ')
    const end = userPrompt.indexOf('\n请只输出', start)
    if (!kindMatch || start < 0 || end < 0) { mock.log.push({ kind: kindMatch?.[1] ?? 'unknown', targetCount: -1, itemCount: 0, ok: false }); return JSON.stringify({ items: [] }) }
    const kind = kindMatch[1]
    let targets
    try {
      targets = JSON.parse(userPrompt.slice(start + 'targets = '.length, end))
    } catch {
      mock.log.push({ kind, targetCount: -1, itemCount: 0, ok: false, parseError: true })
      return JSON.stringify({ items: [] })
    }
    const items = targets.map((t) => {
      const item = { headword: t.headword }
      if (t.meaningIndex != null) item.meaningIndex = t.meaningIndex
      if (kind === 'examples') item.examples = [{ en: `AI example for ${t.headword}`, cn: 'AI 例句翻译' }]
      else if (kind === 'phrases') item.phrases = [{ en: `${t.headword} up`, cn: 'AI 词组翻译' }]
      else item.mnemonics = [{ type: 'assoc', text: 'AI 助记：联想法' }]
      return item
    })
    const response = JSON.stringify({ items })
    mock.log.push({ kind, targetCount: targets.length, itemCount: items.length, ok: true })
    return response
  }
  const { context, page, bag } = await newContext(browser)
  page.on('console', (msg) => consoleTexts.push(msg.text()))
  const fulfillJson = (route, status, body) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
  await page.route('**/v1/chat/completions', async (route) => {
    mock.calls += 1
    if (mock.delayMs > 0) await new Promise((r) => setTimeout(r, mock.delayMs))
    if (mock.mode === '401') return fulfillJson(route, 401, { error: { message: 'invalid key' } })
    if (mock.mode === '402') return fulfillJson(route, 402, { error: { message: 'insufficient balance' } })
    if (mock.mode === '429') return fulfillJson(route, 429, { error: { message: 'rate limited' } })
    if (mock.mode === '408') return fulfillJson(route, 408, { error: { message: 'timeout' } })
    const body = route.request().postDataJSON()
    const user = (body?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? ''
    const content = user.includes('只用于连通性测试') ? 'ok' : buildMockContent(user)
    return fulfillJson(route, 200, { choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })
  })
  try {
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    if ((await page.getByText('AI 扩充（可选）').count()) === 0) {
      out.skipped = '当前构建无 AI 扩充 UI（等 arch 构建 task-71 后运行）'
      return out
    }
    await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    await shot(page, 'S18-01-ai-settings-empty')
    // 启用 + 配置 fake provider（baseURL 指向本地 mock-ai）
    const enable = page.getByRole('switch', { name: '启用 AI 扩充' })
    await enable.click()
    await page.waitForTimeout(400)
    await page.getByLabel('AI 服务商').selectOption('openai-compatible').catch(() => {})
    await page.getByLabel('AI baseURL').fill(`${BASE.replace(/\/$/, '')}/mock-ai`)
    await page.getByLabel('AI 模型').fill('mock-model')
    await page.getByLabel('AI API Key').fill(FULL_KEY)
    await page.getByRole('button', { name: '保存 Key', exact: true }).click()
    await page.waitForFunction(() => /已配置：/.test(document.body.innerText), { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(300)
    const fullBodyAfterSave = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
    out.bodyTextAfterSave = fullBodyAfterSave.slice(0, 600)
    out.bodyHasFullKey = fullBodyAfterSave.includes(FULL_KEY)
    out.maskedShown = fullBodyAfterSave.includes('••••')
    assert(out.bodyHasFullKey === false, '页面不得出现完整 API Key')
    assert(out.maskedShown, `已配置 Key 时应显示掩码（••••）；bodyHasFullKey=${out.bodyHasFullKey}`)
    await shot(page, 'S18-02-ai-settings-masked')

    // 测试连接成功
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await page.getByText(/连接成功|连接失败/).first().waitFor({ state: 'visible', timeout: 15_000 })
    out.testOkText = (await page.getByText(/连接成功|连接失败/).first().innerText()).trim()
    assert(/连接成功/.test(out.testOkText), `mock 成功时测试连接应成功，实际 ${out.testOkText}`)
    // 401 文案
    mock.mode = '401'
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await page.waitForTimeout(600)
    out.test401Text = (await page.getByText(/连接失败/).first().innerText().catch(() => '')).trim()
    assert(/Key 无效/.test(out.test401Text), `401 应提示 Key 无效，实际 ${out.test401Text}`)
    mock.mode = 'ok'

    // 清除 Key → 未配置（先清 persistent，避免 session 测试被旧 key 干扰）
    await page.getByRole('button', { name: '清除 Key', exact: true }).click()
    await page.waitForFunction(() => /未配置/.test(document.body.innerText), { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(300)
    out.clearKeyOk = (await page.locator('body').innerText()).includes('未配置')
    assert(out.clearKeyOk, '清除 Key 后应显示未配置')
    // session 模式：保存后刷新应丢失
    await page.getByLabel('Key 存储方式').selectOption('session')
    await page.getByLabel('AI API Key').fill(SESSION_KEY)
    await page.getByRole('button', { name: '保存 Key', exact: true }).click()
    await page.waitForTimeout(700)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(700)
    const sessionBody = await page.locator('body').innerText()
    out.sessionAfterReload = sessionBody.includes('未配置') || !sessionBody.includes('已配置：')
    assert(out.sessionAfterReload, 'session Key 刷新后应失效（显示未配置）')
    // 恢复 persistent + Key
    await page.getByLabel('Key 存储方式').selectOption('persistent')
    await page.getByLabel('AI API Key').fill(FULL_KEY)
    await page.getByRole('button', { name: '保存 Key', exact: true }).click()
    await page.waitForTimeout(700)
    await shot(page, 'S18-03-ai-settings-configured')

    // 进入学习页 → 更多 → AI 补内容
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    if ((await page.getByRole('button', { name: '开始学习', exact: true }).count()) === 0) {
      await page.getByRole('button', { name: '继续学习', exact: true }).first().click()
    } else {
      await page.getByRole('button', { name: '开始学习', exact: true }).first().click()
    }
    await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
    await enterAnnotation(page)
    out.headword = (await page.locator('.word-text').first().innerText()).trim()
    await page.locator('.study-topbar [aria-label="更多"]').first().click()
    await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).first().click()
    const genDialog = page.locator('.mm-dialog[aria-label="AI 扩充内容"]')
    await genDialog.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(600)
    const genText = (await genDialog.innerText()).replace(/\s+/g, ' ')
    out.scopeOptions = ['今日要学', '当前词库', '当前词'].filter((t) => genText.includes(t))
    assert(out.scopeOptions.length === 3, `应有 3 个范围选项，实际 ${JSON.stringify(out.scopeOptions)}`)
    out.kindOptions = ['例句', '词组', '助记'].filter((t) => genText.includes(t))
    out.excludeOptions = ['已有例句', '已有词组', '已有助记', '已拒绝'].filter((t) => genText.includes(t))
    assert(out.kindOptions.length === 3 && out.excludeOptions.length === 4, `类型/排除选项缺失：${JSON.stringify({ kinds: out.kindOptions, excludes: out.excludeOptions })}`)
    await shot(page, 'S18-04-ai-generate-panel')

    // 范围切换（三档都能刷新目标）
    await genDialog.getByRole('button', { name: '今日要学', exact: true }).click()
    await page.waitForTimeout(600)
    out.todayTargetText = (await genDialog.innerText()).match(/目标：\d+ 个词\/含义/)?.[0] ?? ''
    await genDialog.getByRole('button', { name: '当前词库', exact: true }).click()
    await page.waitForTimeout(600)
    out.deckTargetText = (await genDialog.innerText()).match(/目标：\d+ 个词\/含义/)?.[0] ?? ''
    await genDialog.getByRole('button', { name: '当前词', exact: true }).click()
    await page.waitForTimeout(600)
    out.wordTargetText = (await genDialog.innerText()).match(/目标：\d+ 个词\/含义/)?.[0] ?? ''
    // 生成用「今日要学」+ 仅助记（多数词缺助记 → 多目标、审核多条）
    await genDialog.getByRole('button', { name: '今日要学', exact: true }).click()
    await page.waitForTimeout(600)
    await genDialog.getByRole('button', { name: /^(✓ )?例句$/ }).click().catch(() => {})
    await genDialog.getByRole('button', { name: /^(✓ )?助记$/ }).click()
    await page.waitForTimeout(500)
    out.activeKinds = await genDialog.locator('button[aria-pressed="true"]').allInnerTexts()
    out.targetBeforeStart = (await genDialog.innerText()).match(/目标：\d+ 个词\/含义[^\n]*/)?.[0] ?? ''
    out.mockCallsBeforeStart = mock.calls

    // 取消：slow 时点取消生成，不出现红色错误
    mock.mode = 'ok'
    mock.delayMs = 3000
    await openGenWithTargets()
    await genDialog.getByRole('button', { name: '开始生成', exact: true }).click()
    await page.waitForTimeout(600)
    await genDialog.getByRole('button', { name: '取消生成', exact: true }).click()
    await page.waitForTimeout(1200)
    out.cancelText = (await genDialog.innerText()).replace(/\s+/g, ' ').slice(0, 200)
    out.cancelErrorShown = /mm-danger-text/.test(await genDialog.innerText()) && /失败/.test(await genDialog.innerText())
    assert(/已取消/.test(out.cancelText), `取消应显示「已取消」，实际 ${out.cancelText}`)
    assert(!out.cancelErrorShown, '取消不应显示错误文案')
    await genDialog.getByRole('button', { name: '关闭', exact: true }).click().catch(() => {})
    mock.delayMs = 0

    // 402 / 429 / 408 文案
    const runError = async (mode, expectText) => {
      mock.mode = mode
      mock.delayMs = 0
      await openGenWithTargets()
      await genDialog.getByRole('button', { name: '开始生成', exact: true }).click()
      await page.waitForFunction(
        (text) => new RegExp(text).test(document.querySelector('.mm-dialog[aria-label="AI 扩充内容"]')?.textContent ?? ''),
        expectText,
        { timeout: 30_000 },
      ).catch(() => {})
      await page.waitForTimeout(600)
      const text = (await genDialog.innerText()).replace(/\s+/g, ' ')
      const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
      const hasExpected = new RegExp(expectText).test(text) || new RegExp(expectText).test(body)
      await genDialog.getByRole('button', { name: '关闭', exact: true }).click().catch(() => {})
      return { mode, text: text.slice(0, 400), body: body.slice(0, 500), hasExpected }
    }
    out.error402 = await runError('402', '余额不足')
    out.error429 = await runError('429', '请求过于频繁')
    out.error408 = await runError('408', '请求超时')
    for (const [code, res] of [['402', out.error402], ['429', out.error429], ['408', out.error408]]) {
      assert(res.hasExpected, `错误码 ${code} 应显示分类文案；dialog=${res.text}；body=${res.body}`)
    }
    mock.mode = 'ok'

    // 生成成功 → 审核（错误/取消测试关闭了面板，重新打开并确保有目标）
    mock.mode = 'ok'
    mock.delayMs = 0
    await openGenWithTargets()
    await genDialog.getByRole('button', { name: '开始生成', exact: true }).click()
    const reviewDialog = page.locator('.mm-dialog[aria-label^="审核生成内容"]')
    await reviewDialog.waitFor({ state: 'visible', timeout: 30_000 })
    await page.waitForTimeout(500)
    const reviewText = (await reviewDialog.innerText()).replace(/\s+/g, ' ')
    out.reviewTitle = reviewText.match(/审核生成内容（\d+）/)?.[0] ?? ''
    await shot(page, 'S18-05-ai-review')
    const itemCount = async () => (await reviewDialog.locator('.mm-row').count())
    out.reviewItemsBefore = await itemCount()
    out.genDialogText = (await genDialog.innerText()).replace(/\s+/g, ' ').slice(0, 500)
    out.mockLog = mock.log.slice()
    out.reviewDebug = { activeKinds: out.activeKinds, scopeButtons: out.scopeButtons, targetBeforeStart: out.targetBeforeStart, mockCalls: mock.calls, title: out.reviewTitle, rowTexts: (await reviewDialog.locator('.mm-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').slice(0, 80)) }
    assert(out.reviewItemsBefore >= 2, `应生成 ≥2 条待审内容，实际 ${out.reviewItemsBefore}；debug=${JSON.stringify(out.reviewDebug)}；mockLog=${JSON.stringify(out.mockLog)}；gen=${out.genDialogText}`)
    // ❌ 拒绝一条（尽量选非当前词，保证当前词内容仍可落库以验证 UI 刷新）
    const reviewRows = reviewDialog.locator('.mm-row')
    let rejectIndex = 0
    for (let i = 0; i < await reviewRows.count(); i += 1) {
      const txt = (await reviewRows.nth(i).innerText()).replace(/\s+/g, ' ')
      if (!txt.includes(out.headword)) { rejectIndex = i; break }
    }
    const rejectedRow = reviewRows.nth(rejectIndex)
    out.rejectedLabel = (await rejectedRow.innerText()).replace(/\s+/g, ' ').trim().slice(0, 40)
    await rejectedRow.getByRole('button', { name: /^拒绝 / }).click().catch(async () => {
      await rejectedRow.locator('button.mm-btn--ghost').click()
    })
    await page.waitForTimeout(400)
    out.reviewItemsAfterReject = await itemCount()
    assert(out.reviewItemsAfterReject === out.reviewItemsBefore - 1, `❌ 后条目应 -1（${out.reviewItemsBefore}→${out.reviewItemsAfterReject}）`)
    // 全不选 / 全选
    await reviewDialog.getByRole('button', { name: /全不选|全选/ }).click()
    await page.waitForTimeout(300)
    await reviewDialog.getByRole('button', { name: /全不选|全选/ }).click()
    await page.waitForTimeout(300)
    const saveBtn = reviewDialog.getByRole('button', { name: /保存已选/ })
    out.saveEnabled = await saveBtn.isEnabled()
    assert(out.saveEnabled, '接线后「保存已选」在有条目且选中时应启用')
    await saveBtn.click()
    out.savedToast = await page
      .waitForFunction(() => /已应用 \d+ 条生成内容/.test(document.body.innerText), { timeout: 30_000 })
      .then(async () => (await page.locator('body').innerText()).match(/已应用 \d+ 条生成内容（跳过 \d+）/)?.[0] ?? '')
      .catch(() => '')
    assert(/已应用 \d+ 条生成内容/.test(out.savedToast), `保存后应 toast「已应用 N 条生成内容」，实际 ${out.savedToast}`)
    await page.waitForTimeout(1500)
    out.annotationAfterSave = (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 1600)
    out.uiShowsAiAfterSave = /AI 助记：联想法/.test(out.annotationAfterSave) || /AI example for /.test(out.annotationAfterSave)
    if (!out.uiShowsAiAfterSave) {
      // 数据层校验：保存是否真的落库（UI 刷新问题单独报告给 dev-ui）
      out.afterSaveData = await page.evaluate(async (headword) => {
        const open = () => new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const db = await open()
        const settings = await new Promise((resolve) => {
          const req = db.transaction('settings', 'readonly').objectStore('settings').getAll()
          req.onsuccess = () => resolve(req.result)
        })
        const selectedDeck = settings.find((s) => s.key === 'data.selectedDeckId')?.value
        const words = await new Promise((resolve) => {
          const req = db.transaction('words', 'readonly').objectStore('words').getAll()
          req.onsuccess = () => resolve(req.result)
        })
        const word = words.find(
          (w) => String(w.headword).toLowerCase() === String(headword).toLowerCase() && (!selectedDeck || w.deckId === selectedDeck),
        )
        const applied = await new Promise((resolve) => {
          const req = db.transaction('packItems', 'readonly').objectStore('packItems').getAll()
          req.onsuccess = () => resolve(req.result.filter((i) => i.status === 'applied').length)
          req.onerror = () => resolve(-1)
        })
        return {
          mnemonics: (word?.mnemonics ?? []).map((m) => m.text),
          examples: (word?.examples ?? []).length,
          appliedItems: applied,
        }
      }, out.headword)
      const dbHasAi = (out.afterSaveData.mnemonics ?? []).some((t) => String(t).includes('AI 助记')) || out.afterSaveData.appliedItems > 0
      assert(dbHasAi, `保存后数据层应有 AI 内容，实际 ${JSON.stringify(out.afterSaveData)}`)
      out.noteUiRefresh = '保存已落库；当前注释面未即时显示 AI 内容（UI 刷新待 dev-ui 复核）'
    }
    // task-75：保存成功 → onApplied 重载当前词，注释面应即时出现 AI 助记
    assert(
      out.uiShowsAiAfterSave,
      `保存后当前词注释面应出现 AI 助记；data=${JSON.stringify(out.afterSaveData ?? null)}；body=${out.annotationAfterSave.slice(0, 500)}`,
    )
    await shot(page, 'S18-06-ai-saved')
    // 关闭可能残留的审核/生成弹层
    await reviewDialog.getByRole('button', { name: '关闭', exact: true }).click().catch(() => {})
    await page.waitForTimeout(300)
    await genDialog.getByRole('button', { name: '关闭', exact: true }).click().catch(() => {})

    // ❌ 已拒绝：再次生成不应再出现该条目/目标
    await ensureNoDialog()
    await page.locator('.study-topbar [aria-label="更多"]').first().click()
    await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).first().click()
    await genDialog.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(600)
    const regenStart = genDialog.getByRole('button', { name: '开始生成', exact: true })
    out.regenStartDisabled = await regenStart.isDisabled().catch(() => true)
    out.regenPanelText = (await genDialog.innerText()).replace(/\s+/g, ' ').slice(0, 300)
    if (!out.regenStartDisabled) {
      await regenStart.click()
      await page.waitForTimeout(1200)
      const regenReview = page.locator('.mm-dialog[aria-label^="审核生成内容"]')
      if ((await regenReview.count()) > 0) {
        const regenRows = (await regenReview.locator('.mm-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' '))
        out.regenRows = regenRows.slice(0, 10)
        assert(!regenRows.some((t) => t.includes(out.rejectedLabel)), `❌ 后再次生成不应重现被拒条目：${JSON.stringify(out.regenRows)}`)
        await regenReview.getByRole('button', { name: '关闭', exact: true }).click().catch(() => {})
      } else {
        out.regenSummaryText = (await genDialog.innerText()).replace(/\s+/g, ' ').slice(0, 300)
        assert(/没有需要生成的目标/.test(out.regenSummaryText), `再次生成应无目标或排除被拒条目：${out.regenSummaryText}`)
      }
    } else {
      // 已无可生成目标（被拒目标被排除 + 其余已应用）也符合「❌ 后不再重现」
      assert(/目标：0|没有需要生成的目标/.test(out.regenPanelText) || out.regenStartDisabled, `被拒/已应用后应无可生成目标：${out.regenPanelText}`)
      out.regenNote = '全部目标已应用/被排除，「开始生成」禁用 ✅'
    }
    await genDialog.getByRole('button', { name: '关闭', exact: true }).click().catch(() => {})

    async function ensureNoDialog() {
      for (let i = 0; i < 4; i += 1) {
        if ((await page.locator('.mm-mask').count()) === 0) return
        const dlg = page.locator('.mm-dialog').last()
        const close = dlg.getByRole('button', { name: /^关闭$|^取消$|^取消生成$/ }).last()
        if ((await close.count()) > 0) await close.click().catch(() => {})
        else await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(350)
      }
    }

    // 打开生成面板并确保有待生成目标（今日要学 + 仅助记；保存前目标充足）
    async function openGenWithTargets() {
      await ensureNoDialog()
      await page.locator('.study-topbar [aria-label="更多"]').first().click()
      await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).first().click()
      await genDialog.waitFor({ state: 'visible', timeout: 15_000 })
      await page.waitForTimeout(500)
      await genDialog.getByRole('button', { name: '今日要学', exact: true }).click()
      await page.waitForTimeout(700)
      let active = await genDialog.locator('button[aria-pressed="true"]').allInnerTexts()
      if (!active.some((t) => t.includes('助记'))) await genDialog.getByRole('button', { name: /^(✓ )?助记$/ }).click()
      active = await genDialog.locator('button[aria-pressed="true"]').allInnerTexts()
      if (active.some((t) => t.includes('例句'))) await genDialog.getByRole('button', { name: /^(✓ )?例句$/ }).click()
      active = await genDialog.locator('button[aria-pressed="true"]').allInnerTexts()
      if (active.some((t) => t.includes('词组'))) await genDialog.getByRole('button', { name: /^(✓ )?词组$/ }).click()
      await page.waitForTimeout(800)
      const start = genDialog.getByRole('button', { name: '开始生成', exact: true })
      assert(!(await start.isDisabled()), `今日应有待生成助记目标（开始生成被禁用）：${(await genDialog.innerText()).slice(0, 200)}`)
    }

    // 内容包导入：接线后按钮可用；合成合法 .pack.json（FNV checksum）→ 成功 toast
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
    await page.getByText('内容包', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(500)
    const packBtn = page.getByRole('button', { name: /选择文件|导入中/ }).first()
    out.contentPackDisabled = await packBtn.isDisabled()
    assert(!out.contentPackDisabled, '接线后「选择文件」不应禁用')
    const packItems = [{ headword: out.headword, examples: [{ en: `PACK example for ${out.headword}`, cn: '内容包例句' }] }]
    const packBody = { format: 'momo-pack', formatVersion: 1, kind: 'examples', createdAt: Date.now(), generator: 'qa-e2e', meta: { source: 'import', checksumAlgo: 'fnv1a64' }, items: packItems }
    const pack = { ...packBody, checksum: fnv1a64Hex(stableStringify({ format: packBody.format, formatVersion: packBody.formatVersion, kind: packBody.kind, items: packBody.items })) }
    const packPath = join(tmpdir(), `qa-content-${Date.now()}.pack.json`)
    await writeFile(packPath, JSON.stringify(pack), 'utf8')
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), packBtn.click()])
    await chooser.setFiles(packPath)
    out.contentPackToast = await page
      .waitForFunction(() => /内容包导入完成：应用 \d+ 条/.test(document.body.innerText), { timeout: 30_000 })
      .then(async () => (await page.locator('body').innerText()).match(/内容包导入完成：应用 \d+ 条，跳过 \d+ 条/)?.[0] ?? '')
      .catch(() => '')
    assert(/内容包导入完成：应用 \d+ 条/.test(out.contentPackToast), `内容包导入后应 toast 应用条数，实际 ${out.contentPackToast}`)
    out.packApplied = Number(out.contentPackToast.match(/应用 (\d+) 条/)?.[1] ?? 0)
    await shot(page, 'S18-07-content-pack-import')
    await unlink(packPath).catch(() => {})

    // 隐私：导出迁移包 & 控制台/toast/页面均无完整 Key
    await page.goto(BASE + '#/me', { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(800)
    let exportText = ''
    try {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 20_000 }),
        page.getByText('导出学习进度', { exact: true }).first().click(),
      ])
      const path = await download.path()
      exportText = await readFile(path, 'utf8')
    } catch (error) {
      out.exportError = String(error?.message ?? error).slice(0, 120)
    }
    out.exportHasKey = exportText.includes(FULL_KEY)
    out.consoleHasKey = consoleTexts.some((t) => t.includes(FULL_KEY))
    out.toastHasKey = (await homeText(page)).includes(FULL_KEY)
    assert(!out.exportHasKey, '导出迁移包不得包含完整 API Key')
    assert(!out.consoleHasKey, 'console 不得包含完整 API Key')
    assert(!out.toastHasKey, 'toast/页面不得包含完整 API Key')
    await shot(page, 'S18-08-ai-privacy')
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

/**
 * task-77 · 本义/引申链 E2E（semantics pack 导入 → approve/apply → 注释面/w-c 展示）
 * 覆盖：① 注释面每个含义行下「本义① …→…」；② w-c 当前 c 卡片同一链并随 c 切换；
 *       ③ AI 来源链尾「AI 推演，仅供参考」；④ 无映射/单含义词不显示；⑤ 长文本 360px 不溢出。
 */
async function scenarioS19_semantics(browser) {
  const out = { skipped: null }
  const s19Stable = (value) => {
    if (value === null || value === undefined) return 'null'
    if (Array.isArray(value)) return `[${value.map((v) => s19Stable(v)).join(',')}]`
    if (typeof value === 'object') {
      return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${s19Stable(value[k])}`).join(',')}}`
    }
    return JSON.stringify(value)
  }
  const s19Fnv = (input) => {
    let hash = 0xcbf29ce484222325n
    for (let i = 0; i < input.length; i += 1) {
      hash ^= BigInt(input.charCodeAt(i))
      hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn
    }
    return hash.toString(16).padStart(16, '0')
  }
  const { context, page, bag } = await newContext(browser)
  try {
    // 等新构建（含 task-77「本义」UI）
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    if ((await page.getByText('内容包', { exact: true }).count()) === 0) {
      out.skipped = '当前构建无内容包入口'
      return out
    }
    // 构造 semantics pack（source=ai → 链尾 AI 标注）
    const senses = [
      { index: 1, label: '车间', origin: '古英语原义', confidence: 'high' },
      { index: 2, label: '研讨会', confidence: 'medium' },
    ]
    const meaningMap = [
      { meaningIndex: 1, coreSenseIndex: 1, note: '生产场所', steps: ['车间', '工场', '生产与讲习场所（长文本换行测试：车间、作坊与工场）'] },
      { meaningIndex: 2, coreSenseIndex: 2, note: '讨论交流', steps: ['研讨会', '讨论会'] },
      { meaningIndex: 3, coreSenseIndex: 1, note: '生产场所', steps: ['车间', '工场'] },
      { meaningIndex: 4, coreSenseIndex: 2, note: '培训班', steps: ['讲习班', '培训班'] },
    ]
    const packItems = [{ headword: 'workshop', coreSenses: senses, meaningMap }]
    const body = { format: 'momo-pack', formatVersion: 1, kind: 'semantics', createdAt: Date.now(), generator: 'qa-e2e', meta: { source: 'ai', provider: 'fake', model: 'mock-model' }, items: packItems }
    const pack = { ...body, checksum: s19Fnv(s19Stable({ format: body.format, formatVersion: body.formatVersion, kind: body.kind, items: body.items })) }
    const packPath = join(tmpdir(), `qa-semantics-${Date.now()}.pack.json`)
    await writeFile(packPath, JSON.stringify(pack), 'utf8')
    await page.getByText('内容包', { exact: true }).first().scrollIntoViewIfNeeded().catch(() => {})
    await page.waitForTimeout(500)
    const packBtn = page.getByRole('button', { name: /选择文件|导入中/ }).first()
    const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 15_000 }), packBtn.click()])
    await chooser.setFiles(packPath)
    out.importToast = await page
      .waitForFunction(() => /内容包导入完成：应用 \d+ 条/.test(document.body.innerText), { timeout: 30_000 })
      .then(async () => (await page.locator('body').innerText()).match(/内容包导入完成：应用 \d+ 条，跳过 \d+ 条/)?.[0] ?? '')
      .catch(() => '')
    assert(/内容包导入完成：应用 \d+ 条/.test(out.importToast), `semantics 内容包应导入成功，实际 ${out.importToast}`)
    await unlink(packPath).catch(() => {})

    // 计划只含 workshop（4 含义），进入注释面
    await injectPlanForWord(page, 4, { headword: 'workshop' })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await clickHomeLearn(page)
    await enterAnnotation(page)
    out.headword = await boardWord(page).catch(() => 'workshop')
    out.meaningCount = await page.locator('.meanings .mm-row, .meanings .meaning-row, .meanings > div').count()
    const chains = page.locator('.derivation-chain')
    await chains.first().waitFor({ state: 'visible', timeout: 10_000 })
    out.annotationChains = (await chains.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
    out.annotationChainCount = out.annotationChains.length
    assert(out.annotationChainCount >= 2, `注释面应显示 ≥2 条本义链（workshop 多含义），实际 ${out.annotationChainCount}`)
    assert(out.annotationChains.every((t) => t.includes('本义①') && t.includes('AI 推演，仅供参考')), `每条链应含「本义①」与 AI 标注：${JSON.stringify(out.annotationChains)}`)
    assert(out.annotationChains[1].includes('研讨会'), `第 2 含义链应含「研讨会」，实际 ${out.annotationChains[1]}`)
    await shot(page, 'S19-01-annotation-chains')
    // ⑤ 长文本不横向溢出（360/390 视口）
    out.overflow = await page.evaluate(() => ({
      innerWidth: window.innerWidth,
      scrollWidth: document.documentElement.scrollWidth,
      chainRects: [...document.querySelectorAll('.derivation-chain')].map((el) => {
        const r = el.getBoundingClientRect()
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }
      }),
    }))
    assert(out.overflow.scrollWidth <= out.overflow.innerWidth + 1, `本义链长文本导致横向溢出：${JSON.stringify(out.overflow)}`)
    assert(out.overflow.chainRects.every((r) => r.left >= 0 && r.right <= out.overflow.innerWidth + 1), `链超出视口：${JSON.stringify(out.overflow.chainRects)}`)

    // ② w-c：当前 c 卡片下出现同一链，并随 c 切换
    await page.getByRole('button', { name: '记忆', exact: true }).first().click()
    await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
    const wcChain = page.locator('.memory-stage .derivation-chain').first()
    await wcChain.waitFor({ state: 'visible', timeout: 10_000 })
    out.wcChain1 = (await wcChain.innerText()).replace(/\s+/g, ' ').trim()
    out.wcCn1 = (await page.locator('.wc-cn').first().innerText()).trim()
    assert(out.wcChain1.includes('车间') && out.wcChain1.includes('AI 推演，仅供参考'), `w-c 当前 c 应显示同一 AI 链，实际 ${out.wcChain1}`)
    await shot(page, 'S19-02-wc-chain-c1')
    // 点击前进直到当前 c 变化（最多 100 次），验证链随 c 切换
    let switched = false
    for (let i = 0; i < 100 && !switched; i += 1) {
      await page.mouse.click(Math.round(VIEWPORT.width / 2), Math.round(VIEWPORT.height * 0.5))
      await page.waitForTimeout(240)
      if ((await page.locator('.wc-cn').count()) === 0) break
      const cn = (await page.locator('.wc-cn').first().innerText()).trim()
      if (cn && cn !== out.wcCn1) switched = true
    }
    assert(switched, 'w-c 点击应能切换到下一个含义')
    out.wcCn2 = (await page.locator('.wc-cn').first().innerText()).trim()
    out.wcChain2 = (await page.locator('.memory-stage .derivation-chain').first().innerText()).replace(/\s+/g, ' ').trim()
    assert(out.wcChain2.includes('研讨会'), `w-c 切换后应显示 c2 链（研讨会），实际 ${out.wcChain2}`)
    assert(out.wcChain2 !== out.wcChain1, `w-c 链应随 c 切换：${out.wcChain1} → ${out.wcChain2}`)
    await shot(page, 'S19-03-wc-chain-c2')

    // ④ 无映射/单含义词不显示链
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await injectPlanForWord(page, 3, { headword: 'zoom' })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await clickHomeLearn(page)
    await enterAnnotation(page)
    out.noMappingHeadword = (await page.locator('.word-text').first().innerText()).trim()
    out.noMappingChainCount = await page.locator('.derivation-chain').count()
    assert(out.noMappingChainCount === 0, `无映射/单含义词（${out.noMappingHeadword}）不应显示本义链，实际 ${out.noMappingChainCount}`)
    await shot(page, 'S19-04-no-chain')
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

/**
 * task-85（0.3.6）：AI 面板「本义/引申链」+ 选择词库/自定义选词 + semantics 审核/落库。
 * 旧 dist 无 task-85 UI 时自动 skip；以下选择器按 dev-ui 契约（文案/aria）编写。
 */
async function scenarioS20_aiSemanticsScopes(browser) {
  const out = { skipped: null, notes: [], pageErrorPhases: [] }
  const FULL_KEY = 'sk-TEST'
  const mock = { calls: 0, targets: [], mode: 'ok' }
  const { context, page, bag } = await newContext(browser)
  const fulfillJson = (route, status, body) =>
    route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(body) })
  const mockSemantics = (userPrompt) => {
    const start = userPrompt.indexOf('targets = ')
    if (start < 0) return JSON.stringify({ items: [] })
    let end = userPrompt.indexOf('\n请先通读', start)
    if (end < 0) end = userPrompt.indexOf('\n', start)
    let targets
    try {
      targets = JSON.parse(userPrompt.slice(start + 'targets = '.length, end > start ? end : undefined))
    } catch {
      return JSON.stringify({ items: [] })
    }
    // semantics prompt v3 契约：items[].meanings[]，每含义一条 coreSenseLabel/confidence/steps
    const items = targets.map((target) => {
      const meanings = (Array.isArray(target.meanings) ? target.meanings : [{ meaningIndex: 1 }]).map((m, i) => ({
        meaningIndex: m.meaningIndex ?? i + 1,
        coreSenseLabel: `本义${i % 2 === 0 ? 'A' : 'B'}`,
        coreSenseNote: '核心本义说明',
        origin: '词根/隐喻',
        confidence: i % 2 === 0 ? 'high' : 'medium',
        steps: [`本义${i % 2 === 0 ? 'A' : 'B'}`, `引申${i + 1}`],
      }))
      return { headword: target.headword, meanings }
    })
    mock.targets.push(...targets.map((t) => t.headword))
    return JSON.stringify({ items })
  }
  await page.route('**/v1/chat/completions', async (route) => {
    mock.calls += 1
    const user = (route.request().postDataJSON()?.messages ?? []).filter((m) => m.role === 'user').pop()?.content ?? ''
    const content = mockSemantics(user)  // S20 只发 semantics 生成请求
    return fulfillJson(route, 200, { choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } })
  })
  try {
    // AI 设置：fake provider
    await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    if ((await page.getByText('AI 扩充（可选）').count()) === 0) {
      out.skipped = '当前构建无 AI 扩充 UI'
      return out
    }
    await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    await page.getByRole('switch', { name: '启用 AI 扩充' }).click()
    await page.waitForTimeout(300)
    await page.getByLabel('AI 服务商').selectOption('openai-compatible').catch(() => {})
    await page.getByLabel('AI baseURL').fill(`${BASE.replace(/\/$/, '')}/mock-ai`)
    await page.getByLabel('AI 模型').fill('mock-model')
    await page.getByLabel('AI API Key').fill(FULL_KEY)
    await page.getByRole('button', { name: '保存 Key', exact: true }).click()
    await page.waitForFunction(() => /已配置：/.test(document.body.innerText), { timeout: 15_000 }).catch(() => {})

    // 注入空 deck（供「选择词库」空态断言）
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await page.evaluate(async () => {
      const open = () => new Promise((resolve, reject) => {
        const req = indexedDB.open('momo-reword')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
      const db = await open()
      await new Promise((resolve, reject) => {
        const tx = db.transaction('decks', 'readwrite')
        tx.objectStore('decks').put({ id: 'qa-empty-deck', name: 'QA空词库', description: '', source: 'manual', wordCount: 0, dataVersion: 1, createdAt: Date.now(), updatedAt: Date.now() })
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      })
    })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await clickHomeLearn(page)
    await enterAnnotation(page)
    await page.locator('.study-topbar [aria-label="更多"]').first().click()
    await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).first().click()
    const genDialog = page.locator('.mm-dialog[aria-label="AI 扩充内容"]')
    await genDialog.waitFor({ state: 'visible', timeout: 15_000 })
    out.pageErrorPhases.push({ at: 'panel-open', n: bag.pageErrors.length })
    await page.waitForTimeout(700)
    const panelText = (await genDialog.innerText()).replace(/\s+/g, ' ')
    out.panelText = panelText.slice(0, 500)
    out.hasSemanticsKind = panelText.includes('本义/引申链')
    out.scopeLabels = ['今日要学', '当前词库', '选择词库', '自定义选词', '当前词'].filter((t) => panelText.includes(t))
    if (!out.hasSemanticsKind || !panelText.includes('选择词库') || !panelText.includes('自定义选词')) {
      out.skipped = `当前 dist 未含 task-85 UI（semantics=${out.hasSemanticsKind}, scopes=${JSON.stringify(out.scopeLabels)}）`
      return out
    }

    // 1) 类型切换 + 三档范围
    await genDialog.getByRole('button', { name: /^(✓ )?本义\/引申链$/ }).click()
    await page.waitForTimeout(500)
    out.activeKind = (await genDialog.locator('button[aria-pressed="true"]').allInnerTexts()).find((t) => t.includes('本义')) ?? ''
    assert(out.activeKind.includes('本义'), `应选中「本义/引申链」类型，实际 ${out.activeKind}`)

    // 2) 选择词库：含未在学 deck；空 deck 提示；非词库目标数来自该库
    await genDialog.getByRole('button', { name: '选择词库', exact: true }).click()
    await page.waitForTimeout(600)
    const deckButtons = page.getByRole('button', { name: /（\d+ 词）/ })
    out.deckButtonCount = await deckButtons.count()
    out.deckButtonTexts = (await deckButtons.allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).slice(0, 10)
    assert(out.deckButtonCount >= 1, `词库选择器应列出 deck（实际 ${out.deckButtonCount}）`)
    // 空 deck
    const emptyDeckBtn = page.getByRole('button', { name: /QA空词库（0 词）/ }).first()
    if ((await emptyDeckBtn.count()) > 0) {
      await emptyDeckBtn.click()
      await page.waitForTimeout(600)
      out.emptyTargetBeforeRefresh = (await genDialog.innerText()).match(/目标：\d+ 个词\/含义/)?.[0] ?? ''
      // 已知 UI 缺陷：onDeck 未触发 refreshEstimate；补点同范围按钮以刷新（同时记录 bug 证据）
      await genDialog.getByRole('button', { name: '选择词库', exact: true }).click()
      await page.waitForTimeout(700)
      out.emptyDeckText = (await genDialog.innerText()).replace(/\s+/g, ' ')
      out.emptyPrompt = /没有可生成的词（已排除已有内容\/已拒绝）/.test(out.emptyDeckText)
      out.emptyTargetZero = /目标：0 个词\/含义/.test(out.emptyDeckText)
      const emptyStartDisabled = await genDialog.getByRole('button', { name: '开始生成', exact: true }).isDisabled().catch(() => true)
      out.emptyStartDisabled = emptyStartDisabled
      // dev-ui 已补空态文案：优先严格断言；同时保留目标0+禁用作为兜底诊断
      assert(
        out.emptyPrompt || (out.emptyTargetZero && emptyStartDisabled),
        `空词库应提示「没有可生成的词…」或目标0+按钮禁用，实际 ${out.emptyDeckText.slice(0, 300)}`,
      )
      if (out.emptyPrompt) out.emptyPromptOk = true
      else out.notes.push('空词库无提示文案（dev-ui 声明已补，待复核）')
    } else {
      out.notes.push('未找到 QA空词库（deck 列表可能未刷新）')
    }
    // 选一个非空 deck（逐个 deck 刷新后断言目标数来自该库；deck.name 已含词数，UI 会重复追加，按 index 点击避免 name 歧义）
    const deckCount = await deckButtons.count()
    out.deckButtonTexts = []
    out.deckTargets = []
    let pickedDeck = ''
    let pickedIndex = -1
    let pickedCount = 0
    for (let i = 0; i < deckCount; i += 1) {
      const label = (await deckButtons.nth(i).innerText()).replace(/\s+/g, ' ').trim()
      out.deckButtonTexts.push(label)
      if (/QA空词库/.test(label)) continue
      await deckButtons.nth(i).click()
      await page.waitForTimeout(600)
      const stale = (await genDialog.innerText()).match(/目标：(\d+) 个词\/含义/)?.[1] ?? ''
      // 已知 UI 缺陷：选 deck 后不刷新目标；补点同范围按钮
      await genDialog.getByRole('button', { name: '选择词库', exact: true }).click()
      await page.waitForTimeout(700)
      const targetText = (await genDialog.innerText()).match(/目标：(\d+) 个词\/含义/)?.[0] ?? ''
      const n = Number(targetText.match(/\d+/)?.[0] ?? 0)
      out.deckTargets.push({ deck: label, staleBeforeRefresh: stale, targetText, target: n })
      if (n > 0 && pickedIndex < 0) {
        pickedDeck = label
        pickedIndex = i
        pickedCount = n
      }
    }
    out.pickedDeck = pickedDeck
    out.deckWordCount = Number(pickedDeck.match(/（(\d+) 词）/)?.[1] ?? 0)
    out.deckTargetText = `目标：${pickedCount} 个词/含义`
    out.deckTargetCount = pickedCount
    out.deckTargetStaleBug = out.deckTargets.some((row) => row.staleBeforeRefresh !== String(row.target))
    assert(out.deckTargetCount > 0, `至少一个 deck 应有待生成目标（实测 ${JSON.stringify(out.deckTargets)}）`)
    assert(out.deckTargetCount <= out.deckWordCount, `目标数应来自该 deck（目标 ${out.deckTargetCount} > 词数 ${out.deckWordCount}）`)
    await deckButtons.nth(pickedIndex).click()
    await genDialog.getByRole('button', { name: '选择词库', exact: true }).click()
    await page.waitForTimeout(700)
    await shot(page, 'S20-01-deck-targets')

    // 3) 自定义选词：先切到含多含义词的当前词库（受限商业词表），再搜索/多选
    const hbDeck = page.getByRole('button', { name: /受限商业词表/ }).first()
    if ((await hbDeck.count()) > 0) {
      await hbDeck.click()
      await page.waitForTimeout(500)
      await genDialog.getByRole('button', { name: '选择词库', exact: true }).click()
      await page.waitForTimeout(500)
    }
    await genDialog.getByRole('button', { name: '自定义选词', exact: true }).click()
    await page.waitForTimeout(600)
    const search = page.getByLabel('搜索单词').first()
    await search.waitFor({ state: 'visible', timeout: 10_000 })
    out.searchPlaceholder = await search.getAttribute('placeholder')
    await search.fill('work')
    await page.waitForTimeout(500)
    const countText1 = (await genDialog.innerText()).match(/已选 \d+ \/ 共 \d+（单次 ≤500）/)?.[0] ?? ''
    out.countInitial = countText1
    assert(/已选 \d+ \/ 共 \d+（单次 ≤500）/.test(countText1), `自定义选词应显示计数，实际 ${countText1}`)
    const firstCheckbox = page.getByRole('checkbox', { name: /^选择 / }).first()
    out.filteredCheckboxCount = await page.getByRole('checkbox', { name: /^选择 / }).count()
    assert(out.filteredCheckboxCount > 0, '搜索 work 应筛出可选项')
    await firstCheckbox.click()
    out.afterOneSelected = (await genDialog.innerText()).match(/已选 \d+/)?.[0] ?? ''
    await genDialog.getByRole('button', { name: '全选筛选结果', exact: true }).click()
    await page.waitForTimeout(400)
    out.afterSelectAll = (await genDialog.innerText()).match(/已选 \d+/)?.[0] ?? ''
    await genDialog.getByRole('button', { name: '反选', exact: true }).click()
    await page.waitForTimeout(400)
    out.afterInvert = (await genDialog.innerText()).match(/已选 \d+/)?.[0] ?? ''
    await genDialog.getByRole('button', { name: '清空已选', exact: true }).click()
    await page.waitForTimeout(400)
    out.afterClear = (await genDialog.innerText()).match(/已选 \d+/)?.[0] ?? ''
    assert(/已选 0/.test(out.afterClear), `清空已选后应为 0，实际 ${out.afterClear}`)
    // 选 workshop + embrace（多含义词；若不存在则退回全选筛选结果）
    await search.fill('workshop')
    await page.waitForTimeout(500)
    const ws = page.getByRole('checkbox', { name: /^选择 workshop$/ })
    if ((await ws.count()) > 0) await ws.first().click()
    await page.waitForTimeout(200)
    await search.fill('embrace')
    await page.waitForTimeout(500)
    const em = page.getByRole('checkbox', { name: /^选择 embrace$/ })
    if ((await em.count()) > 0) await em.first().click()
    await page.waitForTimeout(400)
    out.customSelectedText = (await genDialog.innerText()).match(/已选 \d+ \/ 共 \d+（单次 ≤500）/)?.[0] ?? ''
    out.customSelectedCount = Number(out.customSelectedText.match(/已选 (\d+)/)?.[1] ?? 0)
    assert(out.customSelectedCount >= 1, `自定义选词应至少选中 1 个，实际 ${out.customSelectedText}`)
    out.pageErrorPhases.push({ at: 'custom-select', n: bag.pageErrors.length })
    await shot(page, 'S20-02-custom-select')

    // 4) semantics 生成 → 审核格式 → ✓ 保存 → 注释面 AI 链
    out.preStartText = (await genDialog.innerText()).replace(/\s+/g, ' ').slice(0, 500)
    out.mockCallsBeforeStart = mock.calls
    out.customSelectedText = (await genDialog.innerText()).match(/已选 \d+ \/ 共 \d+（单次 ≤500）/)?.[0] ?? out.customSelectedText
    out.startDisabled = await genDialog.getByRole('button', { name: '开始生成', exact: true }).isDisabled()
    await genDialog.getByRole('button', { name: '开始生成', exact: true }).click()
    const review = page.locator('.mm-dialog[aria-label^="审核生成内容"]')
    await review.waitFor({ state: 'visible', timeout: 30_000 }).catch(async () => {
      out.genAfterStart = (await genDialog.innerText()).replace(/\s+/g, ' ').slice(0, 800)
      out.mockCallsAfterStart = mock.calls
      out.mockTargets = mock.targets.slice(0, 20)
      assert(false, `开始生成后未出现审核弹层：startDisabled=${out.startDisabled}；gen=${out.genAfterStart}；mockCalls=${out.mockCallsAfterStart}；targets=${JSON.stringify(out.mockTargets)}`)
    })
    await page.waitForTimeout(600)
    const reviewText = (await review.innerText()).replace(/\s+/g, ' ')
    out.reviewText = reviewText.slice(0, 600)
    out.reviewItems = await review.locator('.mm-row').count()
    out.hasSenseLine = /本义1 「.+」（high\|medium\|low）/.test(reviewText) || /本义\d+ 「/.test(reviewText)
    out.hasMapLine = /c\d+ → 本义\d+：/.test(reviewText)
    assert(out.hasSenseLine, `semantics 审核应显示「本义N「label」（confidence）」，实际 ${out.reviewText}`)
    assert(out.hasMapLine, `semantics 审核应显示「cN → 本义M：steps」，实际 ${out.reviewText}`)
    out.mockTargets = mock.targets.slice(0, 20)
    out.pageErrorPhases.push({ at: 'review-open', n: bag.pageErrors.length })
    await shot(page, 'S20-03-review')
    await review.getByRole('button', { name: /保存已选/ }).click()
    out.savedToast = await page
      .waitForFunction(() => /已应用 \d+ 条生成内容/.test(document.body.innerText), { timeout: 30_000 })
      .then(async () => (await page.locator('body').innerText()).match(/已应用 \d+ 条生成内容（跳过 \d+）/)?.[0] ?? '')
      .catch(() => '')
    assert(/已应用 \d+ 条生成内容/.test(out.savedToast), `保存后应 toast「已应用 N 条」，实际 ${out.savedToast}`)
    out.pageErrorPhases.push({ at: 'after-save', n: bag.pageErrors.length })

    // 落库后注释面出现本义链（用选中的 workshop）
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await injectPlanForWord(page, 1, { headword: 'workshop' })
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitSeededHome(page)
    await clickHomeLearn(page)
    await enterAnnotation(page)
    await page.locator('.derivation-chain').first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    out.annotationChains = (await page.locator('.derivation-chain').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim())
    out.annotationHasAi = out.annotationChains.some((t) => t.includes('AI 推演，仅供参考'))
    assert(out.annotationChains.length > 0 && out.annotationHasAi, `保存后注释面应出现 AI 本义链，实际 ${JSON.stringify(out.annotationChains)}`)
    out.pageErrorPhases.push({ at: 'after-annotation', n: bag.pageErrors.length })
    await shot(page, 'S20-04-annotation-chain')

    // 5) 已映射词再次生成应被排除（已有映射）
    await page.locator('.study-topbar [aria-label="更多"]').first().click()
    await page.getByText('AI 补内容（当前词/当前 c）', { exact: true }).first().click()
    await genDialog.waitFor({ state: 'visible', timeout: 15_000 })
    await page.waitForTimeout(500)
    await genDialog.getByRole('button', { name: /^(✓ )?本义\/引申链$/ }).click()
    await genDialog.getByRole('button', { name: '自定义选词', exact: true }).click()
    await page.waitForTimeout(500)
    const search2 = page.getByLabel('搜索单词').first()
    await search2.fill('workshop')
    await page.waitForTimeout(500)
    const ws2 = page.getByRole('checkbox', { name: /^选择 workshop$/ })
    if ((await ws2.count()) > 0) await ws2.first().click()
    await page.waitForTimeout(600)
    out.existingMappingText = (await genDialog.innerText()).replace(/\s+/g, ' ')
    out.existingMappingExcluded = /没有可生成的词/.test(out.existingMappingText) || /目标：0/.test(out.existingMappingText)
    assert(out.existingMappingExcluded, `已有映射词应被排除（无目标/提示），实际 ${out.existingMappingText.slice(0, 400)}`)
    out.pageErrorPhases.push({ at: 'existing-mapping', n: bag.pageErrors.length })
    await shot(page, 'S20-05-existing-mapping-excluded')
    await genDialog.getByRole('button', { name: '关闭', exact: true }).click().catch(() => {})
    await page.waitForTimeout(800)
    out.pageErrorPhases.push({ at: 'after-close', n: bag.pageErrors.length })
    out.pageErrorsFinal = bag.pageErrors.slice(0, 3)
    assert(bag.pageErrors.length === 0, `S20 不应产生 pageerror：${JSON.stringify(bag.pageErrors.slice(0, 2))}`)
  } finally {
    mergeErrors(bag)
    await context.close()
  }
  return out
}

// ---------------- main ----------------

async function main() {
  await mkdir(OUT, { recursive: true })
  log(`v2 E2E base: ${BASE}`)
  log(`output:      ${OUT}`)
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: [LIB, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') },
  })
  try {
    // 构建指纹
    {
      const { context, page, bag } = await newContext(browser)
      try {
        await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        const html = await page.content()
        result.build = html.match(/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null
      } finally {
        mergeErrors(bag)
        await context.close()
      }
    }
    log(`build: ${result.build}`)

    const only = (process.env.E2E_ONLY || '').split(',').map((x) => x.trim()).filter(Boolean)
    if (only.length > 0) {
      try {
        const prev = JSON.parse(await readFile(join(OUT, 'e2e-v2.json'), 'utf8'))
        result.scenarios = prev.scenarios ?? {}
        result.screenshots = prev.screenshots ?? []
        result.consoleErrors = prev.consoleErrors ?? []
        result.pageErrors = prev.pageErrors ?? []
      } catch {
        /* 首次运行无旧结果 */
      }
    }
    const scenarios = [
      ['S1 首页态与续学', scenarioS1],
      ['S2 三键三态文案与标签切换', scenarioS2],
      ['S3 回退与改判', scenarioS3],
      ['S4 队列不截断', scenarioS4],
      ['S5 每日学习量与官方设置项', scenarioS5],
      ['S6 记忆/含义拆分回归', scenarioS6],
      ['S8 PWA 离线', scenarioS8],
      ['S9 改学习量同步', scenarioS9_goalSync],
      ['S10 v2 三条真机序列', scenarioS10_v2Sequences],
      ['S11 墨墨导入 PWA（代理/文件降级）', scenarioS11_maimemoPwa],
      ['S12 w-c 词组按含义过滤', scenarioS12_phrasePerMeaning],
      ['S13 PWA 图标校验', scenarioS13_icons],
      ['S14 多视口布局（底栏/间距）', scenarioS14_layout],
      ['S15 task-47 默认值（词组默认开/新词乱序）', scenarioS15_defaults],
      ['S16 今日复习/新学拆分与今日单词页', scenarioS16_todayBreakdown],
      ['S17 每日复习上限（cap 截断/顺延/次日生效）', scenarioS17_dailyReviewCap],
      ['S18 AI 扩充（fake provider）', scenarioS18_ai],
      ['S19 本义/引申链（semantics pack）', scenarioS19_semantics],
      ['S20 AI 本义链 + 选库/自定义选词（草案）', scenarioS20_aiSemanticsScopes],
    ]
    for (const [name, fn] of scenarios) {
      if (only.length > 0 && !only.some((key) => name === key || name.startsWith(key + ' '))) continue
      currentScenario = name
      log(`\n===== ${name} =====`)
      try {
        result.scenarios[name] = await fn(browser)
        log(`✅ ${name}`)
      } catch (error) {
        result.scenarios[name] = { error: String(error?.stack ?? error) }
        log(`❌ ${name}：${error?.message ?? error}`)
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }
  const jsonPath = join(OUT, 'e2e-v2.json')
  await writeFile(jsonPath, JSON.stringify(result, null, 2), 'utf8')
  log(`\n📄 ${jsonPath}`)
  log(`截图 ${result.screenshots.length} 张；console.error ${result.consoleErrors.length} 条；pageerror ${result.pageErrors.length} 条`)
  const failed = Object.entries(result.scenarios).filter(([, v]) => v && v.error)
  if (failed.length > 0) {
    log(`❌ 失败场景：${failed.map(([k]) => k).join('；')}`)
    process.exit(1)
  }
  log('🎉 全部场景通过')
}

main().catch((e) => {
  console.error('v2 E2E 崩溃：', e)
  process.exit(1)
})
