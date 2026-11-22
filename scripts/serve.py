#!/usr/bin/env python3
"""零依赖静态服务器 —— MaiMemo背单词 PWA 本地运行用。

用途：把 vite 构建产物 dist/ 以 HTTP 方式服务给手机 Chrome，
使其满足 PWA 安装条件（http://127.0.0.1 属于「潜在可信来源」，
Service Worker 可注册、可添加到主屏幕、可离线打开）。

特点：
- 只用 Python 3 标准库（手机 proot / Termux 都能直接跑，无需 node/pnpm）。
- MIME 修正：.webmanifest -> application/manifest+json，.js -> text/javascript，
  .svg/.woff2/.png 等按 Chrome 要求返回（缺省 Python 3.12 已大多正确，这里兜底）。
- index.html / sw.js / manifest.webmanifest 强制 no-cache，避免 PWA 更新被浏览器缓存卡住。
- HashRouter 应用仍做 SPA 回退（无扩展名的 404 路径回 index.html），防止直接输入路径白屏。
- 支持 --host 0.0.0.0 供局域网调试；--port 可换端口。

用法：
    python3 serve.py                          # 127.0.0.1:4173，服务 ./dist
    python3 serve.py --dir /path/to/dist
    python3 serve.py --host 0.0.0.0 --port 4173
    python3 serve.py --check                  # 只检查端口是否可用后退出

停止：Ctrl+C（或 scripts/stop.sh 按 pidfile 结束）。
"""

from __future__ import annotations

import argparse
import http.server
import mimetypes
import os
import socket
import sys
import urllib.parse

# 正确 MIME（Chrome 对 manifest / sw 的 MIME 有要求；Python 3.12 多数已内置，这里显式兜底）
EXTRA_TYPES = {
    ".webmanifest": "application/manifest+json",
    ".manifest": "application/manifest+json",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".css": "text/css",
}

for _ext, _type in EXTRA_TYPES.items():
    if _ext not in mimetypes.types_map:
        mimetypes.add_type(_type, _ext)

NO_CACHE_SUFFIXES = (
    "/index.html",
    "/sw.js",
    "/registerSW.js",
    "/manifest.webmanifest",
)


class PWAServerHandler(http.server.SimpleHTTPRequestHandler):
    """静态文件服务 + PWA 需要的少量修正。"""

    server_version = "MomoPWAServer/1.0"

    def end_headers(self) -> None:
        path = urllib.parse.urlsplit(self.path).path
        if path == "/" or path.endswith(NO_CACHE_SUFFIXES):
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
            self.send_header("Pragma", "no-cache")
        # 允许 sw.js 控制整个 origin（便于以后把 sw.js 放子目录）
        self.send_header("Service-Worker-Allowed", "/")
        super().end_headers()

    def send_head(self):
        """SPA 回退：不存在的「无扩展名路径」回 index.html（HashRouter 下通常用不到）。"""
        try:
            path = self.translate_path(self.path)
            if not os.path.exists(path):
                _, ext = os.path.splitext(urllib.parse.urlsplit(self.path).path)
                if not ext and not self.path.startswith("/assets/"):
                    self.path = "/index.html"
            return super().send_head()
        except (BrokenPipeError, ConnectionResetError):
            return None

    def log_message(self, fmt: str, *args) -> None:
        # 精简日志：时间 请求行 状态
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))


def detect_lan_ip() -> str | None:
    """取本机在局域网/蜂窝网中的地址（不发包，仅用 UDP connect 探测路由）。"""
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.5)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return None


def port_available(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            s.bind((host, port))
            return True
        except OSError:
            return False


def main() -> int:
    parser = argparse.ArgumentParser(description="MaiMemo背单词 PWA 本地静态服务器")
    parser.add_argument("--dir", default="dist", help="静态文件目录（默认 ./dist）")
    parser.add_argument("--host", default="127.0.0.1", help="监听地址（默认 127.0.0.1；局域网用 0.0.0.0）")
    parser.add_argument("--port", type=int, default=4173, help="端口（默认 4173）")
    parser.add_argument("--check", action="store_true", help="只检查端口/目录，不起服务")
    args = parser.parse_args()

    root = os.path.abspath(args.dir)
    if not os.path.isdir(root):
        sys.stderr.write(f"[错误] 静态目录不存在：{root}\n")
        sys.stderr.write("       请先在仓库根目录执行 pnpm build，或修正 --dir。\n")
        return 2
    if not os.path.isfile(os.path.join(root, "index.html")):
        sys.stderr.write(f"[错误] {root}/index.html 不存在，dist 不完整，请重新 pnpm build。\n")
        return 2
    if not port_available(args.host, args.port):
        sys.stderr.write(f"[错误] {args.host}:{args.port} 已被占用。换端口：--port 4174\n")
        return 3
    if args.check:
        print(f"[OK] 目录与端口可用：{root}  http://{args.host}:{args.port}/")
        return 0

    os.chdir(root)  # SimpleHTTPRequestHandler 以 cwd 为根
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    server = http.server.ThreadingHTTPServer((args.host, args.port), PWAServerHandler)
    server.daemon_threads = True

    print("=" * 56)
    print("  MaiMemo背单词 PWA · 本地服务已启动")
    print(f"  目录：{root}")
    print(f"  手机浏览器打开：http://127.0.0.1:{args.port}/")
    if args.host == "0.0.0.0":
        lan = detect_lan_ip()
        if lan:
            print(f"  局域网地址（仅调试，不能装 PWA）：http://{lan}:{args.port}/")
        print("  ⚠️  0.0.0.0 会暴露到局域网，用完请 Ctrl+C 或 scripts/stop.sh")
    print("  PWA 安装：Chrome 菜单 →「安装应用 / 添加到主屏幕」")
    print("  停止：Ctrl+C")
    print("=" * 56)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[停止] 收到 Ctrl+C，正在关闭…")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
