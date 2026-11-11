# CI（GitHub Actions）使用说明

> 唯一 workflow：`.github/workflows/ci.yml`（name: `CI`）。本机 `github.com` 不通但 `api.github.com` 通，
> 所以**触发/查状态/下产物都走 REST API**（或 `gh` CLI）。CI 只做校验与产物构建，**不发布、不部署、不打包 APK**。

## 1. 触发方式

| 方式 | 说明 |
|---|---|
| `push` 到 `main` | 自动触发（`on.push.branches: [main]`；若仓库默认分支是 `master`，把这里一起改） |
| 手动 `workflow_dispatch` | 适合改完 workflow 后先试跑；见下方命令 |

### 1.1 用 curl 触发（api.github.com）

```bash
export GITHUB_TOKEN=ghp_xxx            # 见 §4 权限
REPO=ChongCyrus/wordc        # owner/name
BRANCH=main

# 触发
curl -sS -X POST \
  -H "Authorization: Bearer $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/actions/workflows/ci.yml/dispatches" \
  -d "{\"ref\":\"$BRANCH\"}"

# 查最近一次运行（拿 run id / 状态 / 结论）
curl -sS -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/actions/runs?branch=$BRANCH&per_page=1" \
  | python3 -c 'import json,sys; r=json.load(sys.stdin)["workflow_runs"][0]; print(r["id"], r["status"], r["conclusion"], r["html_url"])'

# 下载某次运行的产物（artifact）
RUN_ID=123456789
curl -sS -L -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID/artifacts" | head
```

### 1.2 用 gh CLI（能连 github.com 时）

```bash
gh workflow run ci.yml --ref main
gh run watch
gh run download <run-id> -n pwa-dist
```

## 2. Job 清单与预计耗时（ubuntu-latest / Node 20 / pnpm 10）

| Job | 内容 | 依赖 | 产物 | 预计（含缓存） |
|---|---|---|---|---|
| `static` | `pnpm install --frozen-lockfile` → `tsc --noEmit` | — | — | ~2 分钟 |
| `unit-core` | `vitest run tests/core tests/scheduling.test.ts`（单 fork） | — | `unit-core-log` | ~2–3 分钟 |
| `unit-data` | `vitest run tests/data`（单 fork） | — | `unit-data-log` | ~2–3 分钟 |
| `unit-ui` | `vitest run tests/ui`（单 fork） | — | `unit-ui-log` | ~2–3 分钟 |
| `build` | `pnpm build`（tsc + vite + PWA SW） | — | **`pwa-dist`**（dist 全量） | ~3–4 分钟 |
| `apk` | setup-java 17 + apt aapt/apksigner/zipalign + 缓存/下载 android.jar(API23)/r8.jar + 解码 keystore + `tools/apk/build-apk.sh` | `build` | **`apk`**（apk + `APK-SHA256.txt` + build.log） | ~4–6 分钟 |
| `e2e` | 下载 `pwa-dist` → 官方 Playwright Chromium → `python3 -m http.server 4173` → `node tests/e2e/v2-e2e.mjs` | `build` | **`e2e-artifacts`**（截图+json+日志） | ~8–12 分钟 |

- 7 个 job；`apk` 与 `e2e` 都只依赖 `build`，**并行**执行，墙钟时间一般 **10–15 分钟**；
- 计费按每个 job 的分钟数相加，单次约 **25–34 分钟**（缓存命中时更低）。

## 3. 缓存与离线

- `actions/setup-node` 自带 **pnpm store 缓存**（`cache: pnpm`）；
- Playwright Chromium 缓存 `~/.cache/ms-playwright`，key 取 `tools/e2e/package-lock.json` 哈希；
- 单测全部**离线**（`fake-indexeddb`、mock MaiMemo API / 文件降级），**不需要 .secrets、token 或外网服务**；
- E2E 只访问本机 `http://127.0.0.1:4173`（`python3 -m http.server` 服务 `dist`），Chromium 用 Playwright 官方安装（x64），
  不使用仓库里 arm64 的 `tools/e2e/chromium`；
- 产物保留 7 天（`retention-days: 7`）。

## 3.1 APK job 的 Secrets（未配置则自动跳过）

仓库 Settings → Secrets and variables → Actions 添加：

| Secret | 内容 | 生成 |
|---|---|---|
| `APK_KEYSTORE_BASE64` | 签名 keystore 的 base64 | `base64 -w0 .secrets/apk-release.jks` |
| `APK_KEYSTORE_PASS` | keystore/key 口令 | `head -1 .secrets/apk-keystore-pass` |
| `APK_KEY_ALIAS`（可选） | key alias，默认 `momo` | — |

- **必须与本地发布用同一 keystore**，否则 APK 证书变化，覆盖安装会失败。
- 未配置 `APK_KEYSTORE_BASE64` 时 `apk` job 打印 `::notice::` 并跳过构建步骤，不阻塞其它 job；
- workflow 用 `::add-mask::` 掩码口令；keystore 只解码到 runner 临时工作区，不写日志/不入库；
- 下载 APK artifact：`gh run download <run-id> -n apk`，或：

```bash
RUN_ID=123456789
curl -sS -L -H "Authorization: Bearer $GITHUB_TOKEN" \
  "https://api.github.com/repos/$REPO/actions/runs/$RUN_ID/artifacts" \
  | python3 -c 'import json,sys; [print(a["id"], a["name"], a["archive_download_url"]) for a in json.load(sys.stdin)["artifacts"]]'
```

- 版本来源：`package.json`（version）+ `tools/apk/version.json`（`code`）；CI 会断言两者 version 一致，
  发版时两处 + `version.ts`/`import-export.ts` 都要同步（见 `docs/APK.md §3.3`）。

## 4. 需要的 token 权限（Lead 推送/触发用）

- **Classic PAT**：`repo`（推代码/建私有库）+ `workflow`（推送 `.github/workflows/` 文件）。
- **Fine-grained PAT**（更小权限）：`Contents: Read and write`（push）、`Workflows: Read and write`（workflow 文件）、
  `Actions: Read and write`（dispatch、查运行、下 artifact）。
- 本机推送用 `node tools/github/push-via-api.mjs`（从 `GITHUB_TOKEN` 读 token，不落盘）。

## 5. 额度说明（私有仓库）

- GitHub Free 私有仓库：**2,000 分钟/月**（Linux 计费倍率 1×）；
- 按 §2 单次 ~20–28 分钟、每天跑几次也在额度内；`concurrency.cancel-in-progress` 会取消同一分支的旧运行，避免重复计费；
- 超过额度会暂停 Actions，需要等下月或升级计划。

## 6. 明确不做的事

- ❌ APK 构建 / 签名 / 上传（本机 toolchain 与 keystore 不进 CI；后续如需要单独 job + secrets）
- ❌ 发布/部署（Releases、Pages、npm 包）
- ❌ 真实MaiMemo API / 用户 token（导入路径用 mock/文件降级，S11 已验证）
- ❌ 依赖自动升级、CodeQL 等额外 workflow（保持单 workflow，降低维护成本）

## 7. 本地校验

```bash
# YAML 语法
python3 - <<'PY'
import yaml
d = yaml.safe_load(open('.github/workflows/ci.yml'))
on = d.get('on', d.get(True))      # PyYAML 把裸 key `on` 解析成 True
print(d['name'], list(on), list(d['jobs']))
PY
```

> 表达式（`${{ }}`）与 action 输入合法性由 GitHub 在首跑时校验；本地只验证 YAML 结构。
