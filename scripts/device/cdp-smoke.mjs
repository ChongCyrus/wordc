#!/usr/bin/env node
import { writeFileSync } from 'node:fs'
// WebView CDP 冒烟：需 debuggable 包 + adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
// 用法：node scripts/device/cdp-smoke.mjs [http://127.0.0.1:9222]
const base = process.argv[2] || 'http://127.0.0.1:9222'
const list = await (await fetch(`${base}/json`)).json()
const page = list.find((x) => x.type === 'page') || list[0]
if (!page) { console.error('没有可用的 WebView page'); process.exit(1) }
console.log('page', page.title, page.url)
const ws = new WebSocket(page.webSocketDebuggerUrl)
let id = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) } }
const send = (method, params = {}) => new Promise((resolve) => { const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params })) })
await new Promise((r) => { ws.onopen = r })
const r = await send('Runtime.evaluate', { expression: 'document.body.innerText.slice(0,500)', returnByValue: true })
console.log(r.result?.result?.value ?? r)
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) writeFileSync('cdp-smoke.png', Buffer.from(shot.result.data, 'base64'))
ws.close()
