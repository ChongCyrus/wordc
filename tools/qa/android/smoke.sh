#!/system/bin/sh
# 0.15 Android 真机 shell smoke：uiautomator dump + input tap，不依赖无障碍服务
PKG=com.wordc.app
OUT=下载/qa
XML=下载/qa/ui.xml
mkdir -p "$OUT"

dump() {
  uiautomator dump "$XML" >/dev/null 2>&1
  [ -s "$XML" ] || return 1
}

bounds_of() {
  dump || return 1
  tr '>' '\n' < "$XML" | grep -F "$1" | head -1 | sed -n 's/.*bounds="\[\([0-9]*\),\([0-9]*\)\]\[\([0-9]*\),\([0-9]*\)\]".*/\1 \2 \3 \4/p'
}

tap_text() {
  _b=$(bounds_of "$1") || return 1
  [ -n "$_b" ] || return 1
  _x1=$(echo "$_b" | cut -d' ' -f1)
  _y1=$(echo "$_b" | cut -d' ' -f2)
  _x2=$(echo "$_b" | cut -d' ' -f3)
  _y2=$(echo "$_b" | cut -d' ' -f4)
  input tap $(( (_x1 + _x2) / 2 )) $(( (_y1 + _y2) / 2 ))
}

has_text() { dump || return 1; grep -Fq "$1" "$XML"; }

wait_text() {
  _wait_i=0
  while [ "$_wait_i" -lt "${2:-20}" ]; do
    if has_text "$1"; then return 0; fi
    sleep 0.25; _wait_i=$((_wait_i + 1))
  done
  return 1
}

shot() { screencap -p "$OUT/${1:-screen}-$(date +%s).png"; }

start_app() {
  am force-stop "$PKG"
  am start -n "$PKG/.MainActivity" >/dev/null 2>&1
  wait_text '今日任务' 40
}

rate_once() {
  tap_text '继续学习' >/dev/null 2>&1
  sleep 1
  wait_text '轻点进入注释面' 20 || return 1
  tap_text '轻点进入注释面' || return 1
  sleep 1
  wait_text '认识，' 20 || return 1
  tap_text '认识，' || return 1
  wait_text '已保存' 8
}

case "${1:-help}" in
  start) start_app; shot start; echo "OK start" ;;
  shot) shot "${2:-manual}"; echo "OK shot" ;;
  rate)
    want=${2:-3}
    start_app >/dev/null 2>&1
    _rate_i=0; _rate_ok=0
    while [ "$_rate_i" -lt "$want" ]; do
      _rate_i=$((_rate_i + 1))
      if rate_once; then _rate_ok=$((_rate_ok + 1)); echo "rate $_rate_i OK"; else shot "rate-$_rate_i-fail"; echo "rate $_rate_i FAIL"; break; fi
      _rate_i=$((_rate_i - 0))
      if [ "$_rate_i" -ge "$want" ]; then break; fi
    done
    echo "RATED $_rate_ok/$want"
    [ "$_rate_ok" -eq "$want" ] ;;
  restart) start_app; shot restart; echo "OK restart" ;;
  dump) dump; cat "$XML"; echo ;;
  *) echo "usage: smoke.sh start|rate N|restart|shot [name]|dump" ;;
esac
