/**
 * task-118 S25：AI Web 传输 E2E —— 真实 HTTP（本地 mock server :8788），不是 fake provider 函数。
 * 覆盖：成功 / 401 / 408（超时映射）；APK 原生桥由真机验收。
 * 运行：node tests/e2e/ai-transport-e2e.mjs
 */
import { chromium } from '../../tools/e2e/node_modules/playwright-core/index.mjs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const HERE = dirname(fileURLToPath(import.meta.url))
const TOOLS = join(HERE, '..', '..', 'tools/e2e')
const CHROMIUM = process.env.E2E_CHROMIUM || join(TOOLS, 'chromium/usr/lib/chromium/chromium')
const LIB = [join(TOOLS, 'chromium/usr/lib/aarch64-linux-gnu'), join(TOOLS, 'chromium/usr/lib/chromium')].join(':')
const BASE = process.env.E2E_BASE || 'http://127.0.0.1:4173/'
const PORT = Number(process.env.AI_MOCK_PORT || 8788)
const out = { mock: [], results: {} }
let mode = 'success'
const server = http.createServer((req, res) => {
  const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST,OPTIONS', 'content-type': 'application/json' }
  if (req.method === 'OPTIONS') { res.writeHead(204, headers); res.end(); return }
  let body = ''; req.on('data', (c) => (body += c)); req.on('end', () => {
    out.mock.push({ mode, method: req.method, url: req.url })
    if (mode === '401') { res.writeHead(401, headers); res.end(JSON.stringify({ error: { message: 'invalid key' } })); return }
    if (mode === '408') { res.writeHead(408, headers); res.end(JSON.stringify({ error: { message: 'timeout' } })); return }
    res.writeHead(200, headers)
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  })
})
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(PORT, '127.0.0.1', resolve) })
const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'], env: { ...process.env, LD_LIBRARY_PATH: LIB } })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' })
const page = await ctx.newPage()
const pageErrors = []; page.on('pageerror', (e) => pageErrors.push(String(e)))
try {
  await page.route('**/packs/**', (r) => r.abort())
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60_000 }); await page.waitForTimeout(2500)
  await page.goto(BASE + '#/me/settings', { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded()
  await page.waitForTimeout(400)
  await page.getByRole('switch', { name: '启用 AI 扩充' }).click(); await page.waitForTimeout(300)
  await page.getByLabel('AI 服务商').selectOption('openai-compatible').catch(() => {})
  await page.getByLabel('AI baseURL').fill('http://127.0.0.1:8788/v1')
  await page.getByLabel('AI 模型').fill('mock-model')
  await page.getByLabel('AI API Key').fill('sk-TEST')
  await page.getByRole('button', { name: '保存 Key', exact: true }).click()
  await page.waitForFunction(() => /已配置：/.test(document.body.innerText), { timeout: 15_000 }).catch(() => {})
  await page.getByText('AI 扩充（可选）').first().scrollIntoViewIfNeeded(); await page.waitForTimeout(300)
  const runTest = async (name) => {
    await page.getByRole('button', { name: '测试连接', exact: true }).click()
    await page.waitForTimeout(1200)
    return (await page.locator('body').innerText()).replace(/\s+/g, ' ').match(/连接成功：[^。\n]+|连接失败：[^。\n]+/)?.[0] ?? ''
  }
  mode = 'success'; out.results.success = await runTest('success')
  mode = '401'; out.results.auth = await runTest('401')
  mode = '408'; out.results.timeout = await runTest('408')
  out.passed = /连接成功/.test(out.results.success) && /Key 无效/.test(out.results.auth) && /请求超时/.test(out.results.timeout) && out.mock.length >= 3 && pageErrors.length === 0
  out.pageErrors = pageErrors.slice(0, 3)
  console.log(JSON.stringify(out, null, 2))
} finally {
  await ctx.close(); await browser.close(); await new Promise((r) => server.close(r))
}
if (!out.passed) process.exit(1)
