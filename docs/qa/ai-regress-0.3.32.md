# AI 补内容 0.3.32 · 浏览器回归报告

- 环境：`http://127.0.0.1:4173`，构建 `index-DkmxpqUg.js`，版本 `v0.3.32`（**未重建/重启**）
- 时间：2026-11-12 21:54–22:20（Asia/Shanghai，实际约 26 分钟；**超出 15 分钟时间盒**，见文末「耗时说明」）
- 浏览器：Playwright Chromium，390×844，持久化 profile `/tmp/qa032-profile`（由 `/tmp/qa030-profile` 复制，IDB origin 已是 4173；复用 seed，未 fresh seed）
- App 数据：测试词 `address`（受限商业词表 2025，12 含义，wordId `kaoyan-hongbaoshu-2025:address`）；同库另有 `kaoyan-2027-dagang:address`（1 含义），**所有 DB 判定已按计划词 wordId 复核**（见「方法修正」）
- 脚本：`tests/e2e/ai-qa-0.3.32.mjs`（主跑）、`qa032-rerun.mjs`（S2/S3/S6 复跑）、`qa032-probe` 逻辑内嵌于复跑脚本
- 原始结果：`docs/qa/ai-0.3.32-raw.json`、`docs/qa/ai-0.3.32-rerun.json`、`docs/qa/ai-0.3.32-probe.json`
- 真实 API：**0 次请求，花费 ¥0**（全程 mock，共 11 次 mock 请求：主跑 8 + 复跑 3；未使用 `.secrets/deepseek-key`）
- console：仅 mock 401 的 browser 资源错误，**无 JavaScript 异常 / 无 pageerror**

> ⚠️ 环境坑：复用 profile 首次打开时被旧 Service Worker 缓存带到了旧构建 `index-Bwp-fznG.js`。本次通过「清空 profile 的 `Service Worker`/`Cache` + `serviceWorkers: 'block'`」强制加载线上 0.3.32。**后续复用 profile 做回归必须先做这一步**，否则测到的不是目标构建。

## 结论

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| P0 | 0 | 0.3.32 未发现 P0 |
| P1 | 1 | 多 c 例句「DB 已写入、注解面仍不显示」——0.3.30 的 P1-01 未真正修复 |
| P2 | 2 | 401 面板同时保留「本次已达上限」摘要；续跑保存拆成 2 个 pack |

| # | 必验项 | 结果 | 请求/审核 items | 落地 |
| --- | --- | --- | --- | --- |
| 1 | 续跑历史 c1+c2（首轮只返回 1 条） | ✅ 通过 | 首轮 1 req / 1 item；继续 1 item；再生成 1 req / **2 items** | **2/2 applied**（c1、c2 各 1） |
| 2 | 助记 done2/2 弹审核 | ✅ 通过 | 1 req / **2 items**，无「本次已达上限」 | 2/2 applied，c1/c2 行各挂 1 条 |
| 3 | 多 c 例句注解面显示 | ❌ **失败（P1）** | 1 req / 2 items，保存成功 | DB 2/2，**注解面 0 条** |
| 4 | append 词组不被 limit skip | ✅ 通过 | 2 req / 2 items | 2/2 applied，`skipReason=limit` 0 条；词组 8→9，UI 显示 |
| 5 | 401 带 HTTP 状态、不被上限覆盖 | ✅ 通过（P2 残留） | 1 req | 面板 danger 行含「（HTTP 401）」；但上限摘要同时存在 |
| 6 | 双击/连点开始不取消 | ✅ 通过 | 1 req | 320ms 内点「取消生成」被忽略，仍进入审核 |

---

## 1. 续跑历史（✅ 通过）

**步骤**：当前词 `address` → 指定含义 c1+c2 → 仅例句 append → 目标 2 → mock 首轮只返回 1 条（c1）→ 审核 1 条 → 关闭审核框/面板 → 重开面板点「继续」→ 关闭审核框 → 再点「开始生成」（mock 返回 c2）→ 审核 2 条 → 保存。

**实际**
- 首轮：请求 **1** 次，审核框 **1 条**（`Q32A example for address c1`），草稿 `done=1 / cursor=1 / total=2`（[S1-02](../assets/qa/ai-0.3.32/S1-02-first-partial.png)）。
- 重开面板显示「已生成 1 / 总 2（草稿已保存）· 继续 · 放弃草稿」，点「继续」→ 审核 **1 条历史**（[S1-03](../assets/qa/ai-0.3.32/S1-03-resume-review.png)）。
- 关审核框后再生成：请求 **1** 次，审核框 **2 条**（历史 c1 + 本次 c2，[S1-04](../assets/qa/ai-0.3.32/S1-04-resume-plus-new-review.png)）。
- 保存：审核框关闭，新增 **2 个** pack（`pk_1794492047356_hr130u` c1、`pk_1794492049504_kn2r34` c2），两条均 `applied`；DB 中 c1 有 `Q32A example for address c1`、c2 有 `Q32A example for address c2`（按计划词 wordId 复核）。
- 注：保存后切回注解面顶部无 per-c 例句（与第 3 项同一 UI 缺陷），不影响「历史 2 条已落地」的判定。

**P2-01 续跑保存拆成 2 个 pack**
- 复现：同上（历史 c1 + 本次 c2）。
- 实际：一次「保存已选（2）」生成 2 个 `examples` pack（各 1 条），而单轮生成只生成 1 个 pack。
- 影响：多一次 import/apply 与一次汇总；toast 仍为「已应用 2 条」，数据正确。推测历史条目合并时 target 未带 deckId，按 deck 分组落成两包。

## 2. 助记 done2/2 弹审核（✅ 通过）

**步骤**：指定含义 c1+c2 → 仅助记 append → 目标 2 → mock 返回 2 条 → 等审核框。

**实际**
- 请求 **1** 次，审核框 **2 条**，标题「审核生成内容（2）」（[S2-02](../assets/qa/ai-0.3.32/S2-02-review.png)）。
- 审核条目显示「c1 地址 → [assoc] Q32R21 助记 c1」「c2 演讲 → [assoc] …」，面板为「完成 2 / 2 条 · 已用 ¥0.00」，**无「本次已达上限」**。
- 保存：1 个 `mnemonics` pack，2 条均 `applied`（meaningIndex 1/2）；注解面 c1/c2 行分别显示 `[联想]Q32R21 助记 c1` / `…c2`（[S2-03](../assets/qa/ai-0.3.32/S2-03-after-save.png)）。

## 3. 多 c 例句显示（❌ 失败，P1-01 仍未修复）

**步骤**：指定含义 c1+c2 → 仅例句 append → 目标 2 → mock 返回 2 条 → 保存（唯一 tag `Q32R31`，避免与历史内容重复）。

**实际**
- 请求 **1** 次，审核 **2 条**；保存 1 个 pack `pk_1794492935379_kslfsj`，2 条均 `applied`（meaningIndex 1/2）。
- **DB 正确**：计划词 `kaoyan-hongbaoshu-2025:address` 的 `meanings[0].examples` 含 `Q32R31 example for address c1`，`meanings[1].examples` 含 `Q32R31 example for address c2`（另见 `docs/qa/ai-0.3.32-probe.json`；0.3.30 期写入的 c1/c2 例句也在）。
- **注解面仍为 0 条**：`.meanings > div` 的 12 个 c 行中 `.meaning-example` 全为空；[S3-03](../assets/qa/ai-0.3.32/S3-03-after-save.png) 与 [S1-05](../assets/qa/ai-0.3.32/S1-05-after-save.png) 均看不到任何 per-c 例句。

**根因（源码核对，未改 src）**
- `AnnotationStage` 已按 `meaning.examples` 渲染（[AnnotationStage.tsx:91](src/ui/study/components/AnnotationStage.tsx#L91)）。
- 但注解面的 `meanings` 取自 `session.word.meanings`（[useStudySession.ts:788](src/ui/study/hooks/useStudySession.ts#L788)），而 `toSessionWord` 只映射 `{ meaningId, pos, cn }`，**丢掉了 `examples`**（[useStudySession.ts:324-328](src/ui/study/hooks/useStudySession.ts#L324-L328)）。
- 结果：新渲染分支永远拿不到数据，属「死代码」。修复方向：`toSessionWord` 保留 `examples`（并补类型），或让 `meanings` memo 直接从 `word.meanings` 取 `examples`。

## 4. append 词组不被 limit skip（✅ 通过）

**步骤**：当前词 → 勾选「例句 + 词组」→ 两者均 append → 目标 2 → mock 各返回 1 条 → 保存。

**实际**
- 请求 **2** 次（按 kind 各一次），审核 **2 条**（例句/词组各 1，[S4-02](../assets/qa/ai-0.3.32/S4-02-review.png)），无「（将替换）」。
- 保存：1 个 `mixed` pack `pk_1794492497909_d1aa7h`，**2 条均 `applied`，无任何 `skipReason=limit`**。
- 词组 API 前 8 条 → 后 **9 条**，新增 `address Q32B up`；注解面 `.phrase-row` 出现该条；例句同时新增 `Q32A example for address c-`。
- 说明：`allowOverLimit` 对 append 生效，0.3.30 的 P1-02 已修复。

## 5. 401 错误提示（✅ 通过，P2 残留）

**步骤**：例句 append，目标 1 → mock 401 → 点开始。

**实际**
- 请求 **1** 次；面板 danger 行显示「Key 无效或已过期：请检查 API Key 后重试。**（HTTP 401）**」（[S5-01](../assets/qa/ai-0.3.32/S5-01-error-401.png)），**错误行没有被覆盖**。
- 无 toast（该路径只 setError，不弹 toast）；草稿已清理（`draftLeft=0`）。

**P2-02 401 时仍显示「本次已达上限」摘要**
- 面板同时出现「已生成 1 / 总 1（草稿已保存）· 本次已达上限 100，可点…」，位于 error 行上方。
- 影响：错误可见，但摘要误导用户「已生成/达上限」；建议失败时不要走 `!isDraftComplete` 的上限摘要分支，或改为「失败 1 / 总 1」。

## 6. 双击开始不取消（✅ 通过）

**步骤**：例句 append，目标 1 → mock 延迟 1.6s → 点「开始生成」→ 320ms 后点「取消生成」（与快速双击落点等价）→ 观察是否取消。

**实际**
- 320ms 时「取消生成」可见（[S6-01](../assets/qa/ai-0.3.32/S6-01-running.png)），点击后 500ms 面板仍为「正在生成 0 / 1 · 已用 ¥0.00」（[S6-02](../assets/qa/ai-0.3.32/S6-02-early-cancel-click.png)），**未出现「已取消」**。
- 随后进入审核框 1 条（[S6-03](../assets/qa/ai-0.3.32/S6-03-review.png)），请求仍为 **1** 次。
- 0.3.30 的 P2-01 已修复（800ms 取消守卫）。

---

## 方法修正 / 可复现性备注

1. **旧构建缓存**：复用 profile 必须清 `Service Worker` + `Cache` 并阻塞 SW，否则加载到 `index-Bwp-fznG.js`（非 0.3.32）。
2. **同名词歧义**：`address` 在库中有两个 deck 版本。主跑脚本首版按 headword 取第一个词，导致 S1/S3/S4 的 DB 断言误报（`0.3.32-raw.json` 中的 F03/F12/F16 为误报；脚本现已改为按计划词 wordId 查询）；复跑/探针已按 `kaoyan-hongbaoshu-2025:address` 复核，真实结果见上表。
3. **助记 mock 格式**：助记 prompt 是 `targets（…）：\n[json]`，不是 `targets = `。0.3.30 的 `ai-qa-0.3.30.mjs` mock 解析不到助记 prompt，会返回空 items，从而表现出「done2/2 但无审核」。**0.3.30 报告中的 P0-02 至少部分是 mock 假象**；本次修正 mock 后，0.3.32 助记 2/2 正常弹审核并落地。0.3.30 真实存在的「部分完成时 setItems 在 early-return 之后」问题已由 0.3.32 的合并逻辑覆盖。
4. **重复内容**：同 tag 的例句在 append 时会被去重（duplicate），复跑使用唯一 tag 后才验证到真实写入。

## 耗时说明

6 个场景各需「injectPlan + 整页 reload + 等待内置内容包/首页 + 进入学习 + 注解面」，本机单场景约 2–2.5 分钟；加上首次构建缓存排障、助记 mock 修正后的 S2/S3/S6 复跑，总耗时约 26 分钟，超出 15 分钟时间盒。若只需复验 P1-01，可单跑 S3（约 2.5 分钟）。

## 给 Lead 的剩余项

- **P1-01（未修复）**：注解面 per-c 例句不显示。根因 `toSessionWord` 丢弃 `meaning.examples`；建议补 `examples` 到 session word 或在 `meanings` memo 直接读 `word.meanings`。
- **P2-01**：续跑保存拆 2 个 pack（数据正确，多一次 apply）。
- **P2-02**：401 时同时显示「本次已达上限」摘要（错误行仍可见）。
- **P2-03（运维）**：PWA 旧 SW 会在部署后继续提供旧构建，建议检查 `sw.js` 的 skipWaiting/clientsClaim 与版本化缓存，避免用户「修复没生效」。
- **P0**：无。
