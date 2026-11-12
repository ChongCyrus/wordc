# AI 补内容 0.3.30 · 浏览器回归报告

- 环境：`http://127.0.0.1:4173`，构建 `index-D8r_Ueij.js`，版本 `0.3.30`（未重建/重启）
- 时间：2026-11-12 21:15–21:39（Asia/Shanghai）
- 浏览器：Playwright Chromium，390×844，持久化 profile `/tmp/qa030-profile`（由 `/tmp/qa028-profile` 复制，IndexedDB origin 由 `127.0.0.1:4190` 改为 `127.0.0.1:4173`；复用 seed，未 fresh seed）
- App 数据：内置词库/内置内容包已由 profile 带入；测试词 `address`（受限商业词表 2025，12 含义）；另存在同名词 `kaoyan-2027-dagang:address`，**所有落地判定均按计划词的 `wordId` 查询**
- 脚本：`tests/e2e/ai-qa-0.3.30.mjs`、`qa030-inspect*.mjs`、`qa030-s6.mjs`、`qa030-dblsave.mjs`
- 原始结果：`docs/qa/ai-0.3.30-raw.json`
- 真实 API：**2 次请求**（S1 1 条、S2 2 条），`deepseek-chat`，估算 **≈¥0.02**（≤¥0.5）；Key 仅经设置页 persistent 写入，未打印
- console：仅 mock 401 的资源错误，**无 JavaScript 异常**

## 结论

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 2 | 续跑丢历史、助记逐 c 无法进入审核 |
| P1 | 3 | 多 c 注解不显示、多 kind 词组被 limit 跳过、错误静默无 HTTP 状态 |
| P2 | 1 | 双击「开始生成」被第二次点击取消 |

| # | 必测项 | 结果 |
| --- | --- | --- |
| 1 | 单击生效 / 双击不重复 | ✅ 通过（双击开始有 P2 取消副作用） |
| 2 | 多 c 落地 | ⚠️ 部分通过（DB 落地正确，注解面不显示） |
| 3 | 多 kind 落地 | ❌ 失败（词组未落地） |
| 4 | 续跑不丢 | ❌ 失败（历史丢失） |
| 5 | 助记逐 c | ❌ 失败（审核框不出现） |
| 6 | 错误带 HTTP / append 文案 / 底部按钮 | ⚠️ 部分通过（HTTP 失败，另两项通过） |

---

## 1. 单击生效（✅ 通过，含 P2）

**期望**：开始生成点一次即进入生成；审核框「保存已选」点一次即保存关闭；无重复 pack/内容；快速双击只触发一次。

**实际**
- 真实 API，当前词 `address`，例句 append，目标 1。
- 单击「开始生成」：**400ms 内**出现「取消生成」；请求 **1 次**；审核框 **1 条**；单击保存后审核框关闭；新增 **1 个** `AI 生成` pack，例句从 0 → 2（API 一次返回 2 条例句，均落地），无重复。
- 双击「保存已选」（mock，另起一轮）：审核 **1 条**，请求 **1 次**，新增 **1 个** pack，仅落 **1 条** `QA7-1`，注解面仅 1 条。
- 快速双击「开始生成」：**没有**发出第二次请求；但第二次点击落在已切换的「取消生成」上，本轮被取消（`已取消，草稿已保存：已生成 0 / 总 1`）→ P2。

**请求数/items**：1 / 1；双击保存 1 / 1。
**落地数**：单次保存 1 pack、2 条例句；双击保存 1 pack、1 条。
**截图**：[S1-01](../assets/qa/ai-0.3.30/S1-01-panel-ready.png)、[S1-02](../assets/qa/ai-0.3.30/S1-02-review.png)、[S1-03](../assets/qa/ai-0.3.30/S1-03-after-save.png)、[S1-04](../assets/qa/ai-0.3.30/S1-04-dblclick-review.png)、[S1-06](../assets/qa/ai-0.3.30/S1-06-dblclick-save.png)
**console**：无异常。

**P2-01 双击开始会把本轮取消**
- 复现：AI 面板 → 例句 → append → 双击「开始生成」。
- 实际：第一次点击启动，第二次点击命中同位置的「取消生成」；0 请求完成，草稿 0/1。
- 影响：没有重复计费/重复 pack，但误双击会中断生成；建议生成中把「取消生成」延迟出现或错位/二次确认。

---

## 2. 多 c 落地（⚠️ 部分通过，P1）

**期望**：勾 c1+c2 → 目标 2 → 审核 2 条 → 保存后两个 c 的内容都出现在注解面对应行。

**实际**
- 真实 API，指定含义 c1+c2，例句 append：目标 **2**，请求 **1 次**，审核 **2 条**。
- 保存后 DB 正确：新 pack `pk_1794489740506_15089a`，2 条均 `applied`；`meaningIndex` 1/2，c1 新增 `Please write your address clearly…`、`She moved to a new address last month.`，c2 新增 `The president delivered an address…`、`His address at the ceremony…`。
- **但注解面只显示全局例句区**，不渲染 `meaning.examples`；保存后仍只有 3 条旧例句，c1/c2 的新例句在界面上看不到。
- 因此“指向对应行”的目标未达成：数据落地正确，UI 展示缺失。

**请求数/items**：1 / 2。
**落地数**：DB 2 条（分别挂 c1/c2），注解面新增 **0 条**。
**截图**：[S2-01](../assets/qa/ai-0.3.30/S2-01-multic-ready.png)、[S2-02](../assets/qa/ai-0.3.30/S2-02-multic-review.png)、[S2-03](../assets/qa/ai-0.3.30/S2-03-multic-after-save.png)
**console**：无异常。

**P1-01 注解面不展示 per-c 例句**
- 复现：AI 面板 → 指定含义 → 勾 c1+c2 → 例句 append → 生成 → 保存。
- 期望：c1/c2 行下各出现新例句（或可展开）。
- 实际：`AnnotationStage` 只渲染顶层 `examples`；`meaning.examples` 已在 DB 中但界面无入口。
- 影响：用户以为多 c 生成没生效。

---

## 3. 多 kind 落地（❌ 失败，P1）

**期望**：当前词勾例句+词组 → 目标 2 → 审核 2 条 → 保存后注解面例句区和词组区都有新内容。

**实际**
- mock，当前词，例句+词组 append：目标 **2**，请求 **2 次**（按 kind 各一次），审核 **2 条**（正确显示「例句」「词组」）。
- 保存后 DB：例句条目 `applied`；**词组条目 `status=skipped, skipReason=limit`**。
- 注解面：例句区新增 `QA1-1 example…`；词组区仍只有内置 8 条，**无新增**。
- `append` 审核无「（将替换）」，该文案修复通过。

**请求数/items**：2 / 2。
**落地数**：例句 1、词组 0。
**截图**：[S3-01](../assets/qa/ai-0.3.30/S3-01-multikind-ready.png)、[S3-02](../assets/qa/ai-0.3.30/S3-02-multikind-review.png)、[S3-03](../assets/qa/ai-0.3.30/S3-03-multikind-after-save.png)
**console**：无异常。

**P1-02 混合 kind 词组被 limit 跳过**
- 复现：当前词 → 勾「例句+词组」→ 均 append → 目标 2 → 生成 → 保存。
- 实际：词组 item 以 `skipReason=limit` 被静默跳过，toast 只显示「跳过 1」，未说明原因。
- 期望：按用户选择的类型落地；若受每义项条数上限限制，应在生成前提示/排除已有内容，或替换旧内容。

---

## 4. 续跑不丢（❌ 失败，P0）

**期望**：生成一部分 → 关闭 → 重开「继续」→ 审核框包含历史已生成 + 本次条目，保存后都落地。

**实际（mock，指定含义 c1+c2，首次只返回 1 条）**
1. 首次生成：请求 1 次，草稿 `done=1, cursor=1, total=2`；审核框未自动出现。
2. 关闭面板重开：显示「已生成 1 / 总 2（草稿已保存）· 继续 · 放弃草稿」。
3. 点「继续」：审核框 **1 条历史**（`QA1-1 … c1`）——正确。
4. 关闭审核框再点「开始生成」：请求 1 次，但审核框 **只剩本次 1 条**（`QA1-2 … c2`），历史 `QA1-1` 消失。
5. 保存：仅导入/应用本次 1 条（`meaningIndex=2`）；历史 `QA1-1` **从未 applied**，注解面也没有它。

**请求数/items**：历史 1 + 本次 1；续跑后审核 1（期望 2）。
**落地数**：1（期望 2）。
**截图**：[S4-01](../assets/qa/ai-0.3.30/S4-01-partial-first.png)、[S4-02](../assets/qa/ai-0.3.30/S4-02-draft-banner.png)、[S4-03](../assets/qa/ai-0.3.30/S4-03-resume-review.png)、[S4-04](../assets/qa/ai-0.3.30/S4-04-resume-plus-new-review.png)、[S4-05](../assets/qa/ai-0.3.30/S4-05-after-save.png)
**console**：无异常。

**P0-01 续跑历史只在「继续」时展示，关框即丢**
- 复现步骤同上第 3–5 步。
- 根因方向：`AiReviewDialog.onClose` 清空 `items/pending`；再次生成只把本次结果写入 `pending`，历史项没有从草稿重新合并。
- 期望：保存时按草稿全部 items（历史 + 本次）合并，而不是只看本次内存 `pending`。

---

## 5. 助记逐 c（❌ 失败，P0）

**期望**：多含义词助记生成 2 条 → 审核框显示「cX 中文 → [类型]」→ 保存后各挂对应 c 行。

**实际**
- mock，指定含义 c1+c2，仅助记 append：目标 **2**，请求 **1 次**。
- 生成结束后面板显示「**已生成 2 / 总 2（草稿已保存）· 本次已达上限 100，可点「生成一片先停」/重新打开继续**」。
- **审核框从未出现**（等待 15s），没有错误/失败提示；用户无法审核、保存，也就无法验证「cX 中文 → [类型]」。
- 截图中的开始按钮仍为「开始生成」，点击后仍走「存在未完成草稿」路径。

**请求数/items**：1 / 期望 2。
**落地数**：0（未进入保存）。
**截图**：[S5-01](../assets/qa/ai-0.3.30/S5-01-mnemonic-ready.png)、[S5-02](../assets/qa/ai-0.3.30/S5-02-mnemonic-review.png)
**console**：无异常。

**P0-02 完成态被误判为「未完成/达上限」**
- 现象：草稿实际 `done=2/total=2`，但代码走 `!isDraftComplete(cursor,total)` 早退分支，未执行 `setItems/setError`。
- 影响：助记逐 c（以及任何 cursor 未推进到 total 的成功生成）静默卡死；本项 5 完全不可用。

---

## 6. 顺带复验（⚠️ 错误文案失败，其余通过）

### P1-03 401 错误静默、无 HTTP 状态
- mock 401，例句 append，目标 1，请求 1 次。
- 实际 toast 为空；面板只显示「已生成 1 / 总 1（草稿已保存）· 本次已达上限 100…」，**既无错误分类也无 `HTTP 401`**；console 仅浏览器 401 资源错误。
- 期望：显示底层原因（HTTP 状态 + 响应体摘要），可重试。
- 截图：[S6-01](../assets/qa/ai-0.3.30/S6-01-error-401.png)

### append 审核无「（将替换）」✅
- mock append 生成 1 条，审核标题 `address · 例句`，全文无「将替换」。
- 截图：[S6-02](../assets/qa/ai-0.3.30/S6-02-append-review.png)

### 底部按钮可点 ✅
-「开始生成」`elementFromPoint` 命中 `BUTTON`（S1/S2/S3/S5 均如此），实际点击均能触发；未被底部评分栏遮挡。

---

## 附：DB 证据（按计划词 `kaoyan-hongbaoshu-2025:address`）

| pack | 条目 | 状态 | 说明 |
| --- | --- | --- | --- |
| `pk_1794489543957_hhillo` | 例句 ×1 | applied | S1 真实 API，2 条例句 |
| `pk_1794489740506_15089a` | c1、c2 各 1 | applied | S2 多 c，`meaning.examples` 已写入 |
| `pk_1794489871089_pq1ym8` | 例句 1 / 词组 1 | applied / **skipped(limit)** | S3 混合 kind，词组丢失 |
| `pk_1794490035937_urf1az` | c2 ×1 | applied | S4 本次；历史条目不存在 |
| `pk_1794490808927_9fgex1` | 例句 ×1 | applied | 双击保存去重验证，1 pack/1 条 |

## 修复建议（按优先级）

1. **P0 续跑合并**：保存时以草稿全部 items 为准合并历史 + 本次，不要依赖关闭审核框即清空的 `pending`。
2. **P0 完成态判定**：`cursor` 按成功目标推进到 `total`，或在 `done >= total` 时直接进入审核；失败/401 不得走「已达上限」分支，必须显示错误。
3. **P1 多 c 展示**：注解面渲染 `meaning.examples`（或提供 c 行展开），否则用户看不到多 c 结果。
4. **P1 多 kind**：`skipReason=limit` 的词组不应静默跳过；生成前排除已达上限的类型，或明确提示/替换。
5. **P2 双击开始**：生成中按钮切换增加防抖/延迟，避免第二次点击取消。
