# 构建 / 升级 / 发布审计（task-277，0.3.93）

> 范围：构建矩阵、APK 安装/覆盖/卸载重装、assets/sanitize、升级保留、SW、Android 自动恢复、发布门禁、CI data-tests、build-private 预装复制。只审计/文档，不改产品功能。

## 1. 构建矩阵现状

| 产物 | 命令 | 关键校验 | 结论 |
|---|---|---|---|
| 私版 PWA dist | `bash scripts/build-private.sh` | 6 packs + `dist/generated` 2 文件；`VITE_PRIVATE_PACKS=1` | 可用；生成数据只复制到 dist，退出清 `public/` |
| 公开 PWA | sanitize 后 `npx vite build` | 公开 packs 2（dagang）、无 generated、禁用词 0 | 可用；`tools/sanitize-public.mjs` 有自检 |
| APK | `bash tools/apk/build-apk.sh` | 5 处版本注入、dex 桥、assets 一致性、v1+v2+v3 | 可用；APK assets 含 `pwa/generated` 2 文件 |
| 发布 | API Git Data / push-incremental | root + tag + CI/e2e | 已多次验证；GitHub TLS 阻断时需 API/SSH443 兜底 |

版本 5 处：`package.json`、`tools/e2e/package.json`、`src/app/version.ts`、`src/data/import-export.ts`（GENERATOR+APP_VERSION）、`tools/apk/version.json`（version+code）。构建脚本分别从 package.json / version.json 取值，理论上可漂移；发版清单第 7 节要求人工逐项核对。

## 2. APK 安装/升级/重装

- `AndroidManifest.xml`：`package=com.wordc.app`、`minSdk 24`、`targetSdk 34`、`allowBackup=true`、`launchMode=singleTask`。
- 覆盖升级依赖同包名 + 递增 versionCode（当前 0.3.92/code106）；同签 keystore 才能覆盖，换签需卸载。
- **重装风险**：`allowBackup=true` 时 Android 可能自动恢复 WebView/IndexedDB 与 SharedPreferences；旧库/旧 plan 可能被恢复，出现「待新学 30 / 只含自动新词」等旧状态。必须在系统自动恢复开/关两种情况下真机验证（清单第 8 节）。
- 卸载会清内部 `getFilesDir()/auto-backups`（自动备份），因此恢复数据优先依赖系统备份或用户显式导出；诊断 JSON 同理。

## 3. 预装生成数据（0.3.91/0.3.92 教训）

- 0.3.91：首启自动 seed 13MB（JSON.parse + Dexie 批量写）在 WebView/低端机阻塞主线程，出现「正在加载今日学习」卡死；0.3.92 已改默认 **不自动 seed**，手动「立即导入」，并仅 APK 才允许自动模式。
- 构建链路：`data/generated/*` → `build-private.sh` 复制 `public/generated/` → `dist/generated/` → APK `assets/pwa/generated/`；退出时清 `public/generated`，所以构建后只能在 dist/APK 验证。
- 公开树：sanitize 排除 `data/generated/`、`public/generated/` 并自检；公开 packs 只允许 dagang。
- 发布前必须确认 APK 内 2 个文件存在（`unzip -l ... | grep assets/pwa/generated`）且公开树不含。

## 4. SW / 缓存

- 生产 `vite-plugin-pwa` generateSW 生成 `/sw.js`，Web/PWA active 属预期；不是旧缓存。
- APK 内 PWA 为本地 assets，MainActivity `onPageFinished` 会检测 SW 控制器并注销 + 清 caches 后重载一次（task-174），避免旧 chunk 混用 React #310。
- 覆盖升级必须验证：不白屏；刷新两次正常；无旧 chunk 404。

## 5. 发布门禁

强制清单已写入 `docs/RELEASE-CHECKLIST.md`：前置/首启 seed/学习页/AI/内容包/首页统计我的设置/记录与签字，另补第 7–10 节构建矩阵、升级重装、SW、GitHub 兜底。发布前由 Lead 真机执行、QA 留证；CI 绿只是前置。

## 6. CI 与手动长测试

- `.github/workflows/ci.yml`：push quick / tag 或 dispatch full；`.github/workflows/e2e.yml` 公开 smoke。
- `.github/workflows/data-tests.yml`（本审计新增）：workflow_dispatch，`mode=data/all/single`，跑 tsc + vitest（forks/maxForks=1），上传 `ci-logs/vitest.log`/`tsc.log`，timeout 30min。
- 使用方式见 `docs/CI.md`「手动跑长测试」；手机只做构建/真机验证。

## 7. 风险与建议（不阻塞 0.3.93）

1. 5 处版本靠人工核对 → 建议后续加 `release-preflight` 脚本统一校验（本次未改产品）。
2. `allowBackup=true` 的自动恢复是升级/重装最大不确定项 → 清单第 8 节强制开/关各测一次；如需彻底可控可评估 `allowBackup=false`（属产品/安全决策，需 Lead 确认）。
3. WebView 首启导入大数据已改手动；仍建议真机低端机验证手动导入期间可继续操作、有进度反馈。
4. GitHub TLS 阻断为间歇性环境问题 → 发布脚本已支持 API/SSH443 兜底，流程写入清单第 10 节。
