#!/usr/bin/env node
/**
 * QA task-66 · 公开版 WordC 演示素材（16–20s GIF + 7 张 PNG）
 * 必须用公开构建（4174，默认大纲 deck，无受限商业词表）。
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'

const execFileAsync = promisify(execFile)
const HERE = '/root/workspace/背单词APP开发'
const OUT = join(HERE, 'docs/assets/demo')
const BASE = 'http://127.0.0.1:4174/'
const CHROMIUM = join(HERE, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(HERE, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(HERE, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const W = 390
const H = 844
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHome(page) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const ok = await page.evaluate(async () => {
      const t = document.body.innerText
      if (!(document.querySelectorAll('.mm-kpi').length >= 3 && /待复习/.test(t) && /待新学/.test(t))) return false
      if (!/开始学习|继续学习|查看今日/.test(t)) return false
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const n = await new Promise((resolve) => {
          const req = db.transaction('words', 'readonly').objectStore('words').count()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(0)
        })
        return n > 0
      } catch {
        return false
      }
    })
    if (ok) return
    await page.waitForTimeout(250)
  }
  throw new Error('公开版首页/种子等待超时')
}

/** 公开默认 deck 里选一个词，注入 3 个含义（c1 有词组）与不同不熟悉度底子；不改 deck 名称 */
async function prepare(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await waitHome(page)
  const chosen = await page.evaluate(async () => {
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
    const decks = await new Promise((resolve) => {
      const req = db.transaction('decks', 'readonly').objectStore('decks').getAll()
      req.onsuccess = () => resolve(req.result)
    })
    const deckId = settings.find((s) => s.key === 'data.selectedDeckId')?.value || decks.find((d) => d.isDefault)?.id || decks[0].id
    const words = (await new Promise((resolve) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll()
      req.onsuccess = () => resolve(req.result)
    })).filter((w) => w.deckId === deckId)
    const target = words.find((w) => String(w.headword).toLowerCase() === 'abdomen') ?? words[0]
    const meanings = ['腹部', '下腹', '腹腔'].map((cn, i) => ({ id: `${target.id}#M${i + 1}`, pos: 'n.', cn }))
    const phrases = [
      { en: 'lower abdomen', cn: '小腹；下腹部', meaningId: meanings[0].id },
      { en: 'acute abdomen', cn: '[医]急腹症', meaningId: meanings[0].id },
      { en: 'abdomen in', cn: '收腹' },
    ]
    const now = Date.now()
    const d = new Date(now)
    const pad = (n) => String(n).padStart(2, '0')
    const dateKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const planId = `${dateKey}:${deckId}`
    const meaningStats = Object.fromEntries(meanings.map((m) => [m.id, { clicks: 0, encounters: 9 }]))
    const state = {
      wordId: target.id, deckId, phase: 'new', stability: 1, difficulty: target.difficulty ?? 5,
      reps: 0, lapses: 0, firstSeenAt: null, lastReviewedAt: null, dueAt: null,
      nextIntervalDays: 1, retrievability: 1, lastRating: null, sameDayCount: 0, sameDayDate: '',
      sameDayRequeued: 0, todayProgress: 0, meaningStats, createdAt: now, updatedAt: now,
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['settings', 'plans', 'meta', 'states', 'words'], 'readwrite')
      for (const [key, value] of Object.entries({ 'app.theme': 'dark', 'memory.showPhrases': true })) {
        tx.objectStore('settings').put({ key, value, updatedAt: now })
      }
      tx.objectStore('words').put({ ...target, meanings, phrases })
      tx.objectStore('states').put(state)
      tx.objectStore('plans').put({
        id: planId, date: dateKey, deckId, wordIds: Array(12).fill(target.id), index: 0,
        sources: { [target.id]: 'goal' },
        goals: { dailyGoal: 12, dueCount: 0, newBudget: 12, extraCount: 0 },
        ratings: [], createdAt: now, updatedAt: now, completedAt: null,
      })
      tx.objectStore('meta').put({ key: 'plan.activeId', value: planId, updatedAt: now })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    return { headword: target.headword, deckName: decks.find((d) => d.id === deckId)?.name ?? '', meanings: meanings.map((m) => m.cn) }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitHome(page)
  await sleep(500)
  return chosen
}

async function noPrivateText(page, scene) {
  const text = await page.evaluate(() => document.body.innerText)
  const bad = []
  if (/受限商业词表|6702/.test(text)) bad.push(scene)
  return bad
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, name) })
  console.log(`  📸 ${name}`)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const videoDir = join(tmpdir(), `momo-public-demo-${Date.now()}`)
  await mkdir(videoDir, { recursive: true })
  const browser = await chromium.launch({
    executablePath: CHROMIUM, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: LIB },
  })
  let videoPath = null
  let homeAt = 0
  let t0 = Date.now()
  let chosen = null
  const forbiddenScenes = []
  try {
    const context = await browser.newContext({
      viewport: { width: W, height: H }, locale: 'zh-CN', deviceScaleFactor: 2,
      recordVideo: { dir: videoDir, size: { width: W, height: H } },
    })
    const prep = await context.newPage()
    chosen = await prepare(prep)
    await prep.close()
    t0 = Date.now()
    const page = await context.newPage()
    const video = page.video()
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitHome(page)
    await sleep(500)
    homeAt = Date.now()
    forbiddenScenes.push(...(await noPrivateText(page, 'home')))
    await shot(page, '01-home-kpi.png')

    const tap = () => page.mouse.click(W / 2, Math.round(H * 0.45))
    await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
    await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
    await sleep(800)
    await shot(page, '02-study-board.png')
    await tap()
    await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 20_000 })
    await sleep(400)
    // 逐个点击多个 c：c1×1、c2×4、c3×8，每次 0.35s；最后停 1.2s
    const rows = page.locator('.meaning-row')
    const clickCounts = [1, 4, 8]
    for (let mi = 0; mi < 3; mi += 1) {
      for (let k = 0; k < clickCounts[mi]; k += 1) {
        await rows.nth(mi).click()
        await sleep(350)
      }
      await sleep(180)
    }
    await sleep(1200)
    await shot(page, '03-annotations.png')
    const bars = await page.evaluate(() => Array.from(document.querySelectorAll('.meaning-row')).slice(0, 3).map((row) => (row.innerText || '').replace(/\s+/g, ' ').trim()))
    console.log('  注释面条形:', bars.join(' | '))

    await page.locator('.memory-btn').first().click()
    await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 20_000 })
    await sleep(800)
    await tap() // c1 1/3
    await sleep(450)
    await shot(page, '04-memory-wc.png')
    await sleep(300)
    await tap() // c1 2/3
    await sleep(800)
    await tap() // c1 3/3 → c2
    await sleep(850)
    for (let i = 0; i < 3; i += 1) { await tap(); await sleep(800) } // c2 1/3..3/3
    await sleep(850)
    for (let i = 0; i < 3; i += 1) { await tap(); await sleep(800) } // c3 1/3..3/3
    await sleep(500)
    // 回注释面点认识（让 today/stats 有数据）
    await page.locator('.annotation-stage').first().waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
    if ((await page.locator('.rating-btn--know').count()) > 0) {
      await page.locator('.rating-btn--know').first().click()
      await sleep(700)
    }
    // 录制到此结束（GIF 只含核心流程，保证 16–20s）
    await page.close()
    videoPath = await video.path()

    // 不录制的 page3：拍 05/06/07（GIF 不需要这几屏）
    const page3 = await context.newPage()
    await page3.goto(BASE, { waitUntil: 'domcontentloaded' })
    await waitHome(page3)
    await sleep(500)
    forbiddenScenes.push(...(await noPrivateText(page3, 'home-after')))
    await page3.getByRole('button', { name: '查看今日单词 ›', exact: true }).first().click()
    await page3.locator('.mm-section-band').first().waitFor({ state: 'visible', timeout: 20_000 })
    await sleep(900)
    forbiddenScenes.push(...(await noPrivateText(page3, 'today')))
    await shot(page3, '05-today-words.png')
    await page3.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
    await page3.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
    await page3.locator('.mm-row').filter({ hasText: '每日复习上限' }).first().scrollIntoViewIfNeeded()
    await sleep(800)
    forbiddenScenes.push(...(await noPrivateText(page3, 'settings')))
    await shot(page3, '06-settings.png')
    await page3.goto(BASE + '#/stats', { waitUntil: 'domcontentloaded' })
    await page3.waitForTimeout(1000)
    forbiddenScenes.push(...(await noPrivateText(page3, 'stats')))
    await shot(page3, '07-stats.png')
    await page3.close()
    await context.close()
  } finally {
    await browser.close()
  }
  const files = (await readdir(videoDir)).filter((f) => f.endsWith('.webm'))
  if (!videoPath || files.length === 0) throw new Error('没有录到视频')
  const palette = join(tmpdir(), `momo-public-pal-${Date.now()}.png`)
  const gifPath = join(OUT, 'demo-flow.gif')
  const probe = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', videoPath])
  const totalSec = Number(String(probe.stdout).trim())
  const trimStart = Math.max(0.2, (homeAt - t0) / 1000 - 0.15)
  const flowSec = Math.max(1, totalSec - trimStart)
  const speed = Math.min(1.2, Math.max(0.8, 18.5 / flowSec))
  console.log(`video ${totalSec.toFixed(2)}s trim ${trimStart.toFixed(2)}s flow ${flowSec.toFixed(2)}s speed ${speed.toFixed(2)}`)
  const endSec = Math.max(trimStart + 1, totalSec - 0.9)
  const filter = `trim=start=${trimStart.toFixed(3)}:end=${endSec.toFixed(3)},setpts=${speed.toFixed(3)}*(PTS-STARTPTS),fps=12,scale=360:-1:flags=lanczos`
  await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-vf', `${filter},palettegen=stats_mode=diff:max_colors=128`, palette])
  for (const colors of [128, 96, 64]) {
    await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-i', palette, '-filter_complex',
      `[0:v]${filter}[src];[src][1:v]paletteuse=dither=bayer:bayer_scale=3`, '-loop', '0', gifPath])
    const info = await stat(gifPath)
    console.log(`GIF ${(info.size / 1024).toFixed(0)} KB (palette ${colors})`)
    if (info.size <= 8 * 1024 * 1024) break
    await execFileAsync('ffmpeg', ['-y', '-i', videoPath, '-vf', `${filter},palettegen=stats_mode=diff:max_colors=${colors}`, palette])
  }
  await rm(videoDir, { recursive: true, force: true })
  await rm(palette, { force: true })
  console.log('选词:', chosen.headword, chosen.meanings.join('/'), '| deck:', chosen.deckName)
  console.log('私版字样自检:', forbiddenScenes.length === 0 ? '未见受限商业词表 ✅' : `❌ ${forbiddenScenes.join(',')}`)
  if (forbiddenScenes.length > 0) throw new Error('出现私版字样')
}

await main()
