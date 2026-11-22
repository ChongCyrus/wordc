#!/usr/bin/env node
/**
 * task-198 素材采集：生成式记忆 4 阶段 / 注释面生成元 / 右半页引申图 / 白板 nc。
 * 复用 QA 生产包 + fixture，深色 390x844，2x 截图；GIF 由连续截图合成。
 * 用法：先 `npx vite preview --port 4173`，再 `node tests/e2e/demo-0363-capture.mjs`
 */
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { launch, waitHome, clickStart, openAnnotation, openPanelByButton, BASE, sleep, ROOT } from './qa-gate-lib.mjs'
import { loadMinimalFixture } from './qa-fixture.mjs'
import { readFile } from 'node:fs/promises'

const execFileAsync = promisify(execFile)
const OUT = join(ROOT, 'docs/assets/demo-v2')
const TMP = '/tmp/demo-0363-frames'
const DECK_ID = 'kaoyan-2027-dagang'

const demo = {
  denounce: {
    rootLabel: '公开宣告',
    text: '本义/核心义：拉丁 de-（向下、公开）+ nuntiare（宣告）→ 当众宣告\n- 当众说人坏 → 谴责、公然抨击\n- 当众报到官府 → 告发\n- 当众宣告作废 → 通告废除\n逻辑：核心是「公开宣告」，宣告的内容是恶行、是罪状还是废除，决定了不同含义。',
    mermaid: 'mindmap\n  root((公开宣告))\n    当众说人坏\n      谴责\n      公然抨击\n    当众报到官府\n      告发\n    当众宣告作废\n      通告废除',
    rootMnemonic: 'denounce = de（向下/公开）+ nounce（宣告）：当众把坏事宣告出来 → 谴责、告发。',
  },
  technical: {
    rootLabel: '属于技艺',
    text: '本义/核心义：希腊 techne（技艺、手艺）+ -al → 属于技艺、属于专门行当的\n- 属于生产工艺与科技 → 工艺的、科技的\n- 属于具体操作层面 → 技术上的\n- 属于严格条文 → 法律/规则字面上的\n逻辑：核心是「技艺/专门行当」，对象从生产扩到操作、再到条文解释。',
    mermaid: 'mindmap\n  root((属于技艺))\n    生产工艺\n      工艺的\n      科技的\n    具体操作\n      技术上的\n    严格条文\n      字面上的',
    rootMnemonic: 'technical 来自 techne（手艺）：跟「技艺」有关的 → 科技的、技术上的。',
  },
  domain: {
    rootLabel: '主人地盘',
    text: '本义/核心义：拉丁 dominus（主人）→ 主人管辖的地盘\n- 主人管得着的范围，抽象化 → 领域\n- 网络上归某人某机构管的地盘 → 域名\n- 经济活动覆盖的范围 → 产业领域\n逻辑：核心「地盘」，从实体的领地扩到抽象的领域与网络域名。',
    mermaid: 'mindmap\n  root((主人地盘))\n    实体领地\n      领地\n    抽象范围\n      领域\n    网络地盘\n      域名',
    rootMnemonic: 'domain 与 dominus（主人）同源：主人说了算的那片「地盘」→ 领地、领域、域名。',
  },
}

async function patchWords(page) {
  await page.evaluate(async ({ deckId, demo }) => {
    const open = () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('wordc')
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      })
    const db = await open()
    const words = await new Promise((resolve) => {
      const req = db.transaction('words', 'readonly').objectStore('words').getAll()
      req.onsuccess = () => resolve(req.result)
    })
    const byHead = new Map(
      words.filter((w) => w.deckId === deckId).map((w) => [String(w.headwordLower || w.headword).toLowerCase(), w]),
    )
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['words', 'settings', 'packItems'], 'readwrite')
      const store = tx.objectStore('words')
      const packItems = tx.objectStore('packItems')
      const ids = []
      for (const [head, data] of Object.entries(demo)) {
        const w = byHead.get(head)
        if (!w) continue
        ids.push(w.id)
        store.put({
          ...w,
          derivationMap: {
            rootLabel: data.rootLabel,
            text: data.text,
            mermaid: data.mermaid,
            source: 'ai',
            updatedAt: Date.now(),
          },
          rootMnemonic: { text: data.rootMnemonic, source: 'manual', updatedAt: Date.now() },
          rareMeaningIds: [w.meanings[w.meanings.length - 1].id],
          ncMeaningIds: [w.meanings[0].id],
        })
      }
      // 去掉 fixture/旧 pack 的占位本义（「本义待重新生成」），避免素材出现脏数据
      for (const id of ids) {
        const req = packItems.getAll()
        req.onsuccess = () => {
          for (const item of req.result) {
            if (item.wordId === id) packItems.delete(item.id)
          }
        }
      }
      tx.objectStore('settings').put({ key: 'ui.theme', value: 'dark', updatedAt: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }, { deckId: DECK_ID, demo })
}

async function shot(page, name) {
  await page.screenshot({ path: join(OUT, name), animations: 'disabled' })
  console.log('shot', name)
}

async function main() {
  await rm(OUT, { recursive: true, force: true })
  await mkdir(OUT, { recursive: true })
  await rm(TMP, { recursive: true, force: true })
  await mkdir(TMP, { recursive: true })

  const { page, close } = await launch({ viewport: { width: 390, height: 844 }, headless: true, hasTouch: true })
  const fixture = JSON.parse(await readFile(join(ROOT, 'tests/e2e/fixtures/minimal-profile.json'), 'utf8'))
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForTimeout(1200)
  await loadMinimalFixture(page, join(ROOT, 'tests/e2e/fixtures/minimal-profile.json'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await waitHome(page)
  await patchWords(page)
  await page.reload({ waitUntil: 'domcontentloaded' })
  await waitHome(page)
  await page.waitForTimeout(600)

  await clickStart(page)
  await page.waitForTimeout(1200)
  // 注释面：生成元 + 第一段 + 映射助记 + 不常考
  await openAnnotation(page)
  await page.waitForTimeout(800)
  await shot(page, '02-annotation-root.png')

  // 生成式记忆
  await page.getByRole('button', { name: '生成式记忆' }).first().click()
  await page.locator('.generative-stage').first().waitFor({ state: 'visible', timeout: 20_000 })
  await page.waitForTimeout(600)
  await shot(page, '03-generative-1-overview.png')
  await page.getByRole('button', { name: '下一步' }).first().click()
  await page.waitForTimeout(700)
  await shot(page, '04-generative-2-mapping.png')

  // GIF 帧：0/3 → 1/3 → 2/3 → 进入阶段3
  await page.screenshot({ path: join(TMP, 'g01.png'), animations: 'disabled' })
  for (let i = 0; i < 3; i += 1) {
    await page.locator('.generative-tap-zone').first().click({ force: true })
    await page.waitForTimeout(550)
    await page.screenshot({ path: join(TMP, `g${String(i + 2).padStart(2, '0')}.png`), animations: 'disabled' })
  }
  await page.locator('.generative-stage').first().waitFor({ state: 'visible' })
  await page.waitForTimeout(500)
  await shot(page, '05-generative-3-meanings.png')

  // fixture 已预置 nc，不再切换，直接进阶段4
  const next = page.getByRole('button', { name: '下一步' }).first()
  if (await next.count()) await next.click({ force: true }).catch(() => {})
  await page.waitForTimeout(700)
  await shot(page, '06-generative-4-chain.png')
  await page.getByRole('button', { name: '完成' }).first().click({ force: true }).catch(() => {})
  await page.waitForTimeout(500)

  // 右半页引申图（等 toast 消失）
  await page.waitForTimeout(2600)
  await openPanelByButton(page)
  await page.waitForTimeout(900)
  await shot(page, '07-right-pane-text.png')
  const mermaidTab = page.getByRole('button', { name: 'Mermaid' }).first()
  if (await mermaidTab.count()) {
    await mermaidTab.click({ force: true }).catch(() => {})
    await page.waitForTimeout(1600)
    await shot(page, '08-right-pane-mermaid.png')
  }
  const full = page.getByRole('button', { name: /全屏/ }).first()
  if (await full.count()) {
    await full.click({ force: true }).catch(() => {})
    await page.waitForTimeout(900)
    await shot(page, '09-right-pane-fullscreen.png')
    await page.keyboard.press('Escape').catch(() => {})
  }

  await close()

  // GIF：4fps，360 宽
  await execFileAsync('ffmpeg', [
    '-y',
    '-framerate', '2',
    '-i', join(TMP, 'g%02d.png'),
    '-vf', 'scale=360:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
    '-loop', '0',
    join(OUT, 'generative-click.gif'),
  ])
  console.log('done')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
