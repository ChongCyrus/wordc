/** rc16 门禁：词库选择模式底部「抽这些词复习」可点击、不被 tabbar 覆盖 */
import { BASE, launch, maybeLoadFixture } from './qa-gate-lib.mjs'

const { page, close } = await launch()
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1200)
  await page.locator('.mm-list .mm-row').first().click()
  await page.waitForTimeout(1200)
  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.waitForTimeout(400)
  await page.locator('input[type="checkbox"]').first().click()
  const bar = page.locator('[data-testid="temp-review-bar"]')
  await bar.waitFor({ state: 'visible', timeout: 8000 })
  const barBox = await bar.boundingBox()
  const tabbarBox = await page.locator('.tabbar').boundingBox().catch(() => null)
  if (barBox && tabbarBox && barBox.y + barBox.height > tabbarBox.y + 1) {
    throw new Error(`抽词复习 bar 与 tabbar 重叠：bar.bottom=${barBox.y + barBox.height}, tabbar.y=${tabbarBox.y}`)
  }
  await page.locator('[data-testid="temp-review-open"]').click({ timeout: 5000 })
  const dialog = page.getByText('抽这些词复习', { exact: false }).first()
  await dialog.waitFor({ state: 'visible', timeout: 5000 })
  await page.screenshot({ path: '/tmp/qa-temp-review-bar-390.png', fullPage: true })
  console.log('PASS: temp-review bar clickable, dialog opened')
} finally {
  await close()
}
