#!/usr/bin/env bash
# 无头浏览器 E2E 一键运行（aarch64 proot）
#
# 用法：
#   bash tools/e2e/run.sh            # 前置检查 + 跑 smoke 用例
#   bash tools/e2e/run.sh --check    # 只做环境/服务自检，不启动浏览器
#   E2E_BASE=http://127.0.0.1:4174/ bash tools/e2e/run.sh
#
# 前置：
#   - 应用服务已在 http://127.0.0.1:4173/ 运行（`bash scripts/start.sh`；本脚本不会启动/停止它）
#   - 已按 docs/E2E.md 完成 chromium 解包与 npm install（本脚本只检查，不下载）
# 退出码：0 全通过；1 有失败；2 环境/服务不可用
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$HERE/../.." && pwd)"
BASE="${E2E_BASE:-http://127.0.0.1:4173/}"
CHROME="$HERE/chromium/usr/lib/chromium/chromium"
export LD_LIBRARY_PATH="$HERE/chromium/usr/lib/aarch64-linux-gnu:$HERE/chromium/usr/lib/chromium${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }

echo "== 环境自检 =="
echo "项目根：$PROJECT_ROOT"
echo "服务：  $BASE"

fail=0
if [[ ! -x "$CHROME" ]]; then
  red "❌ 未找到可执行 Chromium：$CHROME"
  echo "   请先按 docs/E2E.md『搭建步骤』解包 Debian arm64 chromium"
  fail=1
else
  green "✅ Chromium：$("$CHROME" --version 2>/dev/null || echo '存在但 --version 失败')"
fi

if [[ ! -d "$HERE/node_modules/playwright-core" ]]; then
  red "❌ 未安装 playwright-core（tools/e2e/node_modules 缺失）"
  echo "   执行：cd tools/e2e && npm install --registry=https://registry.npmmirror.com"
  fail=1
else
  green "✅ playwright-core：$(node -e "console.log(require('$HERE/node_modules/playwright-core/package.json').version)" 2>/dev/null || echo ok)"
fi

if command -v curl >/dev/null 2>&1; then
  if curl -sf -o /dev/null --max-time 8 "$BASE"; then
    green "✅ 应用服务可访问"
  else
    red "❌ 应用服务不可访问：$BASE"
    echo "   请先运行 arch 的启动脚本：bash $PROJECT_ROOT/scripts/start.sh"
    fail=1
  fi
else
  red "❌ 缺少 curl，无法检查服务"
  fail=1
fi

if [[ "$fail" -ne 0 ]]; then
  red "环境自检未通过，未启动浏览器。"
  exit 2
fi
echo

if [[ "${1:-}" == "--check" ]]; then
  green "环境自检通过（--check，未运行用例）"
  exit 0
fi

echo "== 运行 smoke 用例（单 Chromium 实例，串行）=="
node "$HERE/smoke.mjs"
code=$?
case "$code" in
  0) green "✅ E2E 全部通过" ;;
  1) red "❌ E2E 有失败，见上方日志与 docs/assets/e2e/fail-*.png" ;;
  *) red "❌ E2E 环境异常（exit=$code）" ;;
esac
exit "$code"
