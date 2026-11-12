import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import { readFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')
const TOOLS = join(ROOT, 'tools/e2e')
const CHROMIUM = join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
const BASE = 'http://127.0.0.1:4173/'
const KEY = (await readFile(join(ROOT, '.secrets/deepseek-key'), 'utf8')).trim()
const OUT = join(ROOT, 'docs/assets/qa/ai-0.3.26')

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox','--disable-gpu','--disable-dev-shm-usage'], env: { ...process.env, LD_LIBRARY_PATH: LIB } })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = await ctx.newPage()
page.on('console', m => { if (m.type()==='error') console.log('CONSOLE ERROR:', m.text().slice(0,300)) })
page.on('pageerror', e => console.log('PAGE ERROR:', String(e).slice(0,500)))
await mkdir(OUT, { recursive: true })
await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.getByText('AI 扩充（可选）').first().waitFor({ state: 'visible', timeout: 30000 })
await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded()
await page.waitForTimeout(1000)
const info = await page.evaluate(() => {
  const scope = [...document.querySelectorAll('*')].find(el => el.textContent?.trim() === 'AI 扩充（可选）')
  const sec = scope?.closest('section') ?? scope?.parentElement?.parentElement?.parentElement
  const root = sec ?? document.body
  return {
    text: root.innerText.replace(/\s+/g,' ').slice(0,3000),
    inputs: [...root.querySelectorAll('input,select,textarea,button')].map(el => ({ tag: el.tagName, type: el.type, aria: el.getAttribute('aria-label'), name: el.getAttribute('name'), placeholder: el.placeholder, text: el.innerText?.trim().slice(0,40), value: el.value?.slice?.(0,20) })),
  }
})
console.log(JSON.stringify(info, null, 2))
await page.screenshot({ path: join(OUT, 'probe-settings.png'), fullPage: false })
// configure
const enable = page.getByRole('switch', { name: '启用 AI 扩充' })
console.log('enable count', await enable.count())
if ((await enable.getAttribute('aria-checked')) !== 'true') await enable.click()
console.log('labels', await page.locator('input[aria-label],select[aria-label]').evaluateAll(els=>els.map(e=>e.getAttribute('aria-label'))))
await page.getByLabel('AI baseURL').fill('https://api.deepseek.com')
await page.getByLabel('AI 模型').fill('deepseek-chat')
await page.getByLabel('AI API Key').fill(KEY)
await page.getByRole('button', { name: '保存 Key', exact: true }).click()
await page.waitForTimeout(800)
console.log('after save text has 已配置', (await page.locator('body').innerText()).includes('已配置：'))
console.log('masked line', (await page.locator('body').innerText()).match(/已配置：[^\n]*/)?.[0])
// test connection real
const t0 = Date.now()
await page.getByRole('button', { name: '测试连接', exact: true }).click()
await page.waitForTimeout(1200)
await page.getByText(/连接成功|连接失败/).first().waitFor({state:'visible', timeout: 40000}).catch(()=>{})
console.log('test result', (await page.getByText(/连接成功|连接失败/).first().innerText().catch(()=>'NONE')), 'ms', Date.now()-t0)
await page.screenshot({ path: join(OUT, 'probe-settings-configured.png') })
console.log('log tail:'); 
await browser.close()
