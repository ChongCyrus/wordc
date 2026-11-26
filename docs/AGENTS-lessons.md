# 背单词 APP 项目工作流约定（经验教训）

本文件由 0.15 → 0.16 数据安全攻坚总结，供后续 Agent/自动化复用。

## 1. 数据安全第一原则

- **唯一事实源**：Android APK 内 SQLite；IndexedDB 只是 cache（Web/PWA 除外）。
- 任何“以 IDB 为判据改/删 SQLite”的路径都是高风险，必须显式校验、失败回滚。
- 不允许为了测试通过放宽 readonly / cache fail-closed / 单源门禁。
- 日用包（com.wordc.app）是用户真实数据，**未经完整备份不得清空/导入/回滚**。
- 所有破坏性操作先在 QA 包（com.wordc.app.qa）演练。

## 2. 数据类改动验收门禁

发布/升级前必须全部通过：

1. `tsc --noEmit` 0
2. `tests/data` 全量 0 failed
3. `tests/ui` 全量 0 failed
4. 真机：
   - 替换导入后 states/plans/reviewLogs 与备份精确一致
   - 清空 → 从自动备份恢复 → logs 恢复
   - >20MB 完整备份可导出
   - 首词前进、乐观翻页、save gate、重启无迁移遮罩
5. 0.15→0.16 迁移演练（先 QA，再日用）

## 3. 导入/恢复语义（踩过的坑）

- `merge` 不导入 reviewLogs；用户以为“恢复=完整恢复”会丢历史 → 恢复默认 `replace`。
- `replace` 必须：
  - 按 deck 差集删 stale states
  - plans 先 clear 再写今日
  - reviewLogs 先 clear 再写
  - counts 校验 states/plans/logs 精确；settings 允许设备本地多
- staging 导入前必须 reset `migration_state.legacy-idb`，否则 migrate 直接 skipped。
- migrate 的 `force` 只能内部使用（unsafe + 已 reset），不得作为公开绕过门禁。
- 导入失败必须回滚 SQLite 快照 + content 写源 + cache，不能留三源分叉。

## 4. 备份/恢复

- 空库不得写自动备份（会覆盖/挤掉有效备份）。
- 自动备份恢复必须选“有 states 的有效备份”，不能只看最新。
- restore 成功后必须：
  - 重建 IDB cache（force，以 SQLite 为准）
  - persist learningWriteSource('sqlite')
  - 刷新页面/重启验证
- 原生备份必须 tmp + fsync + rename + 回读校验；禁止直接覆盖截断写。

## 5. 调试方法论（本轮最重要教训）

**不要连续“打一个包试一次”。**

当同一症状连续 3 个版本不消失：

1. 停止盲改。
2. 派**定向审计**：只查一条链，静态还原调用链 + 运行时探针。
3. 要求审计给出：
   - 唯一根因
   - 为什么历次修复无效
   - 最小 diff 级修复
   - 可复现单测
4. 修复后先跑相关单测，再打一个包真机验证。

本轮根因：`cache-rebuild` 的 force 分支被 `conflict = undefined` 弄成不可达，导致 246–255 全部无效；定向审计一次命中。


## 5.1 构建前审计门禁（强制）

**同一症状连续 2 次未消失，禁止继续构建试错。**

构建前必须满足：

1. 对受影响子系统做**系统性审计**，不是单链：
   - 写源状态机（idb/sqlite/readonly/恢复中）全部状态与迁移
   - restore / cache rebuild / epoch / reload / 启动 / 导入 / 清空 / 升级
   - UI cache 与事实源一致性
   - 失败回滚
2. 产出状态迁移表 + 路径覆盖矩阵；每条路径有测试或明确理由。
3. 审计确认不存在：
   - 条件互斥导致的不可达分支
   - 静默 catch 吞错
   - 状态被后续流程覆盖
4. tsc 本地绿；tests/data + tests/ui 全量优先在 GitHub CI 跑绿（本地只跑针对性文件，避免手机 OOM/慢）。
5. 有回滚包/备份。
6. 构建只用于验证，不用于调试。

违反该门禁的构建视为无效构建，必须回退到审计。

## 5.2 决策记录（新决策替换旧决策）

- **测试分层（2026-11-25 起）**：本地只跑 tsc + 针对性短测；全量 tests/data/tests/ui 推到 GitHub Actions `data-tests.yml`（mode=all）跑，不再默认在手机上跑全量。
- **状态机单一所有权**：学习写源恢复只允许一个入口 `requestSourceRecovery()`；禁止多个 effect/按钮各自决策；`diagnose*` 只诊断不改状态。
- **reload 一次性**：页面重载必须“进入快照 vs 当前”比较 + sessionStorage 标记；仅目标状态非 readonly 时刷新。
- **meta=内存 不变量**：`persistLearningWriteSource` 是唯一写源入口；readonly 也必须持久化；禁止裸改内存变量。
- **先审计后构建**：连续 2 次同症状不消失 → 停止构建；系统性审计（状态迁移表+覆盖矩阵+测试）后再一次性修。
- **恢复/缓存顺序**：restore 先 epoch+dirty，再 rebuild，成功后显式 dirty:false；禁止重建后再标脏。
- **CI 优先**：能用 CI 的全量验证不要放在手机；手机只做真机行为和升级验证。

## 6. Agent 团队协作

- 任务必须写清：写作用域、验收标准、禁止事项（不碰日用/不发布）。
- 并发写同一文件前先拆分或串行；写完立即小 commit，避免大 WIP 阻塞 tsc/打包。
- 审计 agent 默认只读；修复 agent 才允许改 src。
- 每个 agent 完成必须回：commit、测试数字、剩余风险。
- 额度紧张时：先落盘草稿，再完善；禁止为了完备拖时间。

## 7. 发布纪律

- 不通过全量回归 + 真机数据终验，不 tag、不发布、不升级日用。
- 发布前保留：
  - 日用完整备份（含 counts/checksum）
  - 上一稳定版 APK
  - 可回退路径
- 对外只说已验证事实；不得宣称“绝对不丢数据”。

## 8. 常用路径

- 0.16 worktree：`.agents/worktrees/next-0.16`
- QA 包：`com.wordc.app.qa`
- 日用包：`com.wordc.app`
- 产出 APK：`下载/`
- 数据审计报告：`docs/reports/audit-0.16-*.md`
