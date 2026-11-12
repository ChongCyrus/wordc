# 0.3.28「AI 补内容」浏览器 QA 报告（双击 / 多 kind / 多 c / append-cover / 失败提示）

- 日期：2026-11-12 20:48–21:13（Asia/Shanghai）
- 测试对象：**0.3.28 精确构建**——从 0.3.28 APK 提取的 PWA，入口 `assets/index-BfF_vX45.js`，本地静态服务于 `http://127.0.0.1:4190/`
- 方式：Playwright（chromium aarch64）+ 持久化 profile `/tmp/qa028-profile`；真实 DeepSeek API 经 `page.route` 转发；其余场景用确定性 mock
- 约束：未改 `src`、未重建/重启 4173；只写 `tests/e2e`、`docs/qa`、`docs/assets/qa`
- Console：**0 条 console error / 0 条 pageerror**（全部场景）
- 成本：真实上游 8 次请求（含同一次生成的批次/重试），tokens 4,608 输入 / 798 输出 ≈ **¥0.02**（按 deepseek-chat ¥2/M 输入、¥8/M 输出估算），远低于 ¥0.5 上限

## ⚠️ 环境与任务前提不一致（需 Lead 知晓）

任务说 “4173 已是 0.3.28（入口 `index-BfF_vX45.js`）”，实测 **不是**：

| 项 | 任务前提 | 实测 |
| --- | --- | --- |
| `GET :4173/` 入口 | `index-BfF_vX45.js` | **`index-CjXxA1np.js`** |
| `APP_VERSION` | 0.3.28 | 开始时为 **0.3.29**（`dist/index-CjXxA1np.js`，20:40 重建）；测试期间并行发布了 0.3.29（e5412af）与 **0.3.30**（a81328e），当前 4173 已是 **0.3.30**（`index-D8r_Ueij.js`） |

为不干扰正在运行的 4173，本次从 `/tmp/ci-apk0328/WordC-0.3.28.apk` 提取 PWA（入口校验为 `index-BfF_vX45.js`），另起只读静态服务 4190 测试。**因此本报告结论对应 0.3.28；0.3.30 的提交信息（a81328e「生成落地/双击/续跑修复」）正好覆盖本报告 F01–F04，需在 0.3.30 上复测确认是否已修复。**

## 结论摘要（先看这里）

| # | 用户反馈 | 0.3.28 实测 | 等级 |
| --- | --- | --- | --- |
| F01 | 双击「开始生成」异常 | **确认**：第 1 击开始生成，第 2 击（约 40ms 后）命中同位置换出的「取消生成」→ 生成立即取消，**0 次请求、0 审核条**，面板回到“已取消，草稿已保存：已生成 0 / 总 1”，并留下 0/1 空草稿 | **P0** |
| F02 | 双击「保存已选」重复 | **确认**：快速双击产生 **2 个 `AI 生成` pack**（1 个 applied=1；1 个 reviewing、applied=0 的孤儿），两次 toast（“已应用 1 条”、“已应用 0 条（跳过 1）”）；**内容只落地一次**，无重复例句 | **P0** |
| F03 | 生成 N 条只落地 M<N | **确认（多 c）**：指定含义 c1+c2 目标 2、审核 2 条，保存后 **“已应用 0 条（跳过 2）”**，注解面无任何新增；pack 停留在 reviewing，items 均 `skipped/duplicate` | **P0** |
| F04 | 生成 N 条只落地 M<N | **确认（多 kind，真实 API）**：例句+词组目标 2、审核 2 条，保存后 apply 只有 **1/2**：例句 +2 落地，词组 +0（注解面仍是原 8 条） | **P1** |
| — | 单击「开始生成」要点两次？ | **未复现**：单击后 500ms 内即进入“取消生成”运行态，1 次真实请求，审核框 1 条正常出现 | 通过 |
| — | append/cover 混合 | **通过**：2 请求 / 审核 2 条 / applied 2（跳过 0）；词组 cover 把旧 8 条替换为 1 条，例句 append 新增 1 条 | 通过 |
| — | 失败不静默 | **基本通过**：2 目标只回 1 条时，审核框只显示 1 条成功项，面板显示“失败 1 条”+ 原因；但提示在审核框背后的面板里、原因笼统 | P2 提示问题 |

**复现比例**：F01 1/1（真实 API 双击，稳定）；F02 1/1（真实 API 双击，稳定）；F03 1/1（mock 多 c，稳定）；F04 1/1（真实 API 多 kind，稳定）。均为一次性可复现，非偶发。

## 场景明细

### S0 环境准备

- 步骤：4190 加载 0.3.28 → 校验入口 `index-BfF_vX45.js` → 清空内容包（保留词库/单词，meta 版本改 99 防重 seed）→ **设置页 UI** 配置：启用 AI、DeepSeek、Key 存储 persistent、填入 `.secrets/deepseek-key`、保存 Key、单次上限。
- 结果：设置 DB `{enabled:true, provider:deepseek, keyStorage:persistent, hasKey:true, keyTail:8f5e}`；持久化 profile 首次 seed 仅 **11s**，后续场景复用。
- 截图：`S0-01-settings-key.png`

### S1 双击（真实 API）——单击开始生成、双击保存已选

- 前置：词 `address`（dagang deck），范围=当前词，类型=例句，模式=追加更多，目标 1。
- 步骤与实测：
  1. **单击一次**「开始生成」：500ms 内出现「取消生成」（running=true），`elementFromPoint` 命中按钮本身；真实请求 **1 次**；审核框出现，**item 1 条**（该条含 2 个例句）。→ “要点两次”**未复现**。
  2. **双击**「保存已选（1）」（间隔 60ms）：对话框关闭；DB 新增 **2 个 pack**：
     - `pk_…t1r9om`：status=applied，items=1，applied=1
     - `pk_…3dca5l`：status=reviewing，items=1，applied=0（孤儿）
  3. toast：`已应用 1 条生成内容（跳过 0）` → `已应用 0 条生成内容（跳过 1）`（2 条）。
  4. 注解面：例句 3 条（内置 1 + 新生成 2），无重复；草稿 0 条。
- 期望：1 次 apply、1 个 pack、1 条 toast、内容落地一次。
- 实际：**2 个 pack + 2 条 toast**，内容只落地一次，第二个 pack 永久停留在 reviewing。
- 请求数 1 / 审核 item 1 / 落地 1 个 applied pack（2 条例句）。
- 截图：`S1-01-panel-ready.png`、`S1-02-single-click-review.png`、`S1-03-after-dblclick-save.png`；console 0。

### S2 双击「开始生成」（真实 API）

- 步骤：重开面板，当前词/例句/追加更多，目标 1 → 用 `dblclick(delay:40ms)` 双击「开始生成」。
- 实际：
  - 400ms 后按钮已是「取消生成」，面板出现 `已取消，草稿已保存：已生成 0 / 总 1（草稿已保存）`；
  - **真实请求 0 次**，无审核框；
  - 留下 0/1 空草稿（重开面板显示继续/放弃横幅，阻断下一次生成）。
- 期望：双击等价于一次点击 → 1 次请求、正常进入生成、出现审核框。
- 请求数 0 / 审核 item 0 / 落地 0；截图 `S2-01-dblclick-start-result.png`；console 0。
- 根因定位（源码）：`AiGenerateView` 的「开始生成」与「取消生成」渲染在**同一位置**，`running` 状态在两次 click 之间已切换，第二次点击落到「取消生成」。0.3.28 无 pointer/延迟去抖。

### S3 多 kind（真实 API）：例句 + 词组

- 步骤：`address`，范围=当前词，类型勾「例句+词组」，两者均 append → 目标 **2** → 生成 → 审核 **2 条**（1 例句 + 1 词组）→ 保存。
- 实际：
  - 目标 2（预估 ¥0.44）；真实请求 **2 次**；审核 **item 2 条**，文案正常区分 `address · 例句` / `address · 词组`；
  - 保存后：pack `mixed`，items=2，**applied=1**；
  - 注解面：例句 3→**5**（+2 落地）；词组 **8→8（无新增）**。
- 期望：applied 2、例句与词组都新增。
- 实际：**生成 2 条只落地 1 条**（词组 item 未应用，无可见失败提示）。
- 请求 2 / 审核 2 / 落地 1（pack applied 1/2）。
- 截图：`S3-01-multikind-ready.png`、`S3-02-multikind-review.png`、`S3-03-multikind-after-save.png`。
- 备注：该 pack 已被后续清库重跑覆盖，skipReason 未留存；症状以 pack applied=1 与注解面计数为证。

### S4 多 c（mock）：指定含义 c1 + c2

- 步骤：`address`，范围=指定含义，勾 c1+c2，类型=例句，append → 目标 **2** → mock 生成 1 次请求、审核 **2 条** → 保存。
- 实际：
  - 目标 2；请求 **1 次**（同一批 2 targets）；审核 **item 2 条**（两条都只显示 `address · 例句`，**不显示 c1/c2 标签**，肉眼无法区分）；
  - 保存 toast：**`已应用 0 条生成内容（跳过 2）`**；
  - DB：pack `pk_…t55mxz` status=reviewing，items=2，**applied=0**；两条 item 均 `status=skipped, skipReason=duplicate`，且 `meaningId` 被解析成 **`kaoyan-hongbaoshu-2025:address#M1/#M2`**，而当前学习词是 **`kaoyan-2027-dagang:address`**（跨词库解析，疑似根因，需开发确认）；
  - 注解面：无任何新增（仍是既有 5 例句 / 8 词组）。
- 期望：c1、c2 各落地 1 条，applied=2。
- 实际：**生成 2 条落地 0 条**，仅有一条“已应用 0 条（跳过 2）”toast，审核框没有任何“将跳过”预告。
- 请求 1 / 审核 2 / 落地 0。
- 截图：`S4-01-multic-ready.png`、`S4-02-multic-review.png`、`S4-03-multic-after-save.png`。
- 说明：mock 内容为确定性 `QA-1 ex …`，可排除“真实模型返回空”的因素；该现象与 0.3.28 的 meaningIndex→deck 解析有关。

### S5 append / cover 混合（mock）

- 步骤：`address`，类型勾「例句+词组」，例句=追加更多(append)、词组=覆盖(cover) → 目标 2 → 生成 → 审核 2 条（覆盖项显示「词组（将替换）」+ 顶部“覆盖模式”提示）→ 保存。
- 实际：
  - 请求 **2 次**（examples 1 + phrases 1）；审核 **2 条**；
  - toast：`已应用 2 条生成内容（跳过 0）`；pack `mixed` items=2 applied=2；
  - 注解面：词组 **8 → 1**（旧内容被覆盖，只剩新的 `QA-2 address up`）；例句 **5 → 6**（append +1）。
- 期望：与上一致。**通过**。
- 请求 2 / 审核 2 / 落地 2。
- 截图：`S5-01-append-cover-ready.png`、`S5-02-append-cover-review.png`、`S5-03-append-cover-after-save.png`。
- 备注：脚本早期曾用 `word.examples/phrases`（内置字段）判断落地，产生误报；已改用「注解面 DOM + pack applied 计数」，本报告为修正后结论。

### S6 部分失败不静默（mock 只回部分 items）

- 步骤：指定含义 c1+c2（目标 2）→ mock 只返回第 1 条（4 个目标里返回 1）→ 生成。
- 实际：
  - 请求 1 次；审核框 **item 1 条**（只显示成功项）；
  - 面板同时可见 `完成 1 / 2 条，失败 1 条 · 已用 ¥0.00` 与 `未生成有效内容：可稍后重试或换用其它类型`（审核框背后、未被完全遮挡）；
  - 未出现静默少一条。
- 结论：**基本通过**；P2 问题：失败数量/原因不在审核框内（审核框标题只写“（1）”），原因文案笼统，用户聚焦审核框时容易漏看。
- 请求 1 / 审核 1 / 落地未保存。
- 截图：`S6-01-partial-failure.png`。

## 缺陷清单与分级

| ID | 等级 | 缺陷 | 期望 | 实际 | 证据 |
| --- | --- | --- | --- | --- | --- |
| F01 | **P0** | 双击「开始生成」被当成「取消生成」 | 双击 = 一次生成 | 0 请求、无审核、`已取消…0/1` 空草稿 | `S2-01-dblclick-start-result.png` |
| F02 | **P0** | 双击「保存已选」创建重复 pack | 只建 1 pack、1 toast | 2 packs（1 applied + 1 reviewing 孤儿）、2 toasts | `S1-03-after-dblclick-save.png` |
| F03 | **P0** | 多 c（c1+c2）保存 0 落地 | applied=2，c1/c2 均有内容 | applied=0，跳过 2（duplicate），注解面空增 | `S4-03-multic-after-save.png` |
| F04 | **P1** | 多 kind 只落地 1/2（词组丢失） | 例句+词组均落地 | mixed pack applied 1/2，词组无新增 | `S3-03-multikind-after-save.png` |
| F05 | P2 | 双击保存出现两条「已应用」toast | 1 条 | “已应用 1 条”+“已应用 0 条（跳过 1）” | `S1-03` |
| F06 | P2 | 多 c 审核条目不区分 c1/c2 | 每条标注 c 序号/释义 | 两条均为 `address · 例句` | `S4-02-multic-review.png` |
| F07 | P2 | 部分失败的提示不在审核框内、原因笼统 | 审核框内明确“失败 N 条 + 原因” | 提示在背后面板，文案“未生成有效内容…” | `S6-01-partial-failure.png` |

**“applied>0 但注解面无内容”**：本次未直接命中；命中的是反向更严重情况 F03（applied=0、注解面无内容）与 F04（applied=1 但其中一类内容缺失）。

## 截图索引（`docs/assets/qa/ai-0.3.28/`）

| 文件 | 内容 |
| --- | --- |
| `S0-01-settings-key.png` | 设置页 Key 已配置（persistent） |
| `S1-01-panel-ready.png` | 当前词/例句/追加更多，目标 1 |
| `S1-02-single-click-review.png` | 单击一次后的审核框（1 条） |
| `S1-03-after-dblclick-save.png` | 双击保存后（2 个 pack、注解面 3 例句） |
| `S2-01-dblclick-start-result.png` | 双击开始生成 → “已取消…0/1” |
| `S3-01/02/03-*.png` | 多 kind 目标 2 / 审核 2 / 保存后 |
| `S4-01/02/03-*.png` | 多 c 目标 2 / 审核 2（无 c 标签）/ 应用 0 条 |
| `S5-01/02/03-*.png` | append+cover 准备 / 审核（覆盖提示）/ 落地 |
| `S6-01-partial-failure.png` | 部分失败：1 成功 + 失败 1 提示 |
| `P0-panel-geometry.png`、`P0-panel-after-click.png` | 调试：弹窗滚动/遮挡几何（非缺陷证据） |

## 测试脚本

- `tests/e2e/ai-qa-0.3.28.mjs`：本报告主脚本（持久 profile、真实/mock 路由、6 场景、DB/注解面断言）
- `tests/e2e/qa028-seed.mjs`：持久 profile 预热
- `tests/e2e/qa028-probe.mjs`：面板几何/遮挡探针
- 原始数据：`docs/qa/ai-0.3.28-raw.json`（S6 段为 run4 回填，已在 notes 标注）

## 限制

1. 0.3.28 为 APK 内精确 PWA 构建（`index-BfF_vX45.js`），与任务所述入口一致；但与当前 4173 的 0.3.29 不同，**不可把本结论直接外推到 0.3.29**。
2. F03 为 mock 复现（1 请求 2 targets）；真实 API 多 c 未再花额度验证，但 F03 的 skip 路径与模型无关。F04 为真实 API 复现。
3. 双击时序用 Playwright `dblclick(delay:40–60ms)` 模拟“快速点两次”；F01/F02 在 1 次运行内稳定复现。
4. 首次脚本曾因未滚动弹窗导致单击误判（点到 mask），已用 locator 自动滚动 + `elementFromPoint` 复核，结论不受影响。
