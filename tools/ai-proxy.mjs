#!/usr/bin/env node
/**
 * AI 本地代理（task-72）——给浏览器/PWA 补 CORS，避免把上游 host 暴露给页面。
 *
 * 只监听 127.0.0.1；上游由**启动者**用 env 固定（防 SSRF：页面不能指定上游）。
 * 只转发 POST /v1/chat/completions；不转发 Cookie；不打印 Authorization/正文。
 *
 * 用法：
 *   AI_UPSTREAM=https://api.deepseek.com node tools/ai-proxy.mjs
 *   # App 设置页 AI 代理地址填 http://127.0.0.1:8788
 *
 * env：PORT（8788）/ HOST（127.0.0.1）/ AI_UPSTREAM（默认 https://api.deepseek.com）
 *      AI_PATH（默认 /v1/chat/completions）/ AI_TIMEOUT_MS（默认 60000）/ AI_MAX_BODY（默认 2MB）
 */
import http from 'node:http'

const PORT = Number(process.env.PORT || 8788)
const HOST = process.env.HOST || '127.0.0.1'
const UPSTREAM = (process.env.AI_UPSTREAM || 'https://api.deepseek.com').replace(/\/$/, '')
const ALLOWED_PATH = process.env.AI_PATH || '/v1/chat/completions'
const TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 60000)
const MAX_BODY = Number(process.env.AI_MAX_BODY || 2 * 1024 * 1024)
const FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'user-agent']

let upstreamUrl
try {
  upstreamUrl = new URL(UPSTREAM)
  if (upstreamUrl.protocol !== 'https:' && upstreamUrl.protocol !== 'http:') throw new Error('协议必须是 http(s)')
} catch (e) {
  console.error('[ai-proxy] AI_UPSTREAM 无效：' + e.message)
  process.exit(1)
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(data)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('BODY_TOO_LARGE'), { code: 'BODY_TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || HOST}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS)
    res.end()
    return
  }
  if (req.method !== 'POST' || url.pathname !== ALLOWED_PATH) {
    // 只允许固定路径；其余 404（防被当通用代理）
    send(res, 404, { error: 'not_found', message: `仅支持 POST ${ALLOWED_PATH}` })
    return
  }
  let body
  try {
    body = await readBody(req)
  } catch (e) {
    send(res, e.code === 'BODY_TOO_LARGE' ? 413 : 400, { error: 'bad_request', message: e.message })
    return
  }
  const headers = { 'content-type': req.headers['content-type'] || 'application/json' }
  for (const h of FORWARD_HEADERS) {
    if (req.headers[h]) headers[h] = req.headers[h]
  }
  if (!headers.authorization) {
    send(res, 401, { error: 'unauthorized', message: '缺少 Authorization（Key 只在本机转发，不落日志）' })
    return
  }
  const target = UPSTREAM + ALLOWED_PATH
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const upstream = await fetch(target, { method: 'POST', headers, body, signal: controller.signal, redirect: 'manual' })
    const text = await upstream.text()
    // 日志只记方法/路径/状态/大小；不打印 headers/body
    console.log(`[ai-proxy] POST ${ALLOWED_PATH} -> ${upstream.status} ${text.length}B`)
    send(res, upstream.status, text, upstream.headers.get('content-type') || 'application/json')
  } catch (e) {
    const aborted = e?.name === 'AbortError'
    console.warn(`[ai-proxy] ${aborted ? 'timeout' : 'upstream_error'} (${e?.message?.slice(0, 80)})`)
    send(res, aborted ? 504 : 502, { error: aborted ? 'timeout' : 'upstream_error', message: aborted ? '上游超时' : '上游不可达' })
  } finally {
    clearTimeout(timer)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`[ai-proxy] listening http://${HOST}:${PORT} -> ${UPSTREAM}${ALLOWED_PATH}`)
  console.log('[ai-proxy] 只转发固定路径；不记录 Authorization/请求体；Ctrl+C 结束')
})
