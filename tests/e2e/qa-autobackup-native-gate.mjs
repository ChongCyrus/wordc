#!/usr/bin/env node
/** 0.3.86 task-254 mock native bridge：立即备份/列表/保留7/恢复(merge+恢复前备份)/异常弹窗/持久化。不调 API。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, waitHome, clickStart, openAnnotation, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[nativebk] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
await page.addInitScript(() => {
  const KEY = '__qaAutoMock'
  const load = () => { try { return JSON.parse(localStorage.getItem(KEY) || 'null') } catch { return null } }
  const st = load() || { files: [], flags: {}, logs: [], saveFail: false, pruneCalls: [] }
  const persist = () => localStorage.setItem(KEY, JSON.stringify(st))
  window.__qaAuto = { st, persist, get: () => st }
  window.__qaAutoTexts = window.__qaAutoTexts || {}
  window.MomoBridge = {
    isNativeApp: () => 'momo-apk',
    saveAutoBackup: (name, b64) => {
      if (st.saveFail) return 'err:mock save fail'
      let text = ''
      try { const bin = atob(b64); const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0)); text = new TextDecoder().decode(bytes) } catch { text = '' }
      window.__qaAutoTexts[name] = text
      const idx = st.files.findIndex((f) => f.name === name)
      const entry = { name, size: text.length, mtime: Date.now(), path: `/auto/${name}` }
      if (idx >= 0) st.files[idx] = entry; else st.files.push(entry)
      persist()
      return `ok:${entry.path}`
    },
    listAutoBackups: () => JSON.stringify(st.files.map(({ text, ...e }) => e)),
    readAutoBackup: (name) => { if (st.readFail) return 'not-json'; const t = window.__qaAutoTexts[name] ?? st.files.find((f) => f.name === name)?.text ?? 'err:mock missing'; window.__qaReads = window.__qaReads || []; window.__qaReads.push({ name, length: t.length, prefix: t.slice(0, 120), hasMap: Object.prototype.hasOwnProperty.call(window.__qaAutoTexts, name) }); return t },
    deleteAutoBackup: (name) => { st.files = st.files.filter((f) => f.name !== name); persist(); return 'ok' },
    pruneAutoBackups: (keep) => {
      st.files.sort((a, b) => b.mtime - a.mtime)
      const deleted = Math.max(0, st.files.length - keep)
      st.files = st.files.slice(0, keep)
      st.pruneCalls.push(keep); persist()
      return `ok:${deleted}`
    },
    getFlag: (k) => st.flags[k] ?? '',
    setFlag: (k, v) => { st.flags[k] = v; persist(); return 'ok' },
    getWebViewStorageInfo: () => JSON.stringify({ dataDir: '/mock', webviewExists: true, indexedDbExists: true, indexedDbEntries: [] }),
    appendDiagLog: (text) => { st.logs.push(text); persist(); return 'ok:/auto/diag.log' },
    selfTestAutoBackup: () => JSON.stringify({ ok: true }),
    readDiagnosticFile: () => JSON.stringify({ version: '0.3.86', date: new Date().toISOString().slice(0, 10), selfTest: { ok: true }, storage: { origins: [{ name: 'http://127.0.0.1:4173', size: 123456, fileCount: 3, latestMtime: Date.now(), files: [{ name: '000001.ldb', kind: 'ldb', mtime: Date.now() }] }] } }),
    exportBackupToDownloads: (name) => { if (st.exportFail) return 'err:mock export fail'; st.exported = st.exported || []; st.exported.push(name); persist(); return `ok:/sdcard/Download/WordC/${String(name).replace(/\.gz$/, '')}` },
  }
})
const goMe = async () => { await page.goto(`${BASE}#/me`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900) }
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 })
  const assets = await page.evaluate(() => ({ scripts: Array.from(document.scripts).map((s) => s.src).filter(Boolean), css: Array.from(document.querySelectorAll('link[rel=stylesheet]')).map((l) => l.href) }))
  record('assets', assets)
  // 资产 hash 随版本变化，这里只记录；不硬编码
  if (FIXTURE) await maybeLoadFixture(page)
  // 创建学习进度 state
  await page.goto(BASE, { waitUntil: 'domcontentloaded' }); await waitHome(page, 90_000); await clickStart(page)
  await page.locator('.board-stage').first().waitFor({ state: 'visible', timeout: 60_000 }); await openAnnotation(page)
  await page.waitForTimeout(500)
  await goMe()
  let bg = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('availableLabels', { recent: /最近备份：/.test(bg), retain: /保留最近 7 份/.test(bg), switchCount: await page.getByRole('switch', { name: '自动备份（每次启动）' }).count() })
  assert(/自动备份（每次启动）/.test(bg) && /同日覆盖/.test(bg) && /保留最近 7 份/.test(bg), '应有「自动备份（每次启动）」+同日覆盖+保留7')
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const states = await new Promise((res) => { const r = db.transaction('states', 'readonly').objectStore('states').getAll(); r.onsuccess = () => res(r.result) })
    await new Promise((res, rej) => {
      const tx = db.transaction(['reviewLogs', 'states'], 'readwrite')
      tx.objectStore('reviewLogs').clear()
      for (const st of states) tx.objectStore('states').put({ ...st, lastRating: 'vague' })
      tx.oncomplete = res; tx.onerror = () => rej(tx.error)
    })
  })
  const sw = page.getByRole('switch', { name: '自动备份（每次启动）' }).first()
  assert((await sw.isChecked()) === true, '每日自动备份默认应开启')
  // 保留7：预置9份后立即备份触发 prune
  await page.evaluate(() => { const s = window.__qaAuto.get(); s.files = Array.from({ length: 9 }, (_, i) => ({ name: `backup-${i}.json.gz`, size: 1000 + i, mtime: Date.now() - (9 - i) * 60000, path: `/auto/backup-${i}.json.gz`, text: '{}' })); window.__qaAuto.persist() })
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(900)
  // 回归：旧 plan.sources 值 manual/random/order 应能恢复
  await page.evaluate(async () => {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    const id = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('plan.activeId'); r.onsuccess = () => res(r.result?.value) })
    const plan = await new Promise((res) => { const r = db.transaction('plans', 'readonly').objectStore('plans').get(id); r.onsuccess = () => res(r.result) })
    if (plan) {
      const ids = plan.wordIds.slice(0, 3)
      const sources = { [ids[0]]: 'manual', [ids[1]]: 'random', [ids[2]]: 'order' }
      await new Promise((res, rej) => { const tx = db.transaction('plans', 'readwrite'); tx.objectStore('plans').put({ ...plan, sources, updatedAt: Date.now() }); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    }
  })
  const beforeImmediate = await page.evaluate(() => { const s = window.__qaAuto.get(); return { files: s.files.length, prunes: s.pruneCalls?.length ?? 0 } })
  const t0 = Date.now()
  await page.getByText('立即备份', { exact: true }).first().click()
  let backupDone = false
  const phases = []
  for (let i = 0; i < 60; i += 1) {
    await page.waitForTimeout(2000)
    const cur = await page.evaluate(async () => { const s = window.__qaAuto.get(); const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const st = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('backup.lastRunState'); r.onsuccess = () => res(r.result?.value ?? null) }); return { files: s.files.length, prunes: s.pruneCalls?.length ?? 0, hasNew: s.files.some((f) => f.name.startsWith('auto-backup-2026-11-22')), phase: st?.phase ?? null, bytes: st?.bytes ?? null, name: st?.name ?? null } })
    phases.push({ phase: cur.phase, bytes: cur.bytes, name: cur.name })
    if (cur.hasNew || cur.prunes > beforeImmediate.prunes) { backupDone = true; break }
  }
  const backupElapsedMs = Date.now() - t0
  const dbgClick = await page.evaluate(() => { const s = window.__qaAuto.st; return { text: document.body.innerText.replace(/\s+/g, ' ').slice(-240), logs: s.logs.slice(-8), files: s.files.length, flags: s.flags } })
  record('afterImmediateClick', { ...dbgClick, backupDone, backupElapsedMs, phases: phases.slice(-6) })
  assert(backupDone, `立即备份 120s 未完成：${JSON.stringify(dbgClick)}`)
  await page.waitForTimeout(600)
  const successToast = (await page.locator('body').innerText()).match(/已创建自动备份[^\n]*/)?.[0] ?? ''
  record('successToast', { successToast })
  const afterBackup = await page.evaluate(() => { const s = window.__qaAuto.get(); return { files: s.files.length, pruneCalls: s.pruneCalls, names: s.files.map((f) => f.name), sizes: s.files.map((f) => f.size), last: s.files[0]?.name } })
  record('immediateBackup', afterBackup)
  assert(afterBackup.files === 7 && afterBackup.pruneCalls.includes(7) && afterBackup.names.some((n) => n.endsWith('.json.gz')), `应立即备份并保留7份：${JSON.stringify(afterBackup)}`)
  const uiAfter = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  record('uiList', { recent: uiAfter.match(/最近备份：[^·]+·\d+ 份/)?.[0] ?? '' })
  await page.screenshot({ path: join(OUT, '77-autobackup-native-390.png') }).catch(() => {})
  await page.getByText('存储诊断', { exact: true }).first().click()
  const diagDlg = page.getByRole('dialog', { name: '存储诊断' }).first()
  await diagDlg.waitFor({ state: 'visible', timeout: 5000 })
  const diagText = await diagDlg.locator('.storage-diagnostic-text').innerText().catch(() => '')
  record('storageDiag', { length: diagText.length, hasSelfTest: /selfTest/.test(diagText), hasStorage: /storage/.test(diagText), prefix: diagText.slice(0, 120) })
  assert(diagText.length > 0 && /selfTest/.test(diagText) && /storage/.test(diagText), `存储诊断应显示内部 diag 内容：${diagText.slice(0, 120)}`)
  await page.waitForTimeout(500)
  const diagStyle = await page.evaluate(() => { const dlg = document.querySelector('[aria-label="存储诊断"]'); const mask = dlg?.closest('.mm-mask'); const body = dlg?.querySelector('.mm-dialog-body'); const pre = dlg?.querySelector('.storage-diagnostic-text'); const st = dlg ? getComputedStyle(dlg) : null; return { maskClass: mask?.className ?? '', maskZ: mask ? getComputedStyle(mask).zIndex : '', maskBg: mask ? getComputedStyle(mask).backgroundColor : '', dialogBg: st?.backgroundColor ?? '', opacity: st?.opacity ?? '', bodyOverflowY: body ? getComputedStyle(body).overflowY : '', preOverflowY: pre ? getComputedStyle(pre).overflowY : '' } })
  record('storageDiagStyle', diagStyle)
  assert(diagStyle.maskZ === '65' && diagStyle.opacity === '1' && !/rgba\(0, 0, 0, 0\)|transparent/.test(diagStyle.dialogBg) && ['auto', 'scroll'].includes(diagStyle.bodyOverflowY) && ['auto', 'scroll'].includes(diagStyle.preOverflowY), `存储诊断应不透明 z65 可滚动：${JSON.stringify(diagStyle)}`)
  await page.screenshot({ path: join(OUT, '77c-autobackup-storage-diag-390.png') }).catch(() => {})
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  await page.screenshot({ path: join(OUT, '77c-autobackup-storage-diag-360.png') }).catch(() => {})
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300)
  await diagDlg.getByRole('button', { name: '复制' }).click()
  await page.waitForFunction(() => /诊断内容已复制|复制失败/.test(document.body.innerText), null, { timeout: 5000 })
  record('diagCopy', { toast: (await page.locator('body').innerText()).match(/诊断内容已复制|复制失败[^\n]*/)?.[0] ?? '' })
  await diagDlg.getByRole('button', { name: '分享' }).click()
  await page.waitForTimeout(500)
  record('diagShare', { toast: (await page.locator('body').innerText()).match(/诊断内容已复制|复制失败[^\n]*/g)?.slice(-1)[0] ?? '' })
  await diagDlg.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.waitForTimeout(300)
  await page.getByText('导出备份到下载', { exact: true }).first().click()
  const exportDlg = page.getByRole('dialog', { name: '导出备份到下载' }).first()
  await exportDlg.waitFor({ state: 'visible', timeout: 5000 })
  await exportDlg.getByRole('button', { name: '导出到下载' }).first().click()
  await page.waitForFunction(() => /已导出到下载/.test(document.body.innerText), null, { timeout: 10_000 })
  const exported = await page.evaluate(() => window.__qaAuto.get().exported ?? [])
  record('exportBackup', { exported, toast: (await page.locator('body').innerText()).match(/已导出到下载：[^\n]*/)?.[0] ?? '' })
  assert(exported.length === 1 && exported[0].endsWith('.json.gz'), `应导出内部备份到下载：${JSON.stringify(exported)}`)
  await page.screenshot({ path: join(OUT, '77d-autobackup-export-download-390.png') }).catch(() => {})
  await exportDlg.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.waitForTimeout(300)
  await page.evaluate(() => { const s = window.__qaAuto.get(); s.exportFail = true; window.__qaAuto.persist() })
  await page.getByText('导出备份到下载', { exact: true }).first().click()
  const exportDlg2 = page.getByRole('dialog', { name: '导出备份到下载' }).first()
  await exportDlg2.waitFor({ state: 'visible', timeout: 5000 })
  await exportDlg2.getByRole('button', { name: '导出到下载' }).first().click()
  await page.waitForFunction(() => /导出备份失败|mock export fail/.test(document.body.innerText), null, { timeout: 5000 })
  record('exportFail', { toast: (await page.locator('body').innerText()).match(/导出备份失败[^\n]*|mock export fail[^\n]*/)?.[0] ?? '' })
  await exportDlg2.getByRole('button', { name: '关闭' }).click().catch(() => {})
  await page.evaluate(() => { const s = window.__qaAuto.get(); s.exportFail = false; window.__qaAuto.persist() })
  await page.waitForTimeout(300)
  // 失败 toast：mock save 失败应显示具体 error
  await page.evaluate(() => { const s = window.__qaAuto.get(); s.saveFail = true; window.__qaAuto.persist() })
  await page.getByText('立即备份', { exact: true }).first().click()
  await page.waitForFunction(() => /备份失败|mock save fail/.test(document.body.innerText), null, { timeout: 60_000 }).catch(() => {})
  const failToast = (await page.locator('body').innerText()).match(/备份失败[^\n]*|mock save fail[^\n]*/)?.[0] ?? ''
  record('failureToast', { failToast })
  assert(/备份失败|mock save fail/.test(failToast), `失败应显示具体 error：${failToast}`)
  await page.evaluate(() => { const s = window.__qaAuto.get(); s.saveFail = false; window.__qaAuto.persist() })
  // 恢复：merge，恢复前自动备份
  await page.getByText('从自动备份恢复', { exact: true }).first().click()
  const restoreDlg = page.getByRole('dialog', { name: '从自动备份恢复' }).first()
  await restoreDlg.waitFor({ state: 'visible', timeout: 5000 })
  await restoreDlg.getByRole('button', { name: '选择' }).first().click()
  const confirm = page.getByRole('dialog', { name: '从备份恢复？' }).first()
  await confirm.waitFor({ state: 'visible', timeout: 5000 })
  await confirm.getByRole('button', { name: '恢复' }).click()
  await page.waitForTimeout(400)
  const runningDlg = page.getByRole('dialog', { name: '正在从备份恢复' }).first()
  const runningSeen = await runningDlg.isVisible().catch(() => false)
  if (runningSeen) {
    const rt = (await runningDlg.innerText()).replace(/\s+/g, ' ')
    record('restoreRunning', { text: rt.slice(0, 160), closeButtons: await runningDlg.getByRole('button', { name: '关闭', exact: true }).count(), waited: /已等待 \d+s/.test(rt), bigDataHint: /1–2 分钟/.test(rt) })
  }
  const successDlg = page.getByRole('dialog', { name: '恢复完成' }).first()
  await successDlg.waitFor({ state: 'visible', timeout: 180000 })
  const successText = (await successDlg.innerText()).replace(/\s+/g, ' ')
  record('restoreSuccess', { runningSeen, text: successText.slice(0, 220) })
  await page.screenshot({ path: join(OUT, '113-restore-success-390.png') }).catch(() => {})
  await successDlg.getByRole('button', { name: '关闭' }).click(); await successDlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {}); await page.waitForTimeout(500)
  await page.waitForTimeout(700)
  const lastImport = await page.evaluate(async () => { const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) }); const row = await new Promise((res) => { const r = db.transaction('meta', 'readonly').objectStore('meta').get('import:last'); r.onsuccess = () => res(r.result) }); return row?.value ?? null })
  const reads = await page.evaluate(() => window.__qaReads ?? [])
  record('restoreToast', { text: (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(-260), reads, lastImport })
  const restoreInfo = await page.evaluate(() => { const s = window.__qaAuto.get(); return { files: s.files.length, logs: s.logs.slice(-5) } })
  record('restore', restoreInfo)
  const restoreOk = !restoreInfo.logs.some((l) => /\[restore\].*ok=false/.test(l))
  record('restoreOk', { restoreOk, logs: restoreInfo.logs })
  assert(restoreInfo.files >= 8 && restoreOk, `恢复应成功且恢复前自动备份：${JSON.stringify(restoreInfo)}`)
  // 关闭成功恢复后仍打开的恢复列表（若在）
  const openList = page.getByRole('dialog', { name: '从自动备份恢复' }).first()
  if (await openList.isVisible().catch(() => false)) {
    await openList.getByRole('button', { name: '关闭' }).click().catch(() => {})
    await openList.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {})
  }
  // 失败弹窗：mock read 返回非法 JSON（成功后重新打开）
  await page.evaluate(() => { const s = window.__qaAuto.get(); s.readFail = true; window.__qaAuto.persist() })
  await page.getByText('从自动备份恢复', { exact: true }).first().click()
  const rdlg2 = page.getByRole('dialog', { name: '从自动备份恢复' }).first(); await rdlg2.waitFor({ state: 'visible', timeout: 5000 })
  await rdlg2.getByRole('button', { name: '选择' }).first().click()
  const cf2 = page.getByRole('dialog', { name: '从备份恢复？' }).first(); await cf2.waitFor({ state: 'visible', timeout: 5000 })
  await cf2.getByRole('button', { name: '恢复' }).click()
  const errDlg = page.getByRole('dialog', { name: '恢复失败' }).first()
  const errSeen = await errDlg.isVisible().catch(() => false)
  if (errSeen) {
    const et = (await errDlg.innerText()).replace(/\s+/g, ' ')
    record('restoreError', { text: et.slice(0, 200), retry: await errDlg.getByRole('button', { name: '重试' }).count(), close: await errDlg.getByRole('button', { name: '关闭' }).count() })
    await errDlg.getByRole('button', { name: '关闭' }).click()
  }
  await page.evaluate(() => { const s = window.__qaAuto.get(); s.readFail = false; window.__qaAuto.persist() })
  // 异常弹窗：flag anomaly + states 清空
  await page.evaluate(async () => {
    const s = window.__qaAuto.get(); s.flags['auto.anomaly'] = '1'; s.flags['progressAnomaly'] = '1'; s.flags['hadProgress'] = '1'; window.__qaAuto.persist()
    const db = await new Promise((res, rej) => { const r = indexedDB.open('wordc'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error) })
    await new Promise((res, rej) => { const tx = db.transaction(['states', 'meta'], 'readwrite'); tx.objectStore('states').clear(); tx.objectStore('meta').delete('backup.restoreState'); tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  })
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const anomalyDlg = page.getByRole('dialog', { name: '检测到学习进度异常' }).first()
  const anomalyVisible = await anomalyDlg.isVisible().catch(() => false)
  record('anomaly', { visible: anomalyVisible, text: anomalyVisible ? (await anomalyDlg.innerText()).replace(/\s+/g, ' ').slice(0, 120) : '' })
  assert(anomalyVisible, 'hadProgress+states=0 应启动弹异常')
  await anomalyDlg.getByRole('button', { name: '暂不恢复' }).click()
  await page.waitForTimeout(800)
  record('anomalyClosedAgain', { visible: await anomalyDlg.isVisible().catch(() => false) })
  assert(!(await anomalyDlg.isVisible().catch(() => false)), '暂不恢复后本次会话不应再弹')
  await page.screenshot({ path: join(OUT, '77b-autobackup-anomaly-390.png') }).catch(() => {})
  // 360
  await page.setViewportSize({ width: 360, height: 800 }); await page.waitForTimeout(300)
  const layout = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 }))
  record('layout360', layout)
  assert(!layout.overflow, '360 不应横向溢出')
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  assert(result.errors.length === 0, `pageerror/console.error：${JSON.stringify(result.errors)}`)
  result.ok = true; result.durationMs = Date.now() - started
  console.log(`\n[nativebk] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[nativebk] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '78-nativebk-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-nativebk.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
