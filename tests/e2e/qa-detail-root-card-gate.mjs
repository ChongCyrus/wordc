#!/usr/bin/env node
/** task-287：词库→单词详情（/study?detailWord）显示词根词缀词源卡片，添加/编辑可点。 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, assert, watchErrors } from './qa-gate-lib.mjs'

const result = { checks: {}, errors: [], ok: false }
const record = (key, value) => {
  result.checks[key] = value
  console.log(`[root-detail] ${key}: ${JSON.stringify(value)}`)
}
await mkdir(OUT, { recursive: true })
const { page, close } = await launch()
const errors = watchErrors(page)
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const deck = page.locator('.mm-list .mm-row').first()
  await deck.waitFor({ state: 'visible', timeout: 30_000 })
  await deck.click()
  await page.waitForTimeout(1200)
  const word = page.locator('.mm-list .mm-row').first()
  await word.waitFor({ state: 'visible', timeout: 30_000 })
  await word.click()
  const card = page.locator('.root-etymology-card').first()
  await card.waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  const cardVisible = await card.isVisible().catch(() => false)
  record('cardVisible', cardVisible)
  const button = card.getByRole('button', { name: /添加\/编辑|编辑/ }).first()
  record('editVisible', await button.isVisible().catch(() => false))
  assert(cardVisible, '详情注释面应显示词根词缀词源卡片')
  await button.click()
  const dialog = page.getByTestId('root-etymology-edit-dialog')
  await dialog.waitFor({ state: 'visible', timeout: 5000 })
  record('dialogVisible', true)
  await page.screenshot({ path: join(OUT, '120-detail-root-card-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 })
  await page.waitForTimeout(300)
  record('360Overflow', await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `errors: ${JSON.stringify(result.errors)}`)
  result.ok = true
  console.log('[root-detail] PASS')
} catch (error) {
  result.failReason = error instanceof Error ? error.message : String(error)
  console.error(`[root-detail] FAIL: ${result.failReason}`)
  await page.screenshot({ path: '/tmp/qa-detail-root-card-fail.png' }).catch(() => {})
  process.exitCode = 1
} finally {
  await close().catch(() => {})
}
