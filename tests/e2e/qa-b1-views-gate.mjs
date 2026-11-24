#!/usr/bin/env node
/** 0.4.6 筛选三视图：树 L/折叠持久/叶子sheet、按钮/图谱连线/拖拽/sheet、共享filter、390/360。 */
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { BASE, FIXTURE, OUT, launch, maybeLoadFixture, watchErrors, assert } from './qa-gate-lib.mjs'
const started = Date.now(); const result = { checks: {}, errors: [], ok: false }
const record = (k, v) => { result.checks[k] = v; console.log(`[b1v] ${k}: ${JSON.stringify(v)}`) }
await mkdir(OUT, { recursive: true })
const { page, close } = await launch(); const errors = watchErrors(page)
if (FIXTURE) await page.route('**/packs/**', (r) => r.abort())
const countSel = (sel) => page.locator(sel).count()
try {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 90_000 }); if (FIXTURE) await maybeLoadFixture(page)
  await page.evaluate(() => { localStorage.removeItem('momo:advancedFilter:view'); localStorage.removeItem('momo:advancedFilter:treeRootOpen') })
  await page.goto(`${BASE}#/decks/kaoyan-2027-dagang/filter`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(1200)
  const tree = await page.evaluate(() => ({
    root: document.querySelectorAll('.filter-tree-root-card').length,
    groups: document.querySelectorAll('.filter-tree-node').length,
    leaves: document.querySelectorAll('.filter-tree-leaf').length,
    rootTitle: document.querySelector('.filter-tree-root-title')?.textContent ?? '',
    groupTitle: document.querySelector('.filter-tree-group-title')?.textContent ?? '',
    active: Array.from(document.querySelectorAll('button')).find((b) => b.className.includes('mm-btn--primary'))?.textContent ?? '',
  }))
  record('tree', tree)
  assert(tree.root === 1 && tree.groups === 1 && tree.leaves === 1 && tree.rootTitle === '筛选' && tree.groupTitle === '组 1' && tree.active === '树状', `树状结构异常：${JSON.stringify(tree)}`)
  // 缩进层级
  const indents = await page.evaluate(() => { const root = document.querySelector('.filter-tree-root-card')?.getBoundingClientRect(); const group = document.querySelector('.filter-tree-group-card')?.getBoundingClientRect(); const leaf = document.querySelector('.filter-tree-leaf')?.getBoundingClientRect(); const cs = (sel, pseudo) => { const el = document.querySelector(sel); return getComputedStyle(el, pseudo) }; return { rootX: Math.round(root?.x ?? 0), groupX: Math.round(group?.x ?? 0), leafX: Math.round(leaf?.x ?? 0), groupBefore: cs('.filter-tree-node', '::before').borderLeftWidth, leafBefore: cs('.filter-tree-leaf', '::before').borderLeftWidth } })
  record('indents', indents)
  assert(indents.groupX > indents.rootX && indents.leafX > indents.groupX, `树形无缩进层级：${JSON.stringify(indents)}`)
  // 根折叠
  await page.getByRole('button', { name: '收起根节点' }).click(); await page.waitForTimeout(400)
  const rootClosed = { groups: await countSel('.filter-tree-node'), leaves: await countSel('.filter-tree-leaf') }
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const rootPersist = { groups: await countSel('.filter-tree-node'), arrow: await page.getByRole('button', { name: '展开根节点' }).count() }
  record('rootCollapse', { rootClosed, rootPersist })
  assert(rootClosed.groups === 0 && rootPersist.groups === 0 && rootPersist.arrow === 1, `根折叠/持久失败：${JSON.stringify({ rootClosed, rootPersist })}`)
  await page.getByRole('button', { name: '展开根节点' }).click(); await page.waitForTimeout(400)
  // 组折叠
  await page.getByRole('button', { name: '收起组 1' }).click(); await page.waitForTimeout(400)
  const groupClosed = await countSel('.filter-tree-leaf')
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(700)
  const groupPersist = await page.getByRole('button', { name: '展开组 1' }).count()
  record('groupCollapse', { groupClosed, groupPersist }); assert(groupClosed === 0 && groupPersist === 1, `组折叠/持久失败：${JSON.stringify({ groupClosed, groupPersist })}`)
  await page.getByRole('button', { name: '展开组 1' }).click(); await page.waitForTimeout(400)
  // 叶子 sheet
  await page.locator('.filter-tree-leaf-main').first().click(); await page.waitForTimeout(500)
  const sheet = page.getByRole('dialog', { name: /编辑条件/ }).first(); await sheet.waitFor({ state: 'visible', timeout: 5000 })
  const sheetFields = await sheet.evaluate((d) => ({ text: (d.innerText ?? '').replace(/\s+/g, ' ').slice(0, 160), selects: d.querySelectorAll('select').length, inputs: d.querySelectorAll('input').length }))
  record('leafSheet', sheetFields); assert(/属性/.test(sheetFields.text) && sheetFields.selects >= 2, `叶子 sheet 缺字段：${JSON.stringify(sheetFields)}`)
  await page.screenshot({ path: join(OUT, '147-filter-tree-sheet-390.png') }).catch(() => {})
  await sheet.getByRole('button', { name: '完成' }).click(); await page.waitForTimeout(400)
  // 条件行无重叠；底部按钮同排
  const layout = await page.evaluate(() => ({ leaves: Array.from(document.querySelectorAll('.filter-tree-leaf')).map((el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) } }) }))
  const leafOverlap = layout.leaves.some((r, i) => i > 0 && r.top < layout.leaves[i - 1].bottom - 2)
  const bottomBtns = await page.evaluate(() => ['执行筛选', '保存索引集'].map((name) => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent ?? '').trim() === name); if (!b) return { name, missing: true }; const r = b.getBoundingClientRect(); return { name, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }))
  record('layout', { leafOverlap, bottomBtns }); assert(!leafOverlap, '叶子行重叠'); const btnMetrics = await page.evaluate(() => ['执行筛选', '保存索引集'].map((name) => { const b = Array.from(document.querySelectorAll('button')).find((x) => (x.textContent ?? '').trim() === name); if (!b) return { name, missing: true }; return { name, w: Math.round(b.getBoundingClientRect().width), h: Math.round(b.getBoundingClientRect().height), scrollH: b.scrollHeight, clientH: b.clientHeight, whiteSpace: getComputedStyle(b).whiteSpace } }))
  record('buttonMetrics', btnMetrics)
  assert(btnMetrics.every((b) => !b.missing && b.h <= 56 && b.scrollH <= b.clientH + 1 && b.w >= 80), `底部按钮竖挤/换行：${JSON.stringify(btnMetrics)}`)
  // 加条件/组、执行命中
  await page.getByRole('button', { name: '+ 条件' }).first().click(); await page.waitForTimeout(300)
  await page.getByRole('button', { name: '+ 属性组' }).click(); await page.waitForTimeout(400)
  if (await page.getByRole('button', { name: '展开组 2' }).count()) { await page.getByRole('button', { name: '展开组 2' }).click(); await page.waitForTimeout(300) }
  const afterAdd = { groups: await countSel('.filter-tree-node'), leaves: await countSel('.filter-tree-leaf') }
  record('add', afterAdd); assert(afterAdd.groups === 2 && afterAdd.leaves === 3, `增条件/组失败：${JSON.stringify(afterAdd)}`)
  await page.getByRole('button', { name: /执行筛选/ }).click(); await page.waitForTimeout(900)
  const hit = await page.locator('.filter-tree-group-card').first().innerText()
  record('hit', { hit: hit.replace(/\s+/g, ' ') }); assert(/命中 \d+/.test(hit), `无命中数：${hit}`)
  await page.screenshot({ path: join(OUT, '143-filter-tree-390.png') }).catch(() => {})
  // 图谱
  await page.getByRole('button', { name: '图谱', exact: true }).click(); await page.waitForTimeout(500)
  const graph = await page.evaluate(() => ({ nodes: document.querySelectorAll('.filter-graph-node').length, center: document.querySelector('.filter-graph-center')?.textContent ?? '', lines: Array.from(document.querySelectorAll('.filter-graph-lines line')).map((l) => { const b = l.getBoundingClientRect(); const cs = getComputedStyle(l); return { w: Math.round(b.width), h: Math.round(b.height), stroke: cs.stroke, visibility: cs.visibility, x1: l.getAttribute('x1'), y1: l.getAttribute('y1'), x2: l.getAttribute('x2'), y2: l.getAttribute('y2') } }) }))
  record('graph', graph); assert(graph.nodes === 2 && graph.lines.length === 2 && /组间/.test(graph.center), `图谱结构异常：${JSON.stringify(graph)}`)
  assert(graph.lines.every((l) => (l.x1 !== l.x2 || l.y1 !== l.y2) && l.visibility !== 'hidden' && l.stroke !== 'none'), `图谱连线不可见：${JSON.stringify(graph.lines)}`)
  // 像素检查：连线在节点之外可见
  const gbox = await page.locator('.filter-graph').boundingBox(); const nr = await page.evaluate(() => Array.from(document.querySelectorAll('.filter-graph-node')).map((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } }))
  await page.screenshot({ path: '/tmp/qa-graph.png', clip: gbox })
  const stroke = String(graph.lines[0]?.stroke ?? 'rgb(167, 175, 172)').match(/\d+/g)?.map(Number) ?? [167, 175, 172]
  const py = `import sys,json\nfrom PIL import Image\nim=Image.open('/tmp/qa-graph.png').convert('RGB')\nw,h=im.size\nrects=json.loads(sys.argv[1])\ncols=json.loads(sys.argv[2])\ncount=0\nfor y in range(0,int(h*0.8)):\n  for x in range(w):\n    if any(r['x']-2 <= x <= r['x']+r['w']+2 and r['y']-2 <= y <= r['y']+r['h']+2 for r in rects): continue\n    r,g,b=im.getpixel((x,y))\n    if abs(r-cols[0])<=14 and abs(g-cols[1])<=14 and abs(b-cols[2])<=14: count+=1\nprint(count)`
  const linePixels = Number(execFileSync('python3', ['-c', py, JSON.stringify(nr.map((r) => ({ x: r.x - gbox.x, y: r.y - gbox.y, w: r.w, h: r.h }))), JSON.stringify(stroke)], { encoding: 'utf8' }).trim())
  record('graphLinePixels', { linePixels, stroke })
  assert(linePixels >= 120, `图谱连线像素过少（视觉不可见）：${linePixels}`)
  // 点圆开 sheet
  await page.locator('.filter-graph-node').first().click(); await page.waitForTimeout(500)
  const graphSheet = await page.getByRole('dialog').count(); record('graphSheet', { dialogs: graphSheet }); assert(graphSheet >= 1, '点圆未打开 sheet')
  await page.locator('.mm-mask').last().click({ position: { x: 5, y: 5 }, force: true }); await page.waitForTimeout(500)
  record('graphSheetClosed', { masks: await page.locator('.mm-mask').count() })
  // 拖拽
  const node = page.locator('.filter-graph-node').first(); const box = await node.boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 60, { steps: 5 }); await page.mouse.up(); await page.waitForTimeout(300)
  const box2 = await node.boundingBox(); record('drag', { x1: Math.round(box.x), y1: Math.round(box.y), x2: Math.round(box2.x), y2: Math.round(box2.y) })
  assert(Math.abs(box2.x - box.x) > 5 || Math.abs(box2.y - box.y) > 5, '图谱拖拽无效')
  if (await page.locator('.mm-mask').count()) { await page.locator('.mm-mask').last().click({ position: { x: 5, y: 5 }, force: true }); await page.waitForTimeout(400) }
  await page.screenshot({ path: join(OUT, '144-filter-graph-390.png') }).catch(() => {})
  // 列表共享 filter、视图持久
  await page.getByRole('button', { name: '列表', exact: true }).click(); await page.waitForTimeout(400)
  const list = { groups: await countSel('.advanced-filter-group'), conditions: await countSel('.advanced-filter-row') }
  record('list', list); assert(list.groups === 2 && list.conditions === 3, `列表未共享 filter：${JSON.stringify(list)}`)
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(800)
  const viewAfter = (await page.locator('button.mm-btn--primary').first().textContent()) ?? ''
  record('viewPersist', { viewAfter }); assert(viewAfter === '列表', `视图未持久化：${viewAfter}`)
  // 360 light
  await page.setViewportSize({ width: 360, height: 800 }); await page.getByRole('button', { name: '树状', exact: true }).click(); await page.waitForTimeout(400)
  const small = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1 })); record('smoke360', small); assert(!small.overflow, '360 溢出')
  await page.screenshot({ path: join(OUT, '146-filter-tree-360.png') }).catch(() => {})
  if (FIXTURE) errors.consoleErrors = errors.consoleErrors.filter((t) => !/packs|ERR_FAILED|Failed to load resource/.test(t))
  result.errors = [...errors.pageErrors, ...errors.consoleErrors]
  result.ok = true; result.durationMs = Date.now() - started; console.log(`\n[b1v] PASS in ${(result.durationMs / 1000).toFixed(1)}s`)
} catch (e) {
  result.ok = false; result.durationMs = Date.now() - started; result.failReason = e instanceof Error ? e.message : String(e)
  console.error(`\n[b1v] FAIL: ${result.failReason}`); await page.screenshot({ path: join(OUT, '45-b1views-failure.png') }).catch(() => {}); process.exitCode = 1
} finally { await writeFile(join(OUT, 'qa-b1views.json'), JSON.stringify(result, null, 2)); await close().catch(() => {}) }
