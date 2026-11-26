#!/usr/bin/env bash
# 无头真机生命周期：强杀/重启/截图/内存/日志
set -euo pipefail
PKG="${1:-com.wordc.app}"
ACT="${2:-.MainActivity}"
adb shell am force-stop "$PKG"
adb shell am start -n "$PKG/$ACT" >/dev/null
sleep 6
adb exec-out screencap -p > "restart-$(date +%H%M%S).png"
adb shell dumpsys meminfo "$PKG" | head -30
adb logcat -d -t 300 | grep -Ei "$PKG|FATAL|AndroidRuntime" | tail -50 || true
