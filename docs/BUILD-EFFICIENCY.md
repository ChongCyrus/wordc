# 构建与 CI 提效（task-178）

## 目标

- 消除重复 `pnpm install` / 重复 build：一个 `build-test` job 完成 install → tsc → 测试 → build，产物 `pwa-dist` 供 APK/E2E 复用。
- push 快速反馈：只跑 `tsc` + **受影响测试** + build smoke；`v*` tag / `workflow_dispatch(full=true)` 才跑全量测试 + APK。
- 缓存 pnpm store / Vite / Chromium / Android toolchain；各阶段输出耗时。

## 工作流结构调整

### `ci.yml`

```
build-test (install once)
  ├─ pnpm install --frozen-lockfile
  ├─ tsc --noEmit
  ├─ quick: git diff 选受影响目录；release: tests/core+data+ui+scheduling
  ├─ build（私仓带 packs / 公开树普通）
  └─ upload pwa-dist + ci-logs
apk (needs build-test)
  └─ download pwa-dist（不再自己 install/build 前端）
```

- **push main**：`quick` 模式（`tsc` + 受影响测试 + build）；改 `src/core` 跑 core，改 `src/data` 跑 data，改 `src/ui`/配置跑 ui；未识别时跑 pages-smoke。
- **tag `v*` / dispatch full**: `full` 模式（core+data+ui+scheduling 全量）；只有 tag/full 才跑 APK 与生产 E2E，push 不发 APK。
- **install 只执行一次**：static/unit-core/unit-data/unit-ui 四个旧 job 合并。
- **APK** 只在 tag/full 触发（push 跳过）；只依赖 `pwa-dist` artifact；secrets guard、toolchain cache 保留。

### `e2e.yml`

- 触发：`workflow_run`（CI 成功且 head_branch 为 `v*` tag）或手动 dispatch；push 不跑 E2E。
- **不再 `pnpm install` 全仓 / 不再 build**：下载 CI 的 `pwa-dist` artifact；仅 `npm install --prefix tools/e2e`；用 `python3 -m http.server --directory dist` 提供静态站点。
- 手动 dispatch 无 artifact 时才 fallback 构建一次。
- Chromium 优先系统 Chrome；否则 Playwright cache；上传截图/日志 artifact。
- `concurrency` 独立组，不取消 CI；E2E 非阻塞。

## 缓存

| 缓存 | key | 用途 |
| --- | --- | --- |
| pnpm store + node_modules/.vite | `deps-vite-${{ runner.os }}-${{ hashFiles('pnpm-lock.yaml') }}-${{ github.sha }}` | install / Vite incremental |
| Playwright | `playwright-${{ runner.os }}-${{ hashFiles('tools/e2e/package-lock.json') }}` | 浏览器 fallback |
| Android toolchain | `apk-toolchain-android23-r8-8.11.18` | android.jar + r8.jar |

## 耗时观测

- 每个关键步骤输出 `install/tsc/tests/build/e2e=Ns` 到 job log。
- `ci-logs/`（install/tsc/test/build）与 E2E 日志/截图统一上传 artifact，保留 7 天。
- 目标（参考）：install ≤ 20s（缓存命中）、tsc ≤ 30s、quick tests ≤ 90s、build ≤ 90s；release 全量 ≤ 5 分钟；APK/E2E 不再重复 install/build。

## 已知取舍

- push 的 quick 测试按**目录**选择，跨目录改动（如 `src/core` 改接口影响 data）可能漏测；tag/发布前必须跑 `full` 全量。
- E2E 静态服务器为 `python http.server`，HashRouter 不需要 SPA rewrite；若后续改 BrowserRouter 需换 fallback 服务器。
- 首次 push 或 force-push 时 `github.event.before` 不可用，fallback 全量测试。

## E2E 分层门禁（task-177 接入）

`e2e.yml` 现在分两层（复用 CI `pwa-dist`）：

| job | 触发 | 内容 | profile |
| --- | --- | --- | --- |
| **smoke** | 每次 push（CI 成功） | `prod-smoke-gates.mjs`：主路由/学习页/手势/无 pageerror | 不需要 |
| **full** | tag `v*` / dispatch | 4 个 gate 并行（prod/touch/upgrade-sw/visual）+ **v2 E2E 12 shards matrix**（每 shard 独立端口 4201–4212、E2E_ONLY 2 个场景/组；S22/S23 单独成组） | 小型 JSON fixture `tests/e2e/fixtures/minimal-profile.json`，无 188MB profile |

- QA 真实 profile 188MB 不宜入 git；当前用 `actions/cache ~/.cache/qa-profile`。**tag/release 的 full gate 若 cache miss 直接 fail**（不静默降级）；非 release dispatch 才降级 smoke。后续 QA 提供小 fixture 后替换 cache 步骤。
- 完整 gate 命令：`qa-prod-gate`（QA_FIXTURE/QA_BASE）、`qa-upgrade-sw-gate`（QA_BASE/QA_APP_VERSION）、`qa-visual-compare`、`qa-touch-gate`（QA_FIXTURE/QA_BASE，真实 CDP touch）。
- **E2E 分片（task-195）**：v2 22 场景拆 12 组（S1,S2 / S3,S4 / … / S20,S21 / S22 / S23），`strategy.matrix.shard=[1..12]`、`fail-fast:false`；每 shard 复用同一 `pwa-dist`、独立端口、上传自己的 JSON/截图；4 gate 独立并行 job。目标墙钟 3–5 分钟。
- 升级 gate 依赖 profile 里的旧 SW/appVersion，不需旧 dist artifact。
- 失败会阻塞 release（`continue-on-error: false`），截图/日志上传 `e2e-full`。
