# AI 补内容 0.3.34 · 401 错误面板小回归

- 环境：`http://127.0.0.1:4173`，构建 **`index-0wc4VVru.js`**，版本 **`v0.3.34`**（未重建/重启）
- 时间：2026-11-12 23:10–23:13（Asia/Shanghai，约 2 分 15 秒，在 8 分钟时间盒内）
- 浏览器：Playwright Chromium，390×844，持久化 profile `/tmp/qa034-profile`（由 `/tmp/qa032-profile` 复制；已删除 `Service Worker/Cache/Code Cache/GPUCache`，并设 `serviceWorkers: 'block'`）
- 测试词：`address`（`kaoyan-hongbaoshu-2025`，12 含义），复用 seed，未 fresh seed
- 脚本：`tests/e2e/qa034-401.mjs`（单场景：401 → 直接重试）
- 原始结果：`docs/qa/ai-0.3.34-401.json`
- 真实 API：**0 次请求，花费 ¥0**（仅 2 次 mock `/v1/chat/completions`；未读取 `.secrets/deepseek-key`）
- console/pageerror：无 JS 异常；仅 401 mock 产生的正常 `Failed to load resource: 401` 控制台记录

## 结论

| # | 必验项 | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | mock 401 后面板只显示错误行（含「HTTP 401」），无「已生成 X / 总 Y」「本次已达上限」「草稿已保存」 | ✅ **通过** | 错误行仅 1 条：`Key 无效或已过期：请检查 API Key 后重试。（HTTP 401）`；上述 3 类残留文案全部不出现 |
| 2 | 无草稿横幅（继续/放弃） | ✅ **通过** | 面板无「继续 / 放弃草稿」按钮与文字；IndexedDB `listDrafts=0` |
| 3 | 错误后「开始生成」可用，可直接重试；重试 mock 成功进入生成 | ✅ **通过** | 按钮 `disabled=false`；同面板直接点击后发出 1 次 mock 请求，进入「审核生成内容（1）」，含 1 条 `Q34A` 例句 |

| 级别 | 数量 |
| --- | --- |
| P0 | 0 |
| P1 | 0 |
| P2 | 0 |

**判定：通过。** 0.3.33 的 P1（401 后仍残留「已生成 1 / 总 1（草稿已保存） · 本次已达上限 100…」）未复现。

---

## 1. 401 面板内容（✅ 通过）

**步骤**：打开 `address` 的 AI 补内容 → 范围「当前词」→ 仅「例句」→ 生成模式「追加更多」→ 目标数 1 → 固定 mock 401 → 等待错误出现并稳定 1.8s。

**实际面板状态（去除常规配置项后）**

```text
...
目标：1 个词/含义 · 例句
预计费用按所选类型 × 目标数估算；单次上限 ¥3.00；全量预算 ¥40
预计 ¥0.22 / 单次上限 ¥3.00
Key 无效或已过期：请检查 API Key 后重试。（HTTP 401）
开始生成    关闭
```

- 错误行带 `（HTTP 401）`；`.mm-danger-text` 仅 **1** 条。
- 全文检索无 `已生成 <数字> / 总 <数字>`、无 `本次已达上限`、无 `草稿已保存`。
- 面板保留的「目标 / 预计费用」是生成前配置与估算，不是进度或草稿摘要；唯一的状态行是错误行。
- 401 后 DB 草稿数为 **0**，与「未保存草稿」一致。

![401 后面板只有错误行](../assets/qa/ai-0.3.34/S1-02-error-401.png)

## 2. 无草稿横幅（✅ 通过）

- 401 后面板按钮中无「继续」「放弃草稿」，正文也不含这两个词。
- IndexedDB `packs` 中 `draft=true` 的包数量为 0（`draftCount: 0`）。
- 说明 0.3.34 的 `AI_AUTH` 分支确实执行了 `clearGenerationDraft` 并清空 `draftId/draftDone/draftTotal/draftCursor`，未留下可续跑草稿。

## 3. 错误后直接重试（✅ 通过）

**步骤**：不关闭面板、不重新打开，将 mock 切回成功，直接点击同一「开始生成」按钮。

- 点击前按钮 `disabled=false`、可见。
- 重试发出 1 次 mock 请求（tag `Q34A`，`targets=1`，`sent=1`），无 401。
- 45s 内出现「审核生成内容（1）」，条目 1 条：`address · 例句 Q34A example for address c- / Q34A 例句翻译 c-`。
- 重试成功后新草稿数为 1（本次成功生成产生，属正常），面板进度为 `完成 1 / 1 条 · 已用 ¥0.00`。

![重试成功进入审核](../assets/qa/ai-0.3.34/S1-03-retry-review.png)

## 环境说明

- 入口校验：页面 HTML 入口 `index-0wc4VVru.js`；`/#/me` 显示 `v0.3.34`；`navigator.serviceWorker.controller` 为空（SW 已 block，确保加载目标构建）。
- 指定 profile `/tmp/qa034-profile` 初始不存在，按「自 qa032 复制」创建；复制后清空 SW/Cache 目录，未复用旧构建缓存。
- 本次仅覆盖 401 路径与直接重试；未覆盖真实 Key、真实 401、限流/余额等其他错误码，也未验证保存落库。

## 花费 / 时间盒

- 真实模型请求：0；费用：**¥0**；mock 请求：2 次（401 1 次 + 重试成功 1 次）。
- 实际耗时约 2 分 15 秒（8 分钟时间盒内）；未重建、未重启 App。
