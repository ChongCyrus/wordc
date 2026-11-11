#!/usr/bin/env bash
# =============================================================================
# MaiMemo背单词 PWA · 启动脚本（零依赖，只要 python3）
#
# 两种用法都能跑：
#   ① 仓库内：      bash scripts/start.sh          → 自动用 ../dist
#   ② 交付目录内：  bash start.sh                  → 自动用 ./dist
#                    （/sdcard/Download/DSH-Go/momo-pwa/start.sh）
#
# 常用环境变量：
#   PORT=4173          端口（默认 4173；⚠️ 端口变了 = PWA 的 origin 变了 = 学习数据看起来“没了”）
#   HOST=127.0.0.1     监听地址（默认只给本机手机浏览器用；局域网调试用 0.0.0.0）
#   PYTHON=python3     指定解释器
#
# 输出：成功后在 $SCRIPT_DIR/logs/server.log 有访问日志，$SCRIPT_DIR/.server.pid 有 PID。
# 停止：bash stop.sh（交付目录内）或 bash scripts/stop.sh（仓库内）
# =============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4173}"
PY="${PYTHON:-python3}"

# dist 位置：交付目录优先 ./dist，仓库内退到 ../dist
if [ -d "$SCRIPT_DIR/dist" ]; then
  DIST="$SCRIPT_DIR/dist"
elif [ -d "$SCRIPT_DIR/../dist" ]; then
  DIST="$SCRIPT_DIR/../dist"
else
  echo "[错误] 找不到 dist/ 目录。"
  echo "       仓库内请先执行：pnpm build（或 bash scripts/deliver.sh）"
  echo "       交付目录里应包含 dist/，若缺失请重新拷贝交付包。"
  exit 1
fi

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "[错误] 未找到 $PY。本脚本需要 Python 3（proot / Termux 一般自带）。"
  echo "       没有终端的话：请让 agent 启动服务器（见 使用说明）。"
  exit 1
fi

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="/tmp"
LOG="${LOG:-$LOG_DIR/server.log}"
PIDFILE="${PIDFILE:-$SCRIPT_DIR/.server.pid}"

# 已在运行则直接提示，避免起两个抢端口
if [ -f "$PIDFILE" ]; then
  OLD_PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [ -n "${OLD_PID:-}" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "[提示] 服务已在运行（PID $OLD_PID）"
    echo "       地址：http://127.0.0.1:$PORT/"
    echo "       停止：bash \"$SCRIPT_DIR/stop.sh\"；重启：先 stop 再 start"
    exit 0
  fi
  rm -f "$PIDFILE"
fi

# 端口自检（serve.py 内部也会再检查一次）
if ! "$PY" "$SCRIPT_DIR/serve.py" --dir "$DIST" --host "$HOST" --port "$PORT" --check; then
  echo "[提示] 端口 $PORT 不可用。换端口示例：PORT=4174 bash \"$SCRIPT_DIR/start.sh\""
  echo "       （换端口后 PWA 会是新的 origin，学习数据不共享）"
  exit 1
fi

nohup "$PY" "$SCRIPT_DIR/serve.py" --dir "$DIST" --host "$HOST" --port "$PORT" >>"$LOG" 2>&1 &
PID=$!
echo "$PID" >"$PIDFILE"
sleep 1

if kill -0 "$PID" 2>/dev/null; then
  echo "[OK] 服务已启动（PID $PID，后台运行）"
  echo ""
  echo "  手机浏览器打开：http://127.0.0.1:$PORT/"
  if [ "$HOST" = "0.0.0.0" ]; then
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $NF}')"
    [ -n "${LAN_IP:-}" ] && echo "  局域网（仅调试，不能安装 PWA）：http://$LAN_IP:$PORT/"
    echo "  ⚠️  0.0.0.0 会把服务暴露到局域网，用完请 stop"
  fi
  echo ""
  echo "  PWA 安装：Chrome 打开上面的 127.0.0.1 地址 → 菜单 →「安装应用 / 添加到主屏幕」"
  echo "            安装后即可离线使用，服务器可以关掉。"
  echo "  日志：$LOG"
  echo "  停止：bash \"$SCRIPT_DIR/stop.sh\""
else
  echo "[错误] 启动失败，最近日志："
  tail -n 20 "$LOG" 2>/dev/null
  rm -f "$PIDFILE"
  exit 1
fi
