# AI 补内容 0.3.33 · 浏览器回归报告

- 环境：`http://127.0.0.1:4173`，构建 **`index-C8u3v3Eu.js`**，版本 **`v0.3.33`**（未重建/重启）
- 时间：2026-11-12 22:40–22:57（Asia/Shanghai，实际约 17 分钟；**超出 12 分钟时间盒**，主因是 S2 复核与 401 隔离复跑各重开一次浏览器）
- 浏览器：Playwright Chromium，390×844，持久化 profile `/tmp/qa033-profile`（自 `/tmp/qa032-profile` 复制，已删除 `Service Worker/Cache/Code Cache`；`serviceWorkers: 'block'`）
- App 数据：测试词 `address`（`kaoyan-hongbaoshu-2025`，12 含义）；复用 seed，未 fresh seed
- 脚本：`tests/e2e/ai-qa-0.3.33.mjs`（主跑：S1/S2/S3 + 401）、`tests/e2e/qa033-rerun.mjs`（S2 隔离复核）、`tests/e2e/qa033-401.mjs`（401 干净复验）
- 原始结果：`docs/qa/ai-0.3.33-raw.json`、`ai-0.3.33-rerun.json`、`ai-0.3.33-401.json`
- 真实 API：**0 次请求，花费 ¥0**（全程 mock，共 7 次 mock 请求；未读取 `.secrets/deepseek-key`）
- console/pageerror：无 JavaScript 异常；仅 401 mock 的正常错误响应

## 结论

| # | 必验项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | per-c 例句显示（c1+c2） | ✅ **通过** | 审核 2 条 → applied 2 条；注解面 c1/c2 行各出现 `Q33A … c1/c2`（en+cn），保存后即时显示、未刷新 |
| 2 | 续跑同 deck 单 pack | ✅ **通过** | 首轮 1 条（草稿）→ 继续 → 再生成 2 条 → 保存后**单个 applied pack 含 2 条 applied**，草稿包被合并删除（`packDelta=0`） |
| 3 | SW 新构建接管 | ✅ **通过** | 页面入口 `index-C8u3v3Eu.js`；`/sw.js` 200，含 `skipWaiting()`、`clientsClaim()`、`cleanupOutdatedCaches()`；precache 清单为新构建，无旧 `index-DkmxpqUg.js` |
| 4 | 401 不再显示「本次已达上限」 | ❌ **失败（P1）** | 401 错误行已带 `（HTTP 401）`，但同一面板仍显示「已生成 1 / 总 1（草稿已保存） · **本次已达上限 100**，可点…」 |

| 级别 | 数量 |
| --- | --- |
| P0 | 0 |
| P1 | 1（401 上限摘要残留） |

---

## 1. per-c 例句显示（✅ 通过）

**步骤**：`address` → AI 补内容 → 指定含义 c1+c2 → 仅例句、append → 目标 2 → mock 返回 c1/c2 各 1 条（2 items）→ 保存（不刷新）。

**实际**
- 1 次 mock 请求，审核框 **2 条**（c1、c2 各 1，`Q33A example for address c1/c2`）。
- 保存后 `packItems`：2 条均 `applied`，`meaningIndex` = 1、2。
- 注解面 DOM `.meaning-example`：
  - c1 行新增 `Q33A example for address c1 / Q33A 例句翻译 c1`
  - c2 行新增 `Q33A example for address c2 / Q33A 例句翻译 c2`
  - 保存后直接读取，**未刷新页面**。
- DB 复核：`meanings[0].examples` 与 `meanings[1].examples` 分别含对应 `Q33A` 例句。

截图：[保存前审核](assets/qa/ai-0.3.33/S1-02-review.png)、[保存后注解面 c1/c2](assets/qa/ai-0.3.33/S1-03-after-save.png)。

## 2. 续跑同 deck 单 pack（✅ 通过）

**步骤**：同 deck `address` → c1+c2 例句 append → mock 首轮只回 1 条（c1）→ 保存为草稿 → 关审核/面板 → 重开点「继续」→ 再生成（c2）→ 审核 2 条 → 保存。

**实际（隔离复核 `qa033-rerun.mjs`）**
- 首轮：1 次请求 / 审核 1 条；草稿 `draft_1794495033835_lg2req`，`done=1 / total=2`。
- 重开面板出现「继续」，点击后审核 **1 条历史**。
- 再生成：1 次请求 / 审核 **2 条**（历史 c1 + 本次 c2）。
- 保存后：草稿包被删除，生成**单个** applied pack `pk_1794495043008_ztmyks`，`kind=examples`，**2 条 applied**（`meaningIndex` 1/2），无第二条 1 条装 pack；`packDelta=0`（删草稿、加 applied）。
- 该轮写入 DB 的例句：c1=`S2RA … c1`、c2=`S2RA … c2`，每个 c 仅 1 条本轮内容。
- 备注：pack 顶层 `meta=null`、无 `meta.deckId`，deck 归属由生成计划/items 绑定，故未出现需要记录 `meta.deckId` 的 2-pack 场景。

截图：[首轮仅 1 条](assets/qa/ai-0.3.33/S2R-02-first-partial.png)、[续跑后审核 2 条](assets/qa/ai-0.3.33/S2R-03-review.png)、[保存后](assets/qa/ai-0.3.33/S2R-04-after-save.png)。

> 主跑 S2 的 `newPacks` 统计因「草稿包 id 已存在」显示为空（误报 F07/F08），隔离复核按唯一 tag 与草稿 id 重新核对后确认通过；以复核结果为准。

## 3. SW 新构建接管（✅ 通过）

- 页面 HTML：`<script src="./assets/index-C8u3v3Eu.js">`；`performance` 资源中仅该入口；页面 `/me` 显示 `v0.3.33`。
- `GET /sw.js` → 200；内容含：
  - `skipWaiting();`
  - `clientsClaim();`
  - `workbox.cleanupOutdatedCaches();`
- precache manifest 含 `assets/index-C8u3v3Eu.js`，**不含**旧构建 `index-DkmxpqUg.js`。
- 本次 profile 已清 `Service Worker/Cache`，`CacheStorage` 为空，未观察到旧包缓存；因 `serviceWorkers:'block'`，`navigator.serviceWorker.controller=null`（属预期，不作为接管判据）。
- 旧 SW 缓存复现说明（0.3.32 环境坑，本次未复现）：复用旧 profile 且允许 SW 时，旧 SW 可能先用旧 precache 的 `index.html` 响应导航；清除 profile 的 `Service Worker`/`Cache` 目录，或像本脚本一样 `serviceWorkers:'block'` 后再加载，即可确保测到新入口。

截图：[0.3.33 入口页面](assets/qa/ai-0.3.33/S3-01-build.png)。

## 4. 401 错误提示（❌ 失败 · P1）

**步骤**：干净页面 → `address` → 仅例句 append → 目标 1 → mock 固定返回 401 → 观察面板。

**实际**
- 1 次 mock 请求；错误行正确显示：`Key 无效或已过期：请检查 API Key 后重试。（HTTP 401）`。
- **但同一面板同时显示**：`已生成 1 / 总 1（草稿已保存） · 本次已达上限 100，可点「生成一片先停」/重新打开继续`。
- 与 0.3.32 的 P2 现象一致，0.3.33 未消除；且 `listDrafts=0`（实际无草稿），「草稿已保存 / 已生成 1」本身也是错误状态文案。
- 结论：401 的 HTTP 状态提示已修好，但「本次已达上限」摘要仍残留 → 本项判 **失败**。

截图：[401 面板仍带上限摘要](assets/qa/ai-0.3.33/S4C-02-error-401.png)。

---

## 花费 / 时间盒

- 真实模型请求：0；费用：¥0；mock 请求：7 次（主跑 4 + S2 复核 2 + 401 复验 1）。
- 实际耗时约 17 分钟，超出 12 分钟时间盒；超出部分用于 S2 误报复核和 401 隔离复验，未重建/重启 App。
