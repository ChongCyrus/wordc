#!/usr/bin/env bash
# =============================================================================
# MaiMemo背单词 PWA · 停止脚本
#   仓库内：  bash scripts/stop.sh
#   交付目录：bash stop.sh
# 依据 .server.pid 找到进程；找不到在跑就提示从哪看。
# 若服务是 agent 直接启动的（无 pidfile），本脚本会尝试按端口找（需要 /proc）。
# =============================================================================
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDFILE="${PIDFILE:-$SCRIPT_DIR/.server.pid}"
PORT="${PORT:-4173}"

stop_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null || return 1
  local i=0
  while kill -0 "$pid" 2>/dev/null; do
    i=$((i + 1))
    [ "$i" -ge 25 ] && { kill -9 "$pid" 2>/dev/null; break; }
    sleep 0.2
  done
  return 0
}

if [ -f "$PIDFILE" ]; then
  PID="$(cat "$PIDFILE" 2>/dev/null || true)"
  rm -f "$PIDFILE"
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    if stop_pid "$PID"; then
      echo "[OK] 已停止服务（PID $PID）"
      exit 0
    fi
    echo "[警告] 无法结束 PID $PID（可能属于其他用户）"
    exit 1
  fi
  echo "[提示] pidfile 里的进程已不在（PID ${PID:-?}），已清理 pidfile"
fi

# 无 pidfile：尝试按端口找 python 进程（proot 里 /proc 可用）
FOUND=""
for p in /proc/[0-9]*; do
  [ -r "$p/cmdline" ] || continue
  if tr '\0' ' ' <"$p/cmdline" 2>/dev/null | grep -q "serve.py.*--port $PORT"; then
    FOUND="$FOUND $(basename "$p")"
  fi
done
if [ -n "${FOUND// /}" ]; then
  for pid in $FOUND; do
    stop_pid "$pid" && echo "[OK] 已停止服务（PID $pid，按端口 $PORT 找到）"
  done
  exit 0
fi

echo "[提示] 没有发现运行中的服务（pidfile 缺失，端口 $PORT 上也没有 serve.py 进程）。"
echo "       若之前由 agent 启动，可运行：ps -ef | grep serve.py"
exit 0
