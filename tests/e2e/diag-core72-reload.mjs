#!/usr/bin/env node
/**
 * 0.3.72 task217 冷启动诊断（不 build、不调真实 API）：
 * 直接向 IndexedDB 写入 core 内容 + 设置，page reload 后 dump DB 与 memory-stage 文本。
 * 用法：QA_FIXTURE=tests/e2e/fixtures/minimal-profile.json QA_BASE=http://127.0.0.1:4173/ node tests/e2e/diag-core72-reload.mjs
 */
import { BASE, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation } from './qa-gate-lib.mjs'

const WORD_ID = 'kaoyan-2027-dagang:denounce'
const LABEL = 'fixture旧本义'
const { page, close } = await launch()
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  await maybeLoadFixture(page)
  await page.evaluate(async ({ wordId, label }) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('wordc')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const now = Date.now()
    await new Promise((res, rej) => {
      const tx = db.transaction(['words', 'settings', 'meta'], 'readwrite')
      const get = tx.objectStore('words').get(wordId)
      get.onsuccess = () => {
        const word = get.result
        if (word) {
          tx.objectStore('words').put({
            ...word,
            // 诊断 cold reload 时必须清掉 fixture 的 rare 标记；否则按 0.3.70 规则唯一本义会被排除→正常回退
            rareCoreSenses: [],
            senseMnemonics: [{ coreSenseIndex: 1, label, text: 'DIAG mnemonic', source: 'ai', updatedAt: now }],
            coreSenseExamples: [{ coreSenseIndex: 1, label, examples: [{ en: 'DIAG example', cn: '诊断例句' }], source: 'ai', updatedAt: now }],
            coreSensePhrases: [{ coreSenseIndex: 1, label, phrases: [{ en: 'DIAG phrase', cn: '诊断词组' }], source: 'ai', updatedAt: now }],
          })
        }
      }
      tx.objectStore('settings').put({ key: 'memory.weightedCoreSenseOnly', value: true, updatedAt: now })
      tx.objectStore('settings').put({ key: 'memory.coreSenseExampleCount', value: 2, updatedAt: now })
      tx.objectStore('settings').put({ key: 'memory.coreSensePhraseCount', value: 2, updatedAt: now })
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
  }, { wordId: WORD_ID, label: LABEL })

  const dbDump = await page.evaluate(async (wordId) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('wordc')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const read = (store, key) =>
      new Promise((res, rej) => {
        const r = db.transaction(store, 'readonly').objectStore(store).get(key)
        r.onsuccess = () => res(r.result)
        r.onerror = () => rej(r.error)
      })
    const settings = await new Promise((res) => {
      const out = {}
      const r = db.transaction('settings', 'readonly').objectStore('settings').openCursor()
      r.onsuccess = () => {
        const cursor = r.result
        if (!cursor) return res(out)
        if (String(cursor.key).startsWith('memory.')) out[cursor.key] = cursor.value.value
        cursor.continue()
      }
    })
    const word = await read('words', wordId)
    return {
      settings,
      rareCoreSenses: word?.rareCoreSenses,
      senseMnemonics: word?.senseMnemonics,
      coreSenseExamples: word?.coreSenseExamples,
      coreSensePhrases: word?.coreSensePhrases,
    }
  }, WORD_ID)
  console.log('DIAG_DB', JSON.stringify(dbDump))

  // 0.3.72：确保 reload 后仍落在 denounce（plan.index 可能已推进到其它词）
  await page.evaluate(async (wordId) => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('wordc')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const all = await new Promise((res) => {
      const r = db.transaction('plans', 'readonly').objectStore('plans').getAll()
      r.onsuccess = () => res(r.result)
      r.onerror = () => res([])
    })
    const plan = all.find((p) => Array.isArray(p.wordIds) && p.wordIds.includes(wordId) && !p.completedAt) ?? all[0]
    if (!plan) return
    const index = plan.wordIds.indexOf(wordId)
    await new Promise((res, rej) => {
      const tx = db.transaction('plans', 'readwrite')
      tx.objectStore('plans').put({ ...plan, index: index >= 0 ? index : plan.index, completedAt: null })
      tx.oncomplete = res
      tx.onerror = () => rej(tx.error)
    })
  }, WORD_ID)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await waitHome(page, 90_000)
  await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 })
  await openAnnotation(page)
  await page.getByRole('button', { name: '加权记忆' }).first().click()
  await page.locator('.memory-stage').first().waitFor({ state: 'visible', timeout: 10_000 })
  await page.waitForFunction(() => /DIAG mnemonic|CORE72/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  const text = (await page.locator('.memory-stage').innerText()).replace(/\s+/g, ' ')
  console.log('DIAG_MEMORY', JSON.stringify(text.slice(0, 500)))
  const headwordOk = /denounce/.test(text)
  console.log('DIAG_HEADWORD', JSON.stringify({ ok: headwordOk, expected: WORD_ID }))
  console.log('DIAG_HAS', JSON.stringify({ mnemonic: /DIAG mnemonic/.test(text), example: /DIAG example/.test(text), phrase: /DIAG phrase/.test(text) }))
  if (!headwordOk) throw new Error('reload 后不是 denounce，前置条件不满足')
  const diag = await page.evaluate(() => ({
    global: window.__DIAG_CORE,
    attrs: (() => {
      const el = document.querySelector('.memory-stage')
      return el
        ? {
            mnemonic: el.getAttribute('data-core-mnemonic'),
            examples: el.getAttribute('data-core-examples'),
            text: el.getAttribute('data-core-mnemonic-text'),
          }
        : null
    })(),
  }))
  console.log('DIAG_PROPS', JSON.stringify(diag))
} catch (error) {
  console.error('DIAG_FAIL', error instanceof Error ? error.message : String(error))
} finally {
  await close().catch(() => {})
}
