#!/usr/bin/env node
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors } from './qa-gate-lib.mjs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const { page, close } = await launch()
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const errs = watchErrors(page)
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  if (FIXTURE) await maybeLoadFixture(page)
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(3000)
  const deck = await page.evaluate(() => ({ body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160), rows: document.querySelectorAll('.mm-list button.mm-row').length, url: location.href }))
  console.log('DECK', JSON.stringify(deck))
  await page.locator('.mm-list button.mm-row').first().click()
  await page.waitForTimeout(3000)
  console.log('DETAIL', JSON.stringify(await page.evaluate(() => ({ url: location.href, body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 160), annotation: document.querySelectorAll('.annotation-stage').length }))))
  await page.getByLabel('返回详情').click().catch((e) => console.log('CLICKERR', e.message))
  await page.waitForTimeout(10_000)
  console.log('AFTER', JSON.stringify(await page.evaluate(() => ({ url: location.href, body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 220), loading: document.querySelectorAll('.study-loading').length, rows: document.querySelectorAll('.mm-list button.mm-row').length }))))
  console.log('ERRS', JSON.stringify([...errs.pageErrors, ...errs.consoleErrors].slice(-5)))
  await page.screenshot({ path: join(OUT, '99-return-appback.png') })
} catch (e) { console.log('FAIL', e.message); await page.screenshot({ path: join(OUT, '99-return-fail.png') }).catch(() => {}) }
finally { await writeFile(join(OUT, 'qa-return-diag.json'), '{}'); await close().catch(() => {}) }
