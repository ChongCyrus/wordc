# 真机测试与诊断自动化

## 目标

- 尽可能用脚本做真机回归，减少手点
- 出问题时能读私有数据、日志、SQLite
- release 与 debuggable 分工明确

## 两个包

| 包 | 用途 | 私有数据 |
|---|---|---|
| `WordC-<ver>.apk` release | 日用/发布验证 | shell 不可读 |
| `WordC-<ver>-debuggable.apk` | 临时诊断 | `run-as` 可读 |

debuggable 包：

- 同包名、同签名
- 覆盖安装保留数据
- 仅临时使用

## WebView 调试

debuggable 包启动时自动：

```java
WebView.setWebContentsDebuggingEnabled(true)
```

release 不开启。

## App 内 CDP 代理（无 adb）

0.16.2+ 的 QA debuggable 包启动时监听：

```text
127.0.0.1:9222
```

并转发到本进程 WebView devtools abstract socket。

因此本机 proot 可直接：

```bash
curl http://127.0.0.1:9222/json
node scripts/device/cdp-smoke.mjs
node scripts/device/cdp-e2e.mjs
```

Playwright：

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222', { noDefaults: true })
```

已实测通过：

- 读取 WebView DOM
- 点击「我的」「导入与导出」
- 截图 `device-cdp-e2e.png`

前提：

- QA debuggable 包已启动且在前台/后台存活
- release 包不监听 9222

## 脚本

### 1. 拉取私有数据

```bash
scripts/device/pull-private.sh com.wordc.app
```

需要：

- adb
- 已安装 debuggable 包

输出：

- SQLite
- SharedPreferences
- WebView/IndexedDB 数据

### 2. 强杀/重启/截图/内存

```bash
scripts/device/kill-restart.sh com.wordc.app
```

覆盖：

- force-stop
- 冷启动
- 截图
- meminfo
- logcat 关键错误

### 3. WebView CDP 冒烟

```bash
# 先找到 WebView devtools socket
adb shell cat /proc/net/unix | grep webview_devtools
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
node scripts/device/cdp-smoke.mjs http://127.0.0.1:9222
```

可扩展为 Playwright：

```js
const browser = await chromium.connectOverCDP('http://127.0.0.1:9222')
```

## 推荐测试矩阵

1. release 冒烟：安装、启动、首页、恢复、重启
2. debuggable 诊断：数据不一致、restore、cache
3. 强杀/重启：进程死亡后数据一致
4. WebView CDP：DOM/页面流程断言
5. 真机人工：视觉、手感、首次体验

## 当前限制

- 本机 proot 没有 adb 二进制
- 脚本需在 PC 或启用无线 ADB 后运行
- 也可用 Shizuku/MCP 手动执行等价命令
- Instrumented/Robolectric 测试尚未接入（需 Gradle）

## 后续可加

- Android instrumentation tests（SqliteDao/桥）
- Robolectric（JVM SQLite）
- Firebase Test Lab / Device Farm
- Playwright CDP 测试套件
- 内存/Perfetto 基线
