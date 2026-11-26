#!/usr/bin/env bash
# 0.16 QA/日用包隔离检查（只读；ADB_INSTALL=1 时才安装）
# usage: bash tests/e2e/qa-0.16-package-inspect.sh <qa.apk> <daily.apk>
set -euo pipefail
QA_APK="${1:?qa apk path}"; DAILY_APK="${2:?daily apk path}"
AAPT="${AAPT:-aapt}"; ADB="${ADB:-adb}"
command -v "$AAPT" >/dev/null || { echo "SKIP/FAIL: aapt not found; set AAPT=" >&2; exit 2; }
info() { "$AAPT" dump badging "$1" | grep -E '^(package:|application-label:|sdkVersion|targetSdkVersion)' | sed "s#^#$(basename "$1"): #"; }
info "$QA_APK"; info "$DAILY_APK"
QPKG=$("$AAPT" dump badging "$QA_APK" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)
DPKG=$("$AAPT" dump badging "$DAILY_APK" | sed -n "s/^package: name='\([^']*\)'.*/\1/p" | head -1)
QCODE=$("$AAPT" dump badging "$QA_APK" | sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p" | head -1)
DCODE=$("$AAPT" dump badging "$DAILY_APK" | sed -n "s/^package:.*versionCode='\([^']*\)'.*/\1/p" | head -1)
echo "qa_package=$QPKG qa_versionCode=$QCODE"
echo "daily_package=$DPKG daily_versionCode=$DCODE"
if [ "$QPKG" = "$DPKG" ]; then echo "FAIL: QA 与日用 package 相同，无法共存/隔离"; exit 1; fi
if [ "${ADB_INSTALL:-0}" = "1" ]; then
  command -v "$ADB" >/dev/null || { echo "FAIL: adb not found"; exit 2; }
  "$ADB" install -r "$QA_APK"; "$ADB" install -r "$DAILY_APK"
  "$ADB" shell pm list packages | grep -E "$QPKG|$DPKG" || true
  echo "INSTALLED: 请分别启动两包，各评1词并核对数据互不可见；卸载其一验证另一保留"
else
  echo "READONLY: 未安装（ADB_INSTALL=1 可安装）；package 不同 PASS"
fi
