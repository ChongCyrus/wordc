#!/usr/bin/env node
/**
 * task-198/0.3.72 高清素材采集：
 * - 截图：390x844 CSS × deviceScaleFactor 3 → 1170x2532 PNG
 * - GIF：按帧截图（3x）→ ffmpeg 缩放 540 宽、8fps
 * 用法：先 `npx vite preview --port 4173`，再 `node tests/e2e/demo-0372-capture.mjs`
 */
import { execFile } from 'node:child_process'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { loadMinimalFixture } from './qa-fixture.mjs'
import { waitHome, clickStart, openAnnotation } from './qa-gate-lib.mjs'

const execFileAsync = promisify(execFile)
const ROOT = '/root/workspace/背单词APP开发'
const OUT = join(ROOT, 'docs/assets/demo-v3', process.env.DEMO_PART === 'core' ? 'core' : '')
const TMP = '/tmp/demo-0372-frames'
const BASE = process.env.QA_BASE || 'http://127.0.0.1:4174/'
const CHROME = join(ROOT, 'tools/e2e/chromium/usr/lib/chromium/chromium')
const LIB = [join(ROOT, 'tools/e2e/chromium/usr/lib/aarch64-linux-gnu'), join(ROOT, 'tools/e2e/chromium/usr/lib/chromium')].join(':')
const DECK = 'kaoyan-2027-dagang'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PART = process.env.DEMO_PART || 'gen'

const demo = {
  denounce: {
    rootLabel: '公开宣告',
    text: '本义/核心义：拉丁 de-（向下、公开）+ nuntiare（宣告）→ 当众宣告\n- 当众说人坏 → 谴责、公然抨击\n- 当众报到官府 → 告发\n- 当众宣告作废 → 通告废除\n逻辑：核心是「公开宣告」，宣告的内容是恶行、是罪状还是废除，决定了不同含义。',
    mermaid: 'mindmap\n  root((公开宣告))\n    当众说人坏\n      谴责\n      公然抨击\n    当众报到官府\n      告发\n    当众宣告作废\n      通告废除',
    rootMnemonic: 'denounce = de（向下/公开）+ nounce（宣告）：当众把坏事宣告出来 → 谴责、告发。',
  },
}

async function seed(page, realPackItems, part = 'gen') {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await page.waitForFunction(() => /开始学习|继续学习/.test(document.body.innerText), null, { timeout: 120_000 }).catch(() => {})
  await page.waitForFunction(async () => {
    try {
      const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
      const hasWord = await new Promise((res) => { const r = db.transaction('words','readonly').objectStore('words').get('kaoyan-2027-dagang:denounce'); r.onsuccess = () => res(Boolean(r.result)); r.onerror = () => res(false) })
      const hasDeck = await new Promise((res) => { const r = db.transaction('decks','readonly').objectStore('decks').get('kaoyan-2027-dagang'); r.onsuccess = () => res(Boolean(r.result)); r.onerror = () => res(false) })
      return hasWord && hasDeck
    } catch { return false }
  }, null, { timeout: 180_000 }).catch(() => {})
  await sleep(1200)
  await loadMinimalFixture(page, join(ROOT, 'tests/e2e/fixtures/minimal-profile.json'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await sleep(1200)
  await page.waitForFunction(() => /开始学习|继续学习/.test(document.body.innerText), null, { timeout: 60_000 })
  await page.evaluate(async ({ deckId, demo, realPackItems, part }) => {
    const item0Label = (items) => items?.[0]?.coreSenses?.[0]?.label ?? '本义'
    const open = () => new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const db = await open()
    const all = (s) => new Promise((res) => { const r = db.transaction(s, 'readonly').objectStore(s).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => res([]) })
    const words = await all('words')
    const byHead = new Map(words.filter((w) => w.deckId === deckId).map((w) => [String(w.headwordLower || w.headword).toLowerCase(), w]))
    const now = Date.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['words', 'settings', 'packItems'], 'readwrite')
      const store = tx.objectStore('words')
      for (const [head, data] of Object.entries(demo)) {
        const w = byHead.get(head)
        if (!w) continue
        const meanings = w.meanings ?? []
        const m1 = meanings[0]
        store.put({
          ...w,
          derivationMap: { rootLabel: data.rootLabel, text: data.text, mermaid: data.mermaid, source: 'ai', updatedAt: now },
          rootMnemonic: { text: data.rootMnemonic, source: 'manual', updatedAt: now },
          rareMeaningIds: meanings.length > 2 ? [meanings[2].id] : [],
          ncMeaningIds: meanings.length > 1 ? [meanings[1].id] : [],
          rareCoreSenses: [],
          senseMnemonics: m1 ? [{ coreSenseIndex: 1, label: '公开指责', text: 'de（向下/公开）+ nounce（宣告）：当众宣告出来 → 谴责、告发。', source: 'ai', updatedAt: now }] : [],
          coreSenseExamples: m1 ? [{ coreSenseIndex: 1, label: '公开指责', examples: [{ en: 'The government denounced the plan as harmful.', cn: '政府谴责该计划有害。' }], source: 'ai', updatedAt: now }] : [],
          coreSensePhrases: m1 ? [{ coreSenseIndex: 1, label: '公开指责', phrases: [{ en: 'denounce the policy', cn: '谴责该政策' }], source: 'ai', updatedAt: now }] : [],
        })
      }
      for (const [key, value] of Object.entries({
        'memory.weightedCoreSenseOnly': true,
        'memory.coreSenseExampleCount': 2,
        'memory.coreSensePhraseCount': 2,
        'study.hideRareBlocks': false,
        ...(part === 'core' ? { 'ai.baseUrl': 'https://api.deepseek.com', 'ai.apiKey': 'sk-demo-assets', 'ai.model': 'deepseek-chat' } : {}),
      })) tx.objectStore('settings').put({ key, value, updatedAt: now })
      tx.oncomplete = () => res()
      tx.onerror = () => rej(tx.error)
    })
    // 用真实 semantics pack（商业词表 v4）提供 coreSenses / meaningMap
    const w = byHead.get('denounce')
    if (w && realPackItems.length > 0) {
      // 1) 先清旧语义 pack / 本词 packItem
      await new Promise((res) => {
        const tx = db.transaction(['packs', 'packItems'], 'readwrite')
        const ps = tx.objectStore('packs'); const is = tx.objectStore('packItems')
        const pAll = ps.getAll()
        pAll.onsuccess = () => { for (const p of pAll.result ?? []) if (p.kind === 'semantics') ps.delete(p.id) }
        // 清空该词全部 packItem（含 fixture 占位 derivation），让 word.derivationMap 生效
        const iAll = is.getAll()
        iAll.onsuccess = () => { for (const it of iAll.result ?? []) if (it.wordId === w.id) is.delete(it.id) }
        tx.oncomplete = () => res(); tx.onerror = () => res()
      })
      // 2) 写真实 pack + 本义
      await new Promise((res) => {
        const tx = db.transaction(['packs', 'packItems'], 'readwrite')
        tx.objectStore('packs').put({ id: 'demo-semantics-real', name: '本义链（示例）', kind: 'semantics', formatVersion: 1, checksum: 'demo-real', source: 'builtin', status: 'applied', deckId, promptVersion: 'v4', counts: { items: 1, pending: 0, approved: 0, applied: 1, rejected: 0, skipped: 0 }, createdAt: now, updatedAt: now })
        const is = tx.objectStore('packItems')
        realPackItems.filter((item) => String(item.headwordLower || item.headword || '').toLowerCase() === 'denounce').forEach((item, i) => {
          const n = (w.meanings ?? []).length
          const trimmed = { ...item, meaningMap: (item.meaningMap ?? []).filter((m) => m.meaningIndex >= 1 && m.meaningIndex <= n) }
          is.put({ id: `demo-semantics-real:${i + 1}`, packId: 'demo-semantics-real', seq: i + 1, wordId: w.id, headwordLower: w.headwordLower, headword: w.headword, contentHashes: {}, payload: trimmed, status: 'pending', createdAt: now })
        })
        tx.oncomplete = () => res(); tx.onerror = () => res()
      })
      // 2.5) 走官方 apply 流程（dev 模块导入；prod 回退已写入 applied）
      if (typeof window !== 'undefined' && location.port === '4174') {
        try {
          const data = await import('/src/data/index.ts')
          await data.applyGeneratedPack('demo-semantics-real', { allowOverLimit: true })
        } catch (e) { console.warn('applyGeneratedPack failed', e) }
      }
      // 3) 重新写回词级字段（apply 语义 pack 可能重建 word 记录，丢掉自定义字段）
      await new Promise((res) => {
        const tx = db.transaction(['words'], 'readwrite')
        const ws = tx.objectStore('words')
        const req = ws.get(w.id)
        req.onsuccess = () => {
          const cur = req.result
          if (!cur) return
          const data = demo.denounce
          const meanings = cur.meanings ?? []
          ws.put({
            ...cur,
            derivationMap: { rootLabel: data.rootLabel, text: data.text, mermaid: data.mermaid, source: 'ai', updatedAt: now },
            rootMnemonic: { text: data.rootMnemonic, source: 'manual', updatedAt: now },
            rareMeaningIds: meanings.length > 2 ? [meanings[2].id] : [],
            ncMeaningIds: meanings.length > 1 ? [meanings[1].id] : [],
            rareCoreSenses: [],
            senseMnemonics: [{ coreSenseIndex: 1, label: '公开指责', text: 'de（向下/公开）+ nounce（宣告）：当众宣告出来 → 谴责、告发。', source: 'ai', updatedAt: now }],
            coreSenseExamples: [{ coreSenseIndex: 1, label: '公开指责', examples: [{ en: 'The government denounced the plan as harmful.', cn: '政府谴责该计划有害。' }], source: 'ai', updatedAt: now }],
            coreSensePhrases: [{ coreSenseIndex: 1, label: '公开指责', phrases: [{ en: 'denounce the policy', cn: '谴责该政策' }], source: 'ai', updatedAt: now }],
          })
        }
        tx.oncomplete = () => res(); tx.onerror = () => res()
      })
      // 3.5) 预置本义不熟悉度
      await new Promise((res) => {
        const tx = db.transaction(['states'], 'readwrite')
        const ss = tx.objectStore('states')
        const req = ss.get(w.id)
        req.onsuccess = () => {
          const state = req.result
          if (state) {
            ss.put({
              ...state,
              coreSenseStats: { [JSON.stringify([item0Label(realPackItems), 1])]: { clicks: 2, encounters: 5 } },
              meaningStats: Object.fromEntries((w.meanings ?? []).map((m, i) => [m.id, { clicks: [2, 1, 0, 0][i] ?? 0, encounters: 5 }])),
            })
          }
        }
        tx.oncomplete = () => res(); tx.onerror = () => res()
      })
    }
  }, { deckId: DECK, demo, realPackItems, part })
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => /开始学习|继续学习/.test(document.body.innerText), null, { timeout: 60_000 })
  await sleep(500)
}

async function main() {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    env: { ...process.env, LD_LIBRARY_PATH: LIB },
  })
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    locale: 'zh-CN',
    colorScheme: 'dark',
    hasTouch: true,
    isMobile: true,
  })
  const page = await ctx.newPage()
  let frameNo = 0
  const marks = {}
  const mark = (key) => { marks[key] = frameNo + 1 }
  const snap = async (name) => {
    await page.screenshot({ path: join(OUT, name), animations: 'disabled' })
    console.log('shot', name)
  }
  const frame = async () => {
    frameNo += 1
    await page.screenshot({ path: join(TMP, `f${String(frameNo).padStart(4, '0')}.png`), animations: 'allow' })
  }
  const framesWhile = async (ms, every = 160) => {
    const end = Date.now() + ms
    while (Date.now() < end) {
      await frame()
      await sleep(every)
    }
  }

  const packJson = JSON.parse(await readFile(join(ROOT, 'data/packs/dagang/semantics-full-5528-v4.pack.json'), 'utf8'))
  const realPackItems = (packJson.items ?? []).filter((item) => ['denounce', 'technical', 'domain'].includes(String(item.headwordLower || item.headword || '').toLowerCase()))
  console.log('realPackItems', realPackItems.length)
  if (PART === 'core') await page.route('**/chat/completions', async (route) => {
    const body = JSON.stringify({
      id: 'demo', object: 'chat.completion', model: 'deepseek-chat',
      choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify({ examples: [
        { en: 'They denounced the plan as harmful to the economy.', cn: '他们谴责该计划对经济有害。' },
        { en: 'The minister publicly denounced the policy.', cn: '部长公开谴责了这项政策。' },
      ] }) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    })
    await route.fulfill({ status: 200, contentType: 'application/json', body })
  })
  await seed(page, realPackItems, process.env.DEMO_AI === '0' ? 'gen' : PART)
  // 白板
  await waitHome(page, 60_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(800)
  await snap('01-board.png')
  // 注释面
  await page.locator('.board-stage').first().click()
  await page.locator('.annotation-stage').first().waitFor({ state: 'visible', timeout: 30_000 })
  await sleep(900)
  await snap('02-annotation.png')
  // 不熟悉度标记：点本义卡两次，条/百分比变化（GIF-A 前半）
  mark('famStart')
  const coreCard = page.locator('.core-sense-card').first()
  if (await coreCard.count()) {
    for (let i = 0; i < 2; i += 1) {
      await coreCard.click({ position: { x: 40, y: 40 }, force: true }).catch(() => {})
      await framesWhile(900, 160)
    }
    await sleep(500)
    await snap('02b-annotation-familiarity.png')
  }
  if (PART === 'gen') {
  // 生成式记忆 GIF + 截图（注释面 → 阶段2 → 阶段4 → 全屏 Mermaid）
  await page.getByRole('button', { name: '生成式记忆' }).first().click()
  await page.locator('.generative-stage').first().waitFor({ state: 'visible', timeout: 20_000 })
  await sleep(700)
  await frame()
  await framesWhile(2200, 180)
  await page.getByRole('button', { name: '下一步' }).first().click()
  await sleep(700)
  await framesWhile(2600, 160)
  await snap('03-generative-stage2.png')
  for (let i = 0; i < 3; i += 1) {
    await page.locator('.generative-tap-zone').first().click({ force: true })
    await framesWhile(1500, 150)
  }
  await page.locator('.generative-stage').first().waitFor({ state: 'visible' })
  await sleep(500)
  await frame()
  await page.getByRole('button', { name: '下一步' }).first().click().catch(() => {})
  await sleep(800)
  await framesWhile(2400, 180)
  await snap('04-generative-stage4.png')
  const fullView = page.getByRole('button', { name: '全屏查看' }).first()
  await fullView.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  if (await fullView.count()) {
    await fullView.click({ force: true }).catch(() => {})
    await sleep(1500)
    await snap('04b-stage4-mermaid.png')
    const closeFull = page.getByRole('button', { name: '关闭' }).first()
    if (await closeFull.count()) await closeFull.click({ force: true }).catch(() => {})
    await sleep(800)
    await page.getByRole('button', { name: '完成' }).first().click({ force: true }).catch(() => {})
    await sleep(1200)
  }
  mark('genEnd')

  // 右半页：滑动打开（GIF2）+ 文字/Mermaid 截图
  mark('swipeStart')
  const box = await page.locator('.study-body').boundingBox()
  if (box) {
    const y = box.y + Math.min(Math.max(200, box.height * 0.35), box.height - 120)
    const x = box.x + box.width * 0.97
    await page.mouse.move(x, y)
    await page.mouse.down()
    for (let i = 1; i <= 22; i += 1) {
      await page.mouse.move(x - (160 * i) / 22, y, { steps: 2 })
      await frame()
      await sleep(60)
    }
    await page.mouse.up()
    await sleep(500)
    await frame()
    await sleep(500)
    await frame()
    await sleep(500)
    await frame()
  }
  mark('swipeEnd')
  const textTab = page.getByRole('button', { name: '文字' }).first()
  if (await textTab.count()) await textTab.click({ force: true }).catch(() => {})
  await sleep(900)
  await snap('05-rightpane-text.png')
  const mermaidTab = page.getByRole('button', { name: 'Mermaid' }).first()
  if (await mermaidTab.count()) await mermaidTab.click({ force: true }).catch(() => {})
  await sleep(1400)
  await snap('06-rightpane-mermaid.png')
  const closePanel = page.getByRole('button', { name: /收起|关闭/ }).first()
  if (await closePanel.count()) await closePanel.click({ force: true }).catch(() => {})
  await sleep(700)


  }

  if (PART === 'core') {
  // 只记本义页 + AI（最后拍）
  await page.getByRole('button', { name: '加权记忆' }).first().click({ force: true }).catch(() => {})
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForFunction(() => /The government denounced the plan/.test(document.body.innerText), null, { timeout: 10_000 }).catch(() => {})
  await sleep(900)
  mark('coreStart')
  await snap('08-core-memory.png')
  if (process.env.DEMO_AI !== '0') {
  const ai = page.getByRole('button', { name: 'AI 本义内容' }).first()
  if (await ai.count()) {
    await ai.click({ force: true }).catch(() => {})
    await sleep(900)
    await framesWhile(1200, 200)
    await snap('09-core-ai-panel.png')
    const exampleBtn = page.getByRole('button', { name: 'AI 生成本义例句' }).first()
    if (await exampleBtn.count()) {
      await exampleBtn.click({ force: true }).catch(() => {})
      const t0 = Date.now()
      while (Date.now() - t0 < 20_000) {
        await frame()
        if (await page.getByRole('button', { name: '保存本义例句' }).count()) break
        await sleep(700)
      }
      await framesWhile(1000, 220)
      await snap('09b-core-ai-preview.png')
      const save = page.getByRole('button', { name: '保存本义例句' }).first()
      if (await save.count()) {
        await save.click({ force: true }).catch(() => {})
        await framesWhile(1500, 220)
        await snap('09c-core-ai-saved.png')
      }
    }
  }
  }
  mark('coreEnd')


  }

  await ctx.close()
  await browser.close()

  console.log('marks', JSON.stringify(marks), 'frames', frameNo)
  const makeGif = async (name, start, count) => {
    if (!start || count <= 0) return
    await execFileAsync('ffmpeg', [
      '-y', '-framerate', '6', '-start_number', String(start),
      '-i', join(TMP, 'f%04d.png'), '-frames:v', String(count),
      '-vf', 'scale=540:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
      '-loop', '0', join(OUT, name),
    ]).catch((error) => console.error(name, 'failed', error.message))
  }
  if (PART === 'gen') {
    const famCount = (marks.genEnd ?? frameNo) - (marks.famStart ?? 1) + 1
    await makeGif('familiarity-and-generative.gif', marks.famStart, famCount)
    await makeGif('right-pane-swipe.gif', marks.swipeStart, (marks.swipeEnd ?? frameNo) - (marks.swipeStart ?? 1) + 1)
  } else {
    await makeGif('core-sense-ai.gif', marks.coreStart, (marks.coreEnd ?? frameNo) - (marks.coreStart ?? 1) + 1)
  }
  console.log('done frames', frameNo)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
