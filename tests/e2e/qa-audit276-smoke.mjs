#!/usr/bin/env node
/** 0.3.93 audit smoke：411/390/360 三视口关键页不溢出；首页 clean DB 可加载；不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, watchErrors } from './qa-gate-lib.mjs'
const { page, close } = await launch(); if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const errors = watchErrors(page); const checks = {}; await mkdir(OUT, { recursive: true })
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90000 }); if (FIXTURE) await maybeLoadFixture(page)
  for (const w of [411, 390, 360]) {
    await page.setViewportSize({ width: w, height: 900 })
    for (const [name, hash] of [['home', ''], ['deck', '#/decks/kaoyan-2027-dagang'], ['me', '#/me']]) {
      await page.goto(`${BASE}${hash}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
      const m = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, body: document.body.innerText.replace(/\s+/g, ' ').slice(0, 60) }))
      checks[`${w}-${name}`] = m
      if (m.overflow) checks.fail = `${w}-${name} overflow`
    }
  }
  checks.console = [...errors.pageErrors, ...errors.consoleErrors].filter((t) => !/packs|ERR_FAILED/.test(t))
  checks.ok = !checks.fail && checks.console.length === 0
} catch (e) { checks.ok = false; checks.error = e.message } finally { await writeFile(join(OUT, 'qa-audit276-smoke.json'), JSON.stringify(checks, null, 2)); console.log(JSON.stringify(checks, null, 2)); await close().catch(() => {}) }
