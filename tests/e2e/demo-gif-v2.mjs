#!/usr/bin/env node
/**
 * QA task-65 · 重做演示 GIF（20–30s、12fps、360 宽、≤8MB）+ 重拍 03/04 截图。
 * 动态选词：≥3 含义、且当前 c（第一个含义）有词组；程序化制造 3 条不同不熟悉度（1/4/8 次）。
 */
import { execFile } from 'node:child_process'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'

const execFileAsync = promisify(execFile)
const HERE = '/root/workspace/背单词APP开发'
const OUT = join(HERE, 'docs/assets/demo')
const BASE = 'http://127.0.0.1:4173/'
const CHROMIUM = join(HERE, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(HERE, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(HERE, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const W = 390
const H = 844
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitHome(page) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    const ready = await page.evaluate(async () => {
      const text = document.body.innerText
      if (!(document.querySelectorAll('.mm-kpi').length >= 3 && /待复习/.test(text) && /待新学/.test(text))) return false
      if (!/开始学习|继续学习|查看今日/.test(text)) return false
      try {
        const db = await new Promise((resolve, reject) => {
          const req = indexedDB.open('momo-reword')
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => reject(req.error)
        })
        const counts = await Promise.all(['decks', 'words'].map((s) => new Promise((resolve) => {
          const req = db.transaction(s, 'readonly').objectStore(s).count()
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(0)
        })))
        return counts[0] >= 1 && counts[1] >= 1
      } catch {
        return false
      }
    })
    if (ready) return
    await page.waitForTimeout(250)
  }
  throw new Error('首页/词库种子等待超时')
}

/** 选词 + 注入 state（3 含义不同不熟悉度）与今日计划 */
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
    const selected = settings.find((s) => s.key === 'data.selectedDeckId')?.value
    const deckId = selected || decks.find((d) => d.isDefault)?.id || decks[0]?.id
    const words = (await new Promise((resolve) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll()
      req.onsuccess = () => resolve(req.result)
    })).filter((w) => w.deckId === deckId)
    // 优先：≥3 含义，且 meanings[0] 有 meaningId 词组；退而求其次：≥3 含义且有任意词组
    const strong = words.find((w) => {
      const ms = Array.isArray(w.meanings) ? w.meanings : []
      const ps = Array.isArray(w.phrases) ? w.phrases : []
      return ms.length >= 3 && ps.some((p) => p.meaningId === ms[0].id)
    })
    const weak = words.find((w) => {
      const ms = Array.isArray(w.meanings) ? w.meanings : []
      const ps = Array.isArray(w.phrases) ? w.phrases : []
      return ms.length >= 3 && ps.some((p) => typeof p.meaningId === 'string')
    })
    const target = strong ?? weak
    if (!target) throw new Error('当前词库没有「≥3 含义且有词组」的词')
    const ms = target.meanings
    const now = Date.now()
    const d = new Date(now)
    const pad = (x) => String(x).padStart(2, '0')
    const dateKey = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const planId = `${dateKey}:${deckId}`
    const meaningStats = {}
    // 第一个含义（当前 c）1 次 / 10；第二 4/10；第三 8/10 → 条形长度/颜色明显不同
    ms.slice(0, 3).forEach((m, i) => {
      meaningStats[m.id] = { clicks: [1, 4, 8][i], encounters: 10 }
    })
    const state = {
      wordId: target.id, deckId, phase: 'new', stability: 1, difficulty: target.difficulty ?? 5,
      reps: 0, lapses: 0, firstSeenAt: null, lastReviewedAt: null, dueAt: null,
      nextIntervalDays: 1, retrievability: 1, lastRating: null, sameDayCount: 0, sameDayDate: '',
      sameDayRequeued: 0, todayProgress: 0, meaningStats, createdAt: now, updatedAt: now,
    }
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['settings', 'plans', 'meta', 'states'], 'readwrite')
      for (const [key, value] of Object.entries({ 'app.theme': 'dark', 'memory.showPhrases': true })) {
        tx.objectStore('settings').put({ key, value, updatedAt: now })
      }
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
    return {
      headword: target.headword,
      meanings: ms.slice(0, 3).map((m) => ({ cn: m.cn, phrases: (target.phrases ?? []).filter((p) => p.meaningId === m.id).map((p) => `${p.en} — ${p.cn}`) })),
    }
  })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitHome(page)
  await sleep(600)
  return chosen
}

async function runFlow(page, chunk) {
  const tap = () => page.mouse.click(W / 2, Math.round(H * 0.45))
  await sleep(1200) // 首页
  await page.getByRole('button', { name: /开始学习|继续学习/ }).first().click()
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(1500) // 白板
  await tap()
  await page.locator('.meanings').first().waitFor({ state: 'visible', timeout: 20_000 })
  await sleep(2000) // 注释面：3 条不熟悉度条
  await page.screenshot({ path: join(OUT, '03-annotations.png') })
  console.log('  📸 03-annotations.png')
  await page.locator('.memory-btn').first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 20_000 })
  await sleep(1400) // 当前 c（有词组）
  await tap() // 1/3
  await sleep(1100)
  await page.screenshot({ path: join(OUT, '04-memory-wc.png') })
  console.log('  📸 04-memory-wc.png')
  await sleep(400)
  await tap() // 2/3
  await sleep(1100)
  await tap() // 3/3 → 切下一个 c
  await sleep(1500)
  for (let i = 0; i < 3; i += 1) {
    await tap() // 第二含义 1/3..3/3
    await sleep(1050)
  }
  await sleep(1300) // 第三个 c
  for (let i = 0; i < 3; i += 1) {
    await tap()
    await sleep(1000)
  }
  await sleep(700)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page)
  await sleep(900)
  await page.getByRole('button', { name: '查看今日单词 ›', exact: true }).first().click()
  await page.locator('.mm-section-band').first().waitFor({ state: 'visible', timeout: 20_000 })
  await sleep(1400)
  await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' })
  await page.getByText('学习设置', { exact: true }).first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.locator('.mm-row').filter({ hasText: '每日复习上限' }).first().scrollIntoViewIfNeeded()
  await sleep(1400)
  await page.goto(BASE + '#/stats', { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1300)
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const videoDir = join(tmpdir(), `momo-demo-v2-${Date.now()}`)
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
    await sleep(700)
    homeAt = Date.now()
    await runFlow(page, chosen)
    await page.close()
    await context.close()
    videoPath = await video.path()
  } finally {
    await browser.close()
  }
  const files = (await readdir(videoDir)).filter((f) => f.endsWith('.webm'))
  if (!videoPath || files.length === 0) throw new Error('没有录到视频')
  const palette = join(tmpdir(), `momo-demo-v2-pal-${Date.now()}.png`)
  const gifPath = join(OUT, 'demo-flow.gif')
  const probe = await execFileAsync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', videoPath])
  const totalSec = Number(String(probe.stdout).trim())
  const trimStart = Math.max(0.2, (homeAt - t0) / 1000 - 0.15)
  const flowSec = Math.max(1, totalSec - trimStart)
  // 目标 ~24s；允许轻微提速/放慢，但保持关键停留（fps=12 → 播放时长=frame 数/12）
  // 20–30s 内保持原速（保证每个计数/切换停留 ≥0.9s）；超出才轻微调速
  const speed = flowSec >= 20 && flowSec <= 30 ? 1 : Math.min(1.2, Math.max(0.8, 24 / flowSec))
  console.log(`video ${totalSec.toFixed(2)}s, trim ${trimStart.toFixed(2)}s, flow ${flowSec.toFixed(2)}s, speed ${speed.toFixed(2)}`)
  const filter = `trim=start=${trimStart.toFixed(3)},setpts=${speed.toFixed(3)}*(PTS-STARTPTS),fps=12,scale=360:-1:flags=lanczos`
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
  await writeFile(join(tmpdir(), 'momo-demo-chosen.json'), JSON.stringify(chosen, null, 2))
  console.log('选词:', chosen.headword, '含义:', chosen.meanings.map((m) => m.cn).join(' / '))
  console.log('完成：demo-flow.gif / 03-annotations.png / 04-memory-wc.png')
}

await main()
