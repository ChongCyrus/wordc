#!/usr/bin/env bash
# 从 debuggable 包拉取私有数据（SQLite/缓存/SharedPreferences），用于诊断。
# 需要：adb 可用 + 安装的是 debuggable 包（WordC-*-debuggable.apk）。
# 用法：scripts/device/pull-private.sh [package] [outdir]
set -euo pipefail
PKG="${1:-com.wordc.app}"
OUT="${2:-./device-data-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
adb shell run-as "$PKG" sh -c 'cd /data/data/'"$PKG"' && tar -cf - databases files shared_prefs cache app_webview 2>/dev/null' > "$OUT/private.tar" || true
tar -xf "$OUT/private.tar" -C "$OUT" 2>/dev/null || true
echo "已导出到 $OUT"
ls -la "$OUT" | head
