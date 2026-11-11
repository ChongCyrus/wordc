#!/usr/bin/env bash
# =============================================================================
# WordC · 最小 WebView 壳 APK 构建脚本（无需 Android SDK / Gradle）
#
# 一条命令重跑：
#   bash tools/apk/build-apk.sh                # 用现有 dist/ 重新打包（默认，快）
#   BUILD_PWA=1 bash tools/apk/build-apk.sh    # 先 pnpm build 再打包（会跑一次构建，注意资源纪律）
#
# 产物：
#   tools/apk/build/WordC-<version>.apk
#   $APK_DEST/WordC-<version>.apk（本地默认 /sdcard/Download/DSH-Go；CI 用 $PWD/out）
#
# CI / 自动化可覆盖的环境变量（均有默认值，本地用法不变）：
#   APK_DEST             交付目录（默认 /sdcard/Download/DSH-Go；不可写时只保留在 build/，不报错）
#   APK_KEYSTORE         签名 keystore 路径（默认 .secrets/apk-release.jks）
#   APK_KEYSTORE_PASS    keystore/key 口令（设置后脚本写临时两行 passfile，退出前删除）
#   APK_KEY_ALIAS        key alias（默认 momo）
#   APK_TOOLCHAIN        android.jar/r8.jar 所在目录（默认 tools/apk/toolchain）
#   VERSION_CODE         版本号（默认读 tools/apk/version.json 的 code；env 优先）
#   VERSION              versionName（默认 package.json 的 version；env 优先）
#
# 依赖（一次性安装，见 docs/APK.md）：
#   apt install -y openjdk-17-jdk-headless aapt zipalign apksigner android-sdk-platform-23
#   tools/apk/toolchain/{android.jar, r8.jar}（android.jar 为 API 23 编译桩，r8 提供 d8）
#
# 说明：
#   - 编译目标 API 23（本机 apt 可得的最小 android.jar），manifest 声明 targetSdk 34；
#     用到的 API（shouldInterceptRequest/WebResourceRequest/WebResourceResponse）均为 API≤23。
#   - 签名用自签 keystore（.secrets/apk-release.jks，口令 .secrets/apk-keystore-pass 600 权限）。
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TOOLCHAIN="${APK_TOOLCHAIN:-$SCRIPT_DIR/toolchain}"
SRC="$SCRIPT_DIR/src"
RES="$SCRIPT_DIR/res"
ASSETS="$SCRIPT_DIR/assets"
BUILD="$SCRIPT_DIR/build"
SECRETS="$ROOT/.secrets"
KEYSTORE="${APK_KEYSTORE:-$SECRETS/apk-release.jks}"
PASSFILE="$SECRETS/apk-keystore-pass"
KEY_ALIAS="${APK_KEY_ALIAS:-momo}"
DEST_DIR="${APK_DEST:-/sdcard/Download/DSH-Go}"
CI_PASS_TMP=0
ANDROID_JAR="$TOOLCHAIN/android.jar"
R8_JAR="$TOOLCHAIN/r8.jar"

say() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
die() { printf '\033[31m[错误] %s\033[0m\n' "$1" >&2; exit 1; }

# ---------- 0. 环境自检 ----------
say "环境自检"
for c in java javac keytool aapt zipalign apksigner zip unzip sha256sum node; do
  command -v "$c" >/dev/null 2>&1 || die "缺少命令：$c（见 docs/APK.md 的一次性安装步骤）"
done
[ -f "$ANDROID_JAR" ] || die "缺少 $ANDROID_JAR（可用 apt install android-sdk-platform-23 后 cp 进来）"
[ -f "$R8_JAR" ] || die "缺少 $R8_JAR（下载 r8-<ver>.jar，见 docs/APK.md）"
java -version 2>&1 | head -1
aapt version 2>&1 | head -1
apksigner version 2>&1 | head -1

DEFAULT_VERSION="$(node -p "require('$ROOT/package.json').version" 2>/dev/null || true)"
if [ -z "$DEFAULT_VERSION" ]; then
  DEFAULT_VERSION="$(node -p "require('$SCRIPT_DIR/version.json').version" 2>/dev/null || echo 0.1.0)"
fi
VERSION="${VERSION:-$DEFAULT_VERSION}"
VERSION_CODE="${VERSION_CODE:-$(node -p "require('$SCRIPT_DIR/version.json').code" 2>/dev/null || echo 1)}"
APK_NAME="WordC-${VERSION}.apk"
echo "版本：$VERSION（versionCode=$VERSION_CODE）    APK：$APK_NAME"

# ---------- 1. PWA 产物 ----------
say "准备 PWA 产物（assets/pwa = dist/）"
if [ "${BUILD_PWA:-0}" = "1" ]; then
  echo "[BUILD_PWA=1] 先执行 pnpm build …"
  (cd "$ROOT" && pnpm build)
fi
[ -f "$ROOT/dist/index.html" ] || die "找不到 $ROOT/dist/index.html —— 先 pnpm build，或用 BUILD_PWA=1 运行本脚本"
DEck_CHUNK="$(ls "$ROOT/dist/assets"/kaoyan-2027-dagang.deck-*.js 2>/dev/null | head -1 || true)"
if [ -n "$DEck_CHUNK" ]; then
  if grep -aq 'phrases' "$DEck_CHUNK"; then
    echo "[OK] 受限商业词表 deck chunk 含 phrases 数据（$(du -h "$DEck_CHUNK" | cut -f1)）"
  else
    echo "[警告] deck chunk 未检出 phrases 字段，确认 dist 是否为最新构建"
  fi
fi
rm -rf "$ASSETS/pwa"
mkdir -p "$ASSETS/pwa"
cp -a "$ROOT/dist/." "$ASSETS/pwa/"
[ -f "$ASSETS/pwa/index.html" ] || die "cp dist -> assets/pwa 失败"
echo "[OK] assets/pwa：$(find "$ASSETS/pwa" -type f | wc -l) 个文件，$(du -sh "$ASSETS/pwa" | cut -f1)"

# ---------- 2. manifest 注入版本号 ----------
say "生成 AndroidManifest（注入 versionName=$VERSION）"
mkdir -p "$BUILD"
sed -e "s/@VERSION_NAME@/${VERSION}/g" -e "s/@VERSION_CODE@/${VERSION_CODE}/g" \
  "$SCRIPT_DIR/AndroidManifest.xml" >"$BUILD/AndroidManifest.xml"
grep -E 'versionName|targetSdk|minSdk|package=' "$BUILD/AndroidManifest.xml" | sed 's/^[[:space:]]*//'

# ---------- 3. keystore ----------
say "自签 keystore"
mkdir -p "$SECRETS"
chmod 700 "$SECRETS"
if [ -n "${APK_KEYSTORE_PASS:-}" ]; then
  # CI：口令来自 secrets；写临时两行 passfile（apksigner 按行读取），签名后删除，不落盘常驻
  PASSFILE="$(mktemp "$SECRETS/.apk-pass.XXXXXX")"
  printf '%s\n%s\n' "$APK_KEYSTORE_PASS" "$APK_KEYSTORE_PASS" >"$PASSFILE"
  chmod 600 "$PASSFILE"
  CI_PASS_TMP=1
  echo "[CI] 使用 APK_KEYSTORE_PASS 生成临时口令文件"
fi
if [ ! -f "$PASSFILE" ]; then
  PASS="$(head -c 24 /dev/urandom | base64 | tr -d '/+=\n')"
  # apksigner 的 file: 口令输入按行读取：第 1 行 keystore、第 2 行 key（同值写两行）
  printf '%s\n%s\n' "$PASS" "$PASS" >"$PASSFILE"
  chmod 600 "$PASSFILE"
  echo "[新] 生成口令文件：$PASSFILE（600，两行同值）"
fi
chmod 600 "$PASSFILE"
# 兼容早期单行文件：补第二行
if [ "$(wc -l <"$PASSFILE")" -lt 2 ]; then
  P="$(head -1 "$PASSFILE")"
  printf '%s\n%s\n' "$P" "$P" >"$PASSFILE"
  chmod 600 "$PASSFILE"
  echo "[修复] 口令文件补第二行（apksigner key-pass 需要）"
fi
STORE_PASS="$(head -1 "$PASSFILE")"
if [ ! -f "$KEYSTORE" ]; then
  if [ -n "${APK_KEYSTORE:-}" ]; then
    die "APK_KEYSTORE 指定的 keystore 不存在：$KEYSTORE"
  fi
  keytool -genkeypair -v -keystore "$KEYSTORE" -alias "$KEY_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$STORE_PASS" -keypass "$STORE_PASS" \
    -dname "CN=Momo ReWord Shell, OU=personal, O=local, L=Shanghai, ST=Shanghai, C=CN" >/dev/null
  chmod 600 "$KEYSTORE"
  echo "[新] 生成 keystore：$KEYSTORE"
else
  echo "[复用] keystore：$KEYSTORE"
fi

# ---------- 4. javac ----------
say "javac 编译 Java 源码"
rm -rf "$BUILD/classes" "$BUILD/dex"
mkdir -p "$BUILD/classes" "$BUILD/dex"
javac -encoding UTF-8 -source 8 -target 8 -nowarn \
  -cp "$ANDROID_JAR" -d "$BUILD/classes" \
  $(find "$SRC" -name '*.java')
echo "[OK] class 文件：$(find "$BUILD/classes" -name '*.class' | wc -l) 个"

# ---------- 5. d8 → classes.dex ----------
say "d8 生成 classes.dex"
java -cp "$R8_JAR" com.android.tools.r8.D8 \
  --release --min-api 24 --lib "$ANDROID_JAR" \
  --output "$BUILD/dex" \
  $(find "$BUILD/classes" -name '*.class')
[ -f "$BUILD/dex/classes.dex" ] || die "d8 未生成 classes.dex"
echo "[OK] classes.dex：$(du -h "$BUILD/dex/classes.dex" | cut -f1)"
# 桥接自检：MomoApi（MaiMemo导入）与 AiApi（AI 生成）都必须在 dex 中
grep -aq 'MomoApi' "$BUILD/dex/classes.dex" || die "dex 缺少 MomoApi 桥"
grep -aq 'AiApi' "$BUILD/dex/classes.dex" || die "dex 缺少 AiApi 桥"
grep -aq '__aiApiHostResult' "$BUILD/dex/classes.dex" || die "dex 缺少 AI host 确认回调"
echo "[OK] dex 含 MomoApi / AiApi / __aiApiHostResult"

# ---------- 6. aapt 打包 ----------
say "aapt 打包资源与 assets"
rm -f "$BUILD/app-unsigned.apk" "$BUILD/app-aligned.apk" "$BUILD/app-signed.apk"
aapt package -f \
  -M "$BUILD/AndroidManifest.xml" \
  -S "$RES" \
  -A "$ASSETS" \
  -I "$ANDROID_JAR" \
  -F "$BUILD/app-unsigned.apk"
[ -f "$BUILD/app-unsigned.apk" ] || die "aapt package 失败"
# 把 classes.dex 放进 APK 根目录
(cd "$BUILD/dex" && zip -q -X "$BUILD/app-unsigned.apk" classes.dex)
unzip -l "$BUILD/app-unsigned.apk" | grep -q 'classes.dex' || die "APK 内没有 classes.dex"

# 让 APK 内桌面图标与源文件逐字节一致（aapt 会做 PNG crunch，导致 sha256 与源文件不同）。
# 资源表引用路径不变，仅用原始 PNG 替换打包后的同一 zip 条目；zipalign/签名在其后完成。
APP_ICON_ENTRY="res/mipmap-xxxhdpi-v4/ic_launcher.png"
SRC_ICON="$RES/mipmap-xxxhdpi/ic_launcher.png"
if unzip -l "$BUILD/app-unsigned.apk" | grep -q "$APP_ICON_ENTRY"; then
  ICON_TMP="$(mktemp -d)"
  mkdir -p "$ICON_TMP/$(dirname "$APP_ICON_ENTRY")"
  cp "$SRC_ICON" "$ICON_TMP/$APP_ICON_ENTRY"
  (cd "$ICON_TMP" && zip -q -X "$BUILD/app-unsigned.apk" "$APP_ICON_ENTRY")
  rm -rf "$ICON_TMP"
  echo "[OK] launcher 图标已还原为源文件字节（$SRC_ICON）"
fi
echo "[OK] unsigned APK：$(du -h "$BUILD/app-unsigned.apk" | cut -f1)"

# ---------- 7. zipalign + 签名 ----------
say "zipalign + apksigner 签名（v1+v2+v3）"
zipalign -f 4 "$BUILD/app-unsigned.apk" "$BUILD/app-aligned.apk"
apksigner sign \
  --ks "$KEYSTORE" --ks-key-alias "$KEY_ALIAS" \
  --ks-pass "file:$PASSFILE" --key-pass "file:$PASSFILE" \
  --min-sdk-version 23 \
  --min-sdk-version 21 --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true \
  --out "$BUILD/app-signed.apk" \
  "$BUILD/app-aligned.apk"
[ -f "$BUILD/app-signed.apk" ] || die "apksigner sign 失败"
if [ "$CI_PASS_TMP" = "1" ]; then
  rm -f "$PASSFILE"
  echo "[CI] 临时口令文件已删除"
fi

# ---------- 8. 自检 ----------
say "自检：apksigner verify + aapt badging + assets 一致性"
apksigner verify --verbose "$BUILD/app-signed.apk" | head -12
echo "--- aapt dump badging ---"
aapt dump badging "$BUILD/app-signed.apk" | grep -E "^package:|^application-label|^sdkVersion|^targetSdkVersion|^launchable-activity" || true
echo "--- assets/pwa/index.html 是否为最新 dist ---"
H_DIST="$(sha256sum "$ROOT/dist/index.html" | cut -d' ' -f1)"
H_APK="$(unzip -p "$BUILD/app-signed.apk" assets/pwa/index.html | sha256sum | cut -d' ' -f1)"
if [ "$H_DIST" = "$H_APK" ]; then
  echo "[PASS] index.html 一致：$H_DIST"
else
  die "index.html 不一致：dist=$H_DIST apk=$H_APK"
fi
ls -la "$BUILD/app-signed.apk"

# ---------- 9. 交付 ----------
say "交付到 $DEST_DIR"
SHA="$(sha256sum "$BUILD/app-signed.apk" | cut -d' ' -f1)"
SIZE="$(stat -c%s "$BUILD/app-signed.apk")"
echo "APK（build）：$BUILD/app-signed.apk"
echo "大小：$SIZE B（$(du -h "$BUILD/app-signed.apk" | cut -f1)）"
echo "SHA256：$SHA"
echo "包名：com.wordc.app   版本：$VERSION（versionCode=$VERSION_CODE）   签名：自签（v1+v2+v3）"
if mkdir -p "$DEST_DIR" 2>/dev/null && [ -w "$DEST_DIR" ]; then
  cp -f "$BUILD/app-signed.apk" "$DEST_DIR/$APK_NAME"
  echo "APK：$DEST_DIR/$APK_NAME"
  echo ""
  echo "安装：手机文件管理器打开 $DEST_DIR/$APK_NAME，允许\"安装未知应用\"即可；首次启动无需联网。"
else
  echo "[SKIP] 交付目录不可写（$DEST_DIR）；APK 保留在 $BUILD/app-signed.apk（CI 从 artifact/输出目录取）"
fi
