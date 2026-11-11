#!/usr/bin/env node
/**
 * 墨墨开放 API 本地小代理（SPEC §7 / D23 / D36）。
 *
 * 为什么需要：open.maimemo.com 不返回 `Access-Control-Allow-Origin`，浏览器里的 PWA 直连会被
 * CORS 拦截。官方文档也要求应用审核通过后才放开跨域。这个脚本把请求原样转发并补 CORS 头，
 * **只监听 127.0.0.1**，Token 由浏览器每次请求带过来（代理不存储、不打印 Token）。
 *
 * 用法（电脑上开一个终端）：
 *   node src/data/api/maimemo-proxy.mjs
 *   # 然后把 App 设置页「墨墨代理地址」填为 http://127.0.0.1:8787（默认值即此）
 *   # Ctrl+C 结束（用完就关，不要长期常驻）
 *
 * 环境变量：PORT（默认 8787）、HOST（默认 127.0.0.1）、UPSTREAM（默认 https://open.maimemo.com）
 *
 * 安全：
 * - 只转发 `/open/...` 路径，其它 404；
 * - 只允许本机访问（127.0.0.1），不会暴露到局域网；
 * - 不记录 Authorization 头，不落盘任何数据。
 */

import http from 'node:http'
import { pathToFileURL } from 'node:url'

const DEFAULT_UPSTREAM = 'https://open.maimemo.com'
const FORWARD_HEADERS = ['authorization', 'content-type', 'accept', 'user-agent']

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
}

/** 读取请求体（Buffer） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function writeJson(res, status, payload) {
  const text = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    ...CORS_HEADERS,
  })
  res.end(text)
}

/**
 * 创建代理 server（不自动 listen，方便测试/嵌入）。
 * @param {{ upstream?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {import('node:http').Server}
 */
export function createProxyServer(options = {}) {
  const upstream = (options.upstream ?? DEFAULT_UPSTREAM).replace(/\/+$/, '')
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))

  const server = http.createServer(async (req, res) => {
    try {
      // CORS 预检
      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS)
        res.end()
        return
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      // 只允许代理 open API 路径，避免变成任意 SSRF 跳板
      if (!url.pathname.startsWith('/open/')) {
        writeJson(res, 404, { ok: false, error: 'only /open/* paths are proxied' })
        return
      }

      const headers = {}
      for (const name of FORWARD_HEADERS) {
        const value = req.headers[name]
        if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(', ') : value
      }

      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await readBody(req)
      const target = `${upstream}${url.pathname}${url.search}`
      const startedAt = Date.now()

      let response
      try {
        response = await fetchImpl(target, {
          method: req.method,
          headers,
          body: body && body.length > 0 ? body : undefined,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`${req.method} ${url.pathname} -> 502 upstream error: ${message}`)
        writeJson(res, 502, { ok: false, error: `upstream request failed: ${message}` })
        return
      }

      const buffer = Buffer.from(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') ?? 'application/json; charset=utf-8'
      res.writeHead(response.status, {
        'Content-Type': contentType,
        'Content-Length': buffer.length,
        ...CORS_HEADERS,
      })
      res.end(buffer)
      log(`${req.method} ${url.pathname} -> ${response.status} (${buffer.length}B, ${Date.now() - startedAt}ms)`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson(res, 500, { ok: false, error: message })
    }
  })
  return server
}

function log(message) {
  // 只打印方法/路径/状态码：绝不打印 Authorization / Token / 请求体
  process.stdout.write(`[maimemo-proxy] ${message}\n`)
}

/**
 * 启动代理。
 * @param {{ port?: number, host?: string, upstream?: string, fetchImpl?: typeof fetch }} [options]
 */
export function startProxy(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1'
  const port = options.port ?? Number(process.env.PORT ?? 8787)
  const server = createProxyServer(options)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      const actualPort = typeof address === 'object' && address ? address.port : port
      process.stdout.write(
        `[maimemo-proxy] listening on http://${host}:${actualPort}\n` +
          `[maimemo-proxy] 在 App 设置页把「墨墨代理地址」填为 http://${host}:${actualPort}\n` +
          '[maimemo-proxy] 用完请 Ctrl+C 关闭；代理不存储 Token、不记录 Authorization\n',
      )
      resolve({ server, port: actualPort, host, url: `http://${host}:${actualPort}` })
    })
  })
}

// 直接 node 运行脚本时启动；被 import（测试）时不自动启动
const isMain =
  typeof process.argv[1] === 'string' &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  startProxy().catch((error) => {
    process.stderr.write(`[maimemo-proxy] 启动失败：${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
  const shutdown = () => {
    process.stdout.write('\n[maimemo-proxy] shutting down\n')
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
