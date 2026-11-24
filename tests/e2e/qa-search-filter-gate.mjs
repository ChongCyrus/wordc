/** rc2 门禁：我的/设置本地搜索按 computed display 真正隐藏行 */
import { BASE, launch, maybeLoadFixture } from './qa-gate-lib.mjs'
const { page, close } = await launch()
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await maybeLoadFixture(page)
  await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  const input = page.locator('input[placeholder="搜索我的设置"]')
  await input.fill('不存在的设置项xyz')
  await page.waitForTimeout(150)
  const visible = await page.locator('.mm-page .mm-row:visible').count()
  if (visible !== 0) throw new Error(`搜索空结果仍显示 ${visible} 行`)
  await input.fill('调试')
  await page.waitForTimeout(150)
  const debugVisible = await page.locator('.mm-page .mm-row:visible').count()
  if (debugVisible < 1) throw new Error('搜索「调试」未显示入口')
  await page.screenshot({ path: '/tmp/qa-search-filter-390.png', fullPage: true })
  console.log('PASS: search filters by display, empty state works')
} finally { await close() }
