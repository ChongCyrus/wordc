# ARCH v2 · 架构变更与迁移方案（配套 docs/SPEC-v2.md）

> 状态：定稿（task-23，2026-11-11）。优先级低于 `DECISIONS.md`、`SPEC-v2.md`；高于 `ARCH.md`（v1，保留作对照）。
> 范围：Dexie v2 迁移、模块接口变更、**任务拆分建议**、兼容/回滚、验证计划。
> 关联：`docs/SPEC-v2.md`（规则定稿）、`docs/CORE-API.md`（core 现状）、`docs/DATA-API.md`（data 现状）。

---

## 0. 一句话

v2 的净变更 = **1 张新表（plans）+ 3 个新设置项 + WordState/ReviewLog 增量字段（可默认补全）+ core 预测/首评/队列改造 + UI 续学/回退**。
所有迁移**只加不删**，旧数据无损；不支持降级（降级前先导出迁移包）。

---

## 1. 变更总览

| 层 | 变更 | 影响文件（写范围） |
|---|---|---|
| core | `todayProgress`、`Predict`/`WordPredicts`/`predictAll`/`isFirstShow`、`firstFamiliarDays`/`firstVagueDays`、`pickQueue` 不截断、`deriveHomeState`（若 core 不交付则由 UI 纯函数兜底）、撤销辅助类型 | `src/core/types.ts`、`params.ts`、`schedule.ts`、`preview.ts`（新）、`queue.ts`、`plan.ts`（新）、`index.ts`；`tests/core/**`；`docs/CORE-API.md` |
| data | Dexie v2 + `plans.repo.ts`（today plan 全套 API + undo/getLastReviewSnapshot）；设置 3 项（已实现）；DailyGoal 1–9999（已实现）；ReviewLog 可选字段；迁移包含 plans | `src/data/db.ts`、`plans.repo.ts`（新）、`study.repo.ts`、`settings.repo.ts`、`import-export.ts`、`schema.ts`、`index.ts`；`tests/data/**`；`docs/DATA-API.md` |
| ui/app | 三键文案官方格式 + 标签切换 + memory.showPredictedInterval、学习页 plan 驱动 + 回退/改判 UI、首页 6 态 + 继续学习、每日学习量输入框、设置页 3 项 | `src/ui/study/**`、`src/ui/home/**`、`src/ui/me/**`、`src/app/hooks/**`；`tests/ui/**`；`docs/UI-STUDY.md`、`docs/UI-APP.md` |
| 数据（词库） | 官方难度写入 deck（`Word.difficulty`）、dataVersion 升级 | `src/data/builtin/**`、`tests/data/builtin.test.ts`、`docs/DATA-API.md` |
| 交付 | PWA dist、APK（壳不动，仅换 assets/pwa） | `scripts/`、`tools/apk/`（仅 rebuild，不改壳代码） |

**不动**：`src/app/router.tsx` 路由路径、PWA 配置、APK 壳的 WebView 拦截逻辑（IndexedDB 同 origin，自动享受 v2 迁移）。

---

## 2. Dexie v2 迁移方案（**不可丢数据**）

### 2.1 表结构 diff

```ts
// v1（现状）
decks: 'id, name, source, builtinKey, updatedAt'
words: 'id, deckId, [deckId+order], headwordLower, *tags, createdAt'
states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt'
reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating'
settings: 'key'
meta: 'key'

// v2（只新增 plans 表；旧表索引不变；reviewLogs 只加可选字段，不加索引）
this.version(2).stores({
  decks: 'id, name, source, builtinKey, updatedAt',
  words: 'id, deckId, [deckId+order], headwordLower, *tags, createdAt',
  states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt',
  reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating',
  settings: 'key',
  meta: 'key',
  // v2 新增：一天一词库一行；主键 id = `${date}:${deckId}`
  plans: 'id, date, deckId, updatedAt, completedAt',
})
```

> Dexie 的 `.stores()` 只声明**索引**；新增表是兼容变更。`plans` 主键是 `id`（日期+词库，
> 一天内切词库可有多条），不是单纯日期。

### 2.2 版本号与「无数据迁移」策略

```ts
export const SCHEMA_VERSION = 2
this.version(2).stores({ /* 见 §2.1 */ })     // 不写 .upgrade()
// db.open() 成功后：meta.put({key:'schemaVersion', value:2}) + meta.put({key:'migratedAt.v2', value:now})
```

- v2 **只新增 `plans` 表 + `reviewLogs` 可选字段**：旧数据无需逐行改写。
  `stateBefore/corrected` 缺失 = "不可撤销/未撤销"；`WordState.todayProgress` 缺失 = 0。
- **不要**为了补默认字段做全表 `modify`（上万行会拖慢首启，且无必要）；确实需要预聚合时再加 `.upgrade()`。
- **降级不支持（重要，更正设计稿 §1 说法）**：Dexie 打开高于代码版本的库会抛 `VersionError`，
  旧客户端**不能**读 v2 库（"忽略新表"不成立）。发版说明必须写「降级前先导出迁移包」。
- 失败处理：捕获 `VersionError / QuotaExceededError` → 提示「数据升级失败，已保留原库，请先导出备份」，
  **不自动删除、不自动重建**。

### 2.3 迁移测试（QA/单测必须覆盖）

- `fake-indexeddb` 构造 v1 fixture（decks/words/states/reviewLogs/settings/meta）→ 打开 v2：
  各表记录数不变、`plans` 表存在且为空、`meta.schemaVersion=2`、旧 `ReviewLog` 无 `corrected` 字段（读为 false）、
  旧 `WordState` 无 `todayProgress` 字段（读为 0）；
- 二次打开幂等（不重复建表/不重复写入 meta）；
- 迁移失败注入（QuotaExceeded）→ 原库不变 + UI 提示导出备份。

### 2.4 plans 表生命周期与清理

- 建队：`plans.put(plan)`（主键 `${date}:${deckId}`；同 id 覆盖 = 保存进度）；
- 跨天：`getTodayPlan` 用当天 `${date}:${deckId}` 自然不命中旧 plan；
- 清理：`cleanupOldPlans({ keepDays: 7 })` 删 `date < today-7` 的行（默认保留 7 天，供后续今日/历史回顾扩展）；
- 完成：写 `completedAt`；行保留到清理；`completedAt` 建索引供快速统计；
- `meta:plan.activeId` 指向最近学习的 plan，`meta:plan.updatedAt` 供首页快速判断（不必扫表）。

## 3. 模块接口变更（contract）

### 3.1 `src/core` 新增/变更（**dev-algo 已全部交付**：`tests/core` 166 条单 fork 全绿；以代码为准）

```ts
// —— 类型（src/core/types.ts，已从 src/core 出口 export）——
export interface Predict { first: boolean; days: number; progress: number }
export type WordPredicts = Record<Rating, Predict>      // 认识/模糊/忘记（不是数组）
export type { DailyPlan, PlanRating, PlanWordSource, HomeStudyState }
export interface ProgressLevel { name: string; vague: number; forget: number; familiar: number | 'days' }
export interface LevelTransition { to: number | 'complete'; inferred?: boolean }
// WordState v2 可选字段：todayProgressLevel?（1–5）/ canFinishToday?（v2 默认启用，缺失按首评入口档位派生）
export interface ReviewLog {
  // v1 字段…
  stateBefore?: WordState | null     // 首评新词为 null
  corrected?: boolean
  correctedBy?: number
}

// —— 参数（src/core/params.ts）——
firstIntervalK: 80          // 首评「认识」（Lead 指示 100 → 80；d=1→63、d=5→21、d=10→10）
firstVagueIntervalK: 100    // 首评「模糊」独立常数（与认识解耦；d=1→3、d=5→2）
firstFamiliarMin: 7; firstFamiliarMax: 90
firstVagueMin: 1;   firstVagueMax: 7   // firstVagueDays 走 firstVagueHalfLife(d)=stabilityAfterForget(d, K_v*h0(d), 0.9)
firstForgetDays: 1
forceNextDayOnForgot: false        // task-26：忘记不再强制次日（A/B 开关）
progressBase: 0.2; progressFamiliarStep: 0.4; progressVagueStep: 0.2; progressForgetStep: 0
progressFailCap: 0.8
// —— v2 5 档进度状态机（**默认启用**，Lead 实机 face/cat/yellow 验证；D 级推算）——
progressModelMode: 'v2-levels' | 'v1-20pp'      // 默认 'v2-levels'；'v1-20pp' 保留回滚/A-B
progressLevels: ReadonlyArray<ProgressLevel>    // 5 档：L1a(0.6/0.2/0.8)、L1b(0.4/0.2/0.6)、L2(0.6/0.4/days)、L3(0.8/0.6/days)、L4(0.8/0.8/days)
progressOnVague: Readonly<Record<number, LevelTransition>>    // 1→3,2→1ᵢ,3→4,4→4,5→4
progressOnForget: Readonly<Record<number, LevelTransition>>   // 1→2ᵢ,2→2ᵢ,3→1,4→3,5→3ᵢ
progressOnFamiliar: Readonly<Record<number, LevelTransition>> // 1→4,2→3,3→complete,4→complete,5→completeᵢ
progressInitialLevelVague: 1        // 首评「不确定」→ L1a
progressInitialLevelForget: 2       // 首评「不认识」→ L1b
canFinishMode: 'table' | 'always' | 'never' | 'level>=3' | 'afterFirstFail'  // 默认 table（F 列=days ⇔ 完成）
allowVagueComplete: false          // 运行时由 settings['study.allowVagueComplete'] 注入
labelSwitch: 'firstEver'           // 'firstEver' | 'firstToday'（语义键）
// N（认识=N天后）复用 state.nextIntervalDays
// 回炉 gap 保持 v1：requeueGapForgot=4 / requeueGapVague=8

// —— 函数（src/core/schedule.ts + plan.ts）——
firstFamiliarDays(difficulty, params?): number
firstVagueDays(difficulty, params?): number
isFirstShow(state, params?, now?): boolean          // firstToday 分支需显式 now
predictAll(state, now, params?): WordPredicts
deriveHomeState(input: HomeStateInput): HomeStudyState   // 6 态，SPEC §6.2 逐条实现
getCurrentWordId(plan: DailyPlan): string | null
scheduleNext(...)    // 返回 { state, log, longTermUpdate, requeue, completesToday }
previewNext(rating, state, now, params?): NextPreview   // todayRequeue 枚举 + first/todayProgress/completesToday 可选
pickQueue(...)   // 签名增可选 reviewCap（0/缺省=旧行为，复习不硬截断）
                 // DailyQueue.dueCount=今日入队复习数（受 cap）；dueTotal=全部到期（必填）；
                 // HomeStudyData.dueCount=全部到期（数据层统计），积压量=reviewBacklog
```

> **`formatPredict` / `buttonLabels` 已按决议移出 core**（core 只出数据；格式化/标签在 UI：
> `src/ui/study/lib/next-hint.ts` / `rating-labels.ts`）。
> `Word`/`WordState` v2 字段、`ReviewLog` 三字段、plan/首页 6 态类型均已落地，dev-data 可直接改为 re-export。

### 3.2 `src/data` 新增（`plans.repo.ts`，出口从 `src/data/index.ts` 暴露；与 DATA-PLAN-v2-design.md §4 一致）

```ts
export interface TodayPlanOptions {
  deckId?: string | null; now?: number; extraNewWordIds?: string[]; forceRebuild?: boolean
}

export function getTodayPlan(opts?: TodayPlanOptions): Promise<DailyPlan>
export function saveTodayPlan(plan: DailyPlan): Promise<void>
export function hasResumablePlan(opts?: { deckId?: string | null; now?: number }): Promise<boolean>
export function getCurrentWordId(plan: DailyPlan): string | null
export function setPlanIndex(planId: string, index: number): Promise<DailyPlan>
export function advancePlanAfterRating(input: {
  planId: string; wordId: string; rating: Rating; reviewedAt: number; longTermUpdate: boolean
}): Promise<DailyPlan>
export function appendRequeue(input: { planId: string; wordId: string; gap: number; reviewedAt: number }): Promise<DailyPlan>
export function completePlan(planId: string, now?: number): Promise<DailyPlan>
export function clearPlan(planId: string): Promise<void>
export function cleanupOldPlans(opts?: { keepDays?: number; now?: number }): Promise<number>

// 回退/改判
export function getLastReviewSnapshot(wordId: string): Promise<{
  log: ReviewLog; stateBefore: WordState; planIndex?: number
} | null>
export function undoLastRating(input: {
  wordId: string; planId?: string; now?: number
}): Promise<{ state: WordState; plan: DailyPlan | null }>
```

**落地状态（task-28/29 已完成）**：
- `src/data/plan.types.ts` 已改为 **re-export core** 的 `DailyPlan/PlanRating/PlanWordSource/HomeStudyState`；
  data 层只保留自有类型 `LastReviewSnapshot`（`getLastReviewSnapshot` 返回）与 `HomeStudyData`
  （`getHomeStudyData` 返回；字段：`now/deckId/hasDeck/hasLearnableWord/dueCount/newBudget/dailyGoal/plan/remaining/todayReviewed/overdueLeft`）；
- `ReviewLogV2 = ReviewLog & { reverted?: boolean }` 保留为**兼容别名**：撤销同时写 `corrected:true + reverted:true`，
  统计过滤 `corrected !== true && reverted !== true`；新代码以 `corrected` 为准；
- 文件为实现名 `src/data/plans.repo.ts`（非 `plan.repo.ts`）；`src/data/index.ts` 已导出全部 plan API + 上述类型。

**过渡约定（core 已补齐，按此收口）**：
1. `DailyPlan/PlanRating/PlanWordSource/HomeStudyState` 已在 `src/core` 落地 → **dev-data 改为从 core re-export**，
   删除 `src/data/plan.types.ts` 本地定义（对外签名不变）。
2. `ReviewLog.stateBefore/corrected/correctedBy` 已在 core 类型中 → `ReviewLogV2` 仅保留为**兼容别名**（含 `reverted?`），
   新代码以 `corrected` 为准；写入评分日志必须带 `stateBefore`（首评新词 `null`），`corrected` 缺省 false。
3. `deriveHomeState` / `getCurrentWordId` 由 core 提供 → UI 直接 import；data 只提供事实
   `getHomeStudyData()`（plan/dueCount/newBudget/todayReviewed/overdueLeft/hasDeck/hasLearnableWord）。
4. 其余按本节接口全量实现；完成后单文件测试（单 fork）。

**原子性（硬约束）**：`submitRating` 扩展为**同一事务**完成
`scheduleNext → states.put → reviewLogs.add(log 含 stateBefore) → advancePlanAfterRating / appendRequeue`；
不允许先写状态再异步补 plan。`submitRating` 增加可选 `{ planId?: string }` 参数。
- `getTodayQueue()` 保留（统计/调试），内部基于 plan 投影；
- 统计/曲线必须过滤 `reviewLogs.corrected === true`（data 层过滤后再传给 core stats）。

### 3.3 `src/app` / `src/ui` 变更

```ts
// src/app/hooks/useTodayPlan.ts（新）：useLiveQuery(db.plans ...) + getTodayPlan
// src/app/hooks/useHomeStudyState.ts（新）：deriveHomeState 包装（fresh/ongoing/done/overdue）
// src/ui/study/hooks/useStudySession.ts（重写）：plan-driven
//   - 进入：getTodayPlan → meta:plan.activeId + meta:session:<wordId> 恢复词/阶段/w-c 次数
//   - 评分：submitRating({planId})（事务内更新 plan）
//   - 回退：getLastReviewSnapshot → undoLastRating → 重新 submitRating
//   - 退出：flush session 快照 → saveTodayPlan
```

UI 映射见 SPEC-v2 §6/§7；路由不变（`/study` 仍为学习页）。

## 4. 关键时序（供实现对照）

### 4.1 建队/续学

```
HomePage mount
  → getTodayPlan({deckId, now})  → 有 → deriveHomeState(ongoing/fresh/done…)
                                  → 无 → 显示 fresh（待复习=dueCount、待新学=max(0,goal-due)）
  → 点击开始/继续 → /study
      → getTodayPlan（无则事务建队：review 全量 + new 预算；写 plans.goals 快照）
      → meta:plan.activeId + meta:session:<wordId> 恢复词/阶段/w-c 次数
```

### 4.2 评分 + 回炉

```
用户点 rating
  → submitRating({ wordId, rating, planId? })
      BEGIN rw: states, reviewLogs, plans
        scheduleNext(state, rating, now)          // core 纯函数；写 stateBefore 快照
        states.put(newState)
        log.id = reviewLogs.add(log)（含 stateBefore）
        advancePlanAfterRating({planId, wordId, rating, reviewedAt, longTermUpdate})
        if requeue → appendRequeue({planId, wordId, gap:4/8})
        plans.put(plan) + meta.plan.updatedAt
      COMMIT
  → UI 用 getCurrentWordId(plan) 渲染下一词
  → 队列走完 → completePlan(planId)
```

### 4.3 回退/改判

```
点 < 或水平滑动 → 只移动 UI 指针到上一个已学词（读 plan.wordIds/ratings，不写库）
  用户点新 rating
    → getLastReviewSnapshot(wordId) 校验：今天/本 plan/最近一次/有 stateBefore，否则拒绝
    → undoLastRating({wordId, planId})
         BEGIN rw:
           states.put(log.stateBefore)（首评新词则 delete）
           reviewLogs.update(logId, { corrected: true })
           plan.ratings 对应项 corrected=true；plan.index 回退；删最近一次回炉插入；completedAt=null
         COMMIT
    → submitRating(新 rating)（新日志 correctedBy = 旧 logId）
  用户只看不改 → 直接返回，无写库
```

## 5. 任务拆分建议（对齐现有 task-24..31；以任务板为准）

> 依赖图：`task-24`（设置/设计稿）、`task-26`（core 契约）可并行；`task-25` 依赖 `task-26①`（Word.difficulty）；
> `task-27` 依赖 `task-26②`（predictAll）；`task-28`（plan 持久化）依赖 `task-24 + SPEC-v2`；
> `task-29`（撤销改判）依赖 `task-28`；`task-30`（UI 接线）依赖 `task-28/29/27`；`task-31`（QA）最后。

| 任务 | 内容 | 依赖 | 写范围 | 验收 |
|---|---|---|---|---|
| **task-24**（已有） | dailyGoal 1–9999 + DailyPlan 设计稿 | — | `src/data/settings.repo.ts`、`tests/data/settings.test.ts`、`docs/DATA-API.md`、`docs/DATA-PLAN-v2-design.md` | 边界单测；设计稿与 SPEC-v2 §3.4/§6 一致 |
| **task-26**（已有，已由 dev-algo 完成） | `Predict/WordPredicts/predictAll/isFirstShow`、首评候选 A、忘记不强制次日、pickQueue 不截断；格式化在 UI | — | `src/core/**`、`tests/core/**`、`docs/CORE-API.md` | AC1/AC2/AC3 单测 |
| **task-25**（已有） | 官方难度数据接入 deck + dataVersion 升级 | task-26① | `src/data/builtin/**`、`tests/data/builtin.test.ts`、`docs/DATA-API.md` | AC7 覆盖率/范围/已知词 |
| **task-27**（已有） | UI 三键官方格式/标签切换/学习量输入/两个官方设置项 | task-26② | `src/ui/study/**`、`src/ui/me/**`、`src/app/hooks/**`、`tests/ui/**`、`docs/UI-STUDY.md` | AC1 UI 逐字、AC6 |
| **task-28**（新增） | **Dexie v2 + `plans.repo.ts`**：`plans` 表、`getTodayPlan/saveTodayPlan/hasResumablePlan/advancePlanAfterRating/appendRequeue/completePlan/cleanupOldPlans`、`submitRating` 事务化、迁移包可选 `data.plans` | task-24、SPEC-v2 §6/§8 | `src/data/db.ts`、`plans.repo.ts`、`study.repo.ts`、`import-export.ts`、`schema.ts`、`tests/data/**`、`docs/DATA-API.md` | AC4/AC10 单测 + v1 fixture 迁移 |
| **task-29**（新增） | **撤销/改判数据层**：`ReviewLog.stateBefore` 写入、`undoLastRating`/`getLastReviewSnapshot`、`corrected` 过滤、统计口径排除 | task-28 | `src/data/plans.repo.ts`（扩展）、`src/data/study.repo.ts`、`src/data/stats.repo.ts`、`tests/data/**` | AC5 六条一致性 |
| **task-30**（新增） | **UI 接线**：首页 6 态/继续学习、plan 驱动会话与恢复、`<` 回退+水平滑动、改判提示 | task-28/29/27 | `src/ui/home/**`、`src/ui/study/**`（task-27 先合入同文件）、`tests/ui/**`、`docs/UI-STUDY.md` | AC4/AC5 手工步骤 + UI 单测 |
| **task-31**（新增，QA） | AC1–AC10 + 迁移 + APK 0.1.3 + E2E（见 §10） | 以上全部 | `docs/QA-v2.md`、`tests/e2e/**` | Lead 手机验收脚本 |

**进度（2026-11-11）**：task-24 ✅（dailyGoal 1–9999 + 设计稿）、task-26 ✅（v2 core，166 条）、
task-28 ✅（plans 表 + plans.repo，plans 18/18）、task-29 ✅（undo/reRate + 统计过滤，study.repo 15/15、import-export 15/15）；
task-25（官方难度）、task-27（UI 文案）进行中；**task-30 可开工**（dev-data API 已就绪）；task-31 待建。

**并发建议**：task-24 与 task-26 立即并行；task-25 等 `Word.difficulty` 类型落地；task-27 与 task-28 可并行；
task-30 必须在 task-27 与 task-29 之后（同文件 `src/ui/study/**` 串行）。

## 6. 兼容、版本与交付

| 项 | v2 方案 |
|---|---|
| Dexie | v1 → v2 自动迁移（只加字段/表）；**不支持降级**，发版说明提示先导出 |
| 词库 dataVersion | 与 schema 版本**无关**；task-25 升级 hongbaoshu=5/dagang=4（官方难度+已有词组），靠 `src/data/builtin/manifest.json` 重种 |
| 迁移包 | `MigrationFile.formatVersion` → **2**：新增可选 `plans`；v1 包仍可导入（缺 plans 视为无）；checksum 规则不变 |
| PWA | 无需改 `vite.config.ts`；SW `autoUpdate` 同旧流程；旧客户端打开新库会触发整页重载（提示见 RUN.md §4.1） |
| APK | 壳代码不改；重新 `pnpm build` → `build-apk.sh`（VERSION 建议 **0.1.3 / versionCode 4**）；WebView IndexedDB 同 origin，升级 APK 后自动迁移学习数据 |
| 数据安全 | 迁移前建议 data 层自动导出一次 `migration-<date>.json` 到 `/Download`（可选，需 Lead 拍板；不阻塞） |
| 关于页 | 更新算法表述（MM-5 交互复刻/数值逼近）、官方难度数据署名（Dataverse CC BY-NC 4.0） |

---

## 7. 风险与缓解

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | 「今日进度%」是推断模型，可能与官方有偏差 | 文案数值"像但不等" | 参数集中（`params.ts`）+ 设置 `memory.showPredictedInterval` 可退化为只显示间隔；文档明确标注 D |
| R2 | `is_first_show` 语义未官方确认 | 标签切换时点可能偏差 | `labelSwitch` 可配；默认 `firstEver`；用户实测后可一键切换 |
| R3 | 首评长间隔候选 A 的 K=100 是拟合 | 新词复习节奏偏差 | 参数化；候选 B（固定 60 天）可切换；上线后 A/B 校准 |
| R4 | plan 与状态一致性（事务/崩溃） | 队列/状态不一致 | 三写同事务；恢复时 `normalizePlan` 自愈（跳过不存在的 wordId、index clamp） |
| R5 | 撤销/改判引入统计重复 | 统计/热力图偏高 | 统计统一过滤 `corrected`；AC5 断言有效日志数不变 |
| R6 | 迁移丢数据 | 用户数据损失 | 只加不删 + fixture 测试 + 失败保留原库 + 支持导出备份 |
| R7 | 回炉无限增长（模糊一直不完成） | 队列异常长/性能 | `allowVagueComplete` 设置；回炉 count 上限（如 50 次/词/天）后强制视为认识并提示（可配置，需 Lead 确认） |

---

## 8. 验证计划（QA 可直接照做）

1. **单测**：core（AC1/2/3/8）、data（AC4/5/7/10：迁移 fixture、plan 事务、撤销一致性、难度覆盖）、ui（三键文本逐字）。
2. **集成/E2E**：学习 5 词退出→继续学习回到同位置；回退改判；due>goal 时队列全量；`memory.showPredictedInterval` 切换；
   `dailyGoal=9999`；跨天（mock 日期）重建。
3. **迁移**：真实 v1 备份库（QA 先用旧版造数据）→ 升级 → 对比 states/reviewLogs 行数与关键字段。
4. **手机/APK**：0.1.3 APK 覆盖安装 0.1.2 → 学习数据仍在 → 完成一轮（AC4 手势在真机）→ 回退改判。
5. **回归**：AC9 清单逐项（random 模式、记忆重开、含义拆分、词组、主题、导入导出、MaiMemo导入）。

---

## 9. 与 v1 ARCH 的差异摘要

- 新增 `plans` 表与 plan 驱动会话（v1 无持久化队列）；
- core 新增预测/进度/首评/首页态 5 组函数；
- data 新增 `plans.repo.ts`（约 10 个 API）；
- 三键文案从"UI 拼格式"改为"core 出 Predict + 纯函数格式化"；
- 设置从 15 项 → 20 项（3 项官方对齐 + 新词顺序 random 默认 + 每日复习上限）；
- 迁移策略从"无迁移（v1 重建）"变为"v1→v2 无损 upgrade"，并增加 fixture 测试要求。

---

*（本文结束。任务拆分如需调整由 Lead 在任务板落地；接口变更需同步 CORE-API/DATA-API 与 tests。）*

---

## 10. task-31 验收清单（QA 全量验收 · 迁移 · APK 0.1.3）

> 给 Lead 建 task-31 时直接引用。**资源纪律见 §10.4**（本机曾因并发 build/test 被系统 SIGKILL 5 次）。
> 产出：`docs/QA-v2.md`（通过/不通过表 + 复现步骤 + Bug 清单 + 手机验收脚本）、`tests/e2e/**` 新增断言。
> 前置：task-24/25/26/27/28/29/30 完成；Lead 已跑全量门禁（`pnpm test && pnpm build`）一次。

### 10.1 AC1–AC10 验收矩阵（逐条给出可测断言）

| AC | 验收内容 | 测试/步骤（自动化优先） | 通过标准 |
|---|---|---|---|
| **AC1** 三键文案状态机 | 三条真机端到端序列（face/cat/yellow）断言 UI 格式化（`next-hint.ts`，基于 `predictAll`）逐值一致 | `tests/core/preview.test.ts`；表格：`P=0.2→60/40/20`、`P=0.4→80/60/40`、`P=0.8→完成态+80/80`、新词 `79/3/1 天后·今日·今日`；`memory.showPredictedInterval=false` 只显示`今日`；`study.labelSwitch=false` 标签固定 | 全部断言通过；UI 上三键副标题 11px 不截断（375/360 宽） |
| **AC2** 新词首评间隔 | **K=80**，d=1/2/3/5/10 三支间隔 | `tests/core/schedule.test.ts` + `progress-v2.test.ts`：`firstFamiliarDays` = d1 **63**、d2 **44**、d3 **33**、d5 **21**、d10 **10**；`firstVagueDays`（K_v=100）= **3/2/2/2/1**；首评 forgot=1；容差 ±1 天；连续认识基准 `21→44→88→169→311→365`（h 141.08→…→3635.71） | 全部命中；认识首评 `dueAt ≠ 次日`（21 天）；首评忘记=1 天；非首评忘记按公式（不强制次日） |
| **AC3** 队列不硬截断 | `pickQueue` 三组边界 + reviewCap | `tests/core/queue.test.ts`：due=100/goal=30→review=100,new=0,total=100；due=10→10+20；due=0→0+30；**reviewCap=0 与旧行为一致**、cap>0 时按遗忘度截断且 `dueTotal` 保留全部到期 | reviewCap 默认 0；首页待复习=dueCount、backlog 可见 |
| **AC4** 续学一致性 | 真实数据层：学 5 词退出→重新进入 | `tests/data/plans.test.ts`：同队列/同顺序/同 index/同剩余/回炉位置一致；w-c 中断恢复 memoryCounts；跨天（mock `Date.now` 到次日）→ 旧 plan 丢弃、无副作用 | 单测 + 手工：首页按钮 fresh/ongoing/done/overdue 四态文案正确 |
| **AC5** 回退+改判 | 撤销/改判一致性 6 条 | `tests/data/undo.test.ts`：①撤销后同 rating 重提=从未评分（深比较）②撤销认识改忘记=忘记路径且回炉只有 1 条③多步浏览不撤销④跨天不可撤销⑤完成页撤销回 ongoing⑥回炉词二评后只撤最近一次 | 6 条全过；`reviewLogs.corrected=true`（`correctedBy` 关联新日志）且统计/曲线排除 |
| **AC6** 设置项与进度模型 | 20 项读写/持久化/生效 + `progressModelMode` | `tests/data/settings.test.ts` + 手工：三个 v2 设置项行为；`dailyGoal` 边界 1/30/200/9999 通过，0/-1/小数/NaN 拒绝；`progressModelMode` 默认 `v2-levels`，切 `v1-20pp` 可回滚且不破坏数据 | 重启后保持；学习页实时生效（次日建队类除外） |
| **AC7** 官方难度 d0 | 内置词库覆盖率与字段 | `tests/data/builtin.test.ts`：受限商业词表覆盖≥98%、大纲≥99%；难度∈[1,10]；dog/nose 与官方数据一致；未覆盖 fallback=5（`difficulty == null`） | 全部通过；dataVersion 升级后老数据重种保留进度 |
| **AC8** 同日回炉 | 同日第 2/3 次反馈 | `tests/core/schedule.test.ts`：同日 `longTermUpdate=false`、h/d/dueAt 不变；vague/forgot 每次 requeue；gap 4/8 可配 | 全部通过 |
| **AC9** v1 功能不回归 | 已实现事实清单 | E2E/手工：random 模式（每次点击重选未满 c、必收敛）、记忆按钮可重复重开、含义拆分（受限商业词表 28759 义项、embrace 3 个 c）、词组显示（默认关）、主题/安全区、导入导出往返、MaiMemo导入 mock、不熟悉度 clicks/encounters | 逐项通过，无 P0/P1 回归 |
| **AC10** 迁移与兼容 | v1 库升级 v2 + 迁移包 | `tests/data/migration.test.ts`（fake-indexeddb）：v1 fixture → 打开 v2 → 各表行数不变、新字段默认值正确、plans 空、meta.schemaVersion=2；二次打开幂等；坏行不崩溃（warning+保留） | 全部通过；迁移失败走「保留原库+提示导出」路径（mock 抛出） |

### 10.2 v1→v2 迁移专项（必测）

1. 用旧版（v1 代码或 fixture）造真实数据：≥2 个词库、≥200 条 states、≥500 条 reviewLogs、全部 15 项 settings；
2. 升级到 v2 后对比：`decks/words/states/reviewLogs/settings` 行数一致；`states.todayProgress=0`、
   `plans` 表存在且为空；`meta.schemaVersion=2`；旧日志读 `corrected=false`、旧 states 读 `todayProgress=0`；
3. 二次打开不重复 upgrade、不重复重种（内置词库 manifest 版本未变时）；
4. 迁移失败注入（如 QuotaExceeded）：UI 提示「数据升级失败，已保留原库，请先导出备份」，原库行数不变；
5. **不支持降级**：记录为已知限制（发版说明），QA 不测旧代码打开新库。

### 10.3 APK 0.1.3 覆盖安装专项（手机）

| 步骤 | 期望 |
|---|---|
| 1. 用 0.1.2 APK 学习 3-5 个词（造数据）→ 覆盖安装 0.1.3（同签名/versionCode 4） | 安装成功、**学习数据保留**（Dexie v1→v2 自动迁移） |
| 2. 打开 App 完成一轮：白板→注释→记忆→rating→下一词 | 无白屏、无 JS 报错；三键副文案按官方格式 |
| 3. 退出学习→首页显示「继续学习 · 还剩 N」→点入恢复同一词/位置 | AC4 通过 |
| 4. 顶栏 `<` 回退上一词→改判；首词无 `<`；水平滑动可回退 | AC5 通过（真机手势） |
| 5. 设置：`memory.showPredictedInterval` 开关、`dailyGoal=9999`、`study.labelSwitch` 切换 | 实时生效、重启保持 |
| 6. 断网打开 App 完成一轮 | 离线可用（资源在 APK 内） |
| 记录 | APK 路径/大小/sha256、badging（0.1.3/versionCode 4）、apksigner verify v1+v2+v3、APK 内 `assets/pwa/index.html` 与 dist 同哈希 |

### 10.4 E2E 需要新增的断言（`tests/e2e/**`，无头 Chromium）

1. 首页四态按钮文案：fresh=「开始学习」、ongoing=「继续学习」、done=「已完成」、overdue=「继续学习（还有 N 个到期复习）」；
2. 学习 5 词→退出→重新进入：顶栏进度与当前词与退出前一致（验证 plan 持久化）；
3. due>goal 场景（mock 数据构造 100 到期 + goal 30）：队列不截断（可前进 31 次仍不变完成）；
4. 三键副标题文本：抓 `.rating-hint` 文本，断言 `60%/40%/20%`、`80%/60%/40%`、`今日 / N 天后` 三形态；
5. `is_first_show` 标签：新词出现「不确定/不认识」，回炉后出现「模糊/忘记」；
6. 记忆按钮连续点两次：第二轮次数从 1 开始（回归 task-17）；
7. 回退：第 2 词点 `<` → 回到第 1 词注释面；首词 `<` 不可见/禁用；
8. 改判：回退后改点不同 rating → toast「已修改」，统计中有效日志数不变；
9. 设置切换 `memory.showPredictedInterval=false` 后三键只显示 `今日`/进度；`dailyGoal=9999` 输入框接受并持久化；
10. 跨天（`page.clock` 或 mock localStorage 日期）→ 首页回到 fresh/新 plan；
11. 回归：含义拆分（embrace 至少 3 个 c）、词组开关（默认关时不占位）、深色模式无白底残留；
12. 无 JS console error（整轮流程）。

### 10.5 资源纪律（QA 必须遵守，来自 DECISIONS §九 R1–R7）

- **同一时刻全项目只允许 1 个重命令**（build / 全量 test）；
- QA 自己只跑 `npx vitest run <file> --pool=forks --poolOptions.forks.maxForks=1`（单文件单 fork）；
- **全量门禁 `pnpm test && pnpm build` 只在 Lead 收尾时跑一次**；QA 需要 build 时先向 Lead 申请并确认无人并发；
- `pnpm build` 期间可先 `bash scripts/stop.sh`，build 完再 `start.sh`（服务很轻，但会占用 IO）；
- 不在测试期间同时跑 Chromium E2E + build；手机高温/其他任务时优先写文档；
- 每次跑重命令后在 `docs/QA-v2.md` 记录：命令、耗时、内存可用值、是否被系统杀（code 137）。

### 10.6 报告与判定

- `docs/QA-v2.md` 结构：AC1–AC10 通过表（✅/❌/⚠️ + 证据）、迁移专项表、APK 专项表、Bug 清单（P0/P1/P2 + 复现步骤 + 期望/实际）、手机验收脚本（逐步照做）、残留风险。
- **通过标准**：AC1–AC10 全过；无 P0/P1 Bug；P2 可带条件通过（记录）；
- 完成后 `send_message` 给 Lead：通过率、阻塞级 Bug、APK 路径/sha256、手机验收脚本链接。

---

## 11. 与 `docs/DATA-PLAN-v2-design.md` 的对齐记录（2026-11-11，dev-data ↔ arch）

dev-data 的设计稿（298 行）与本文/SPEC-v2 已对齐，**实现按设计稿 API 命名执行**。确认项：

| # | 设计稿问题 | 决定 | 依据 |
|---|---|---|---|
| 1 | `wordIds` 是否允许同一 wordId 重复（回炉） | **允许**：回炉 = 同一 wordId 再次插入较后位置，`sources[id]='requeue'`；`index` 按出现次数推进 | 更贴近官方"当天再次出现"的时间轴；实现更直接（dev-data 推荐） |
| 2 | 回退改判范围 | **仅"今天 + 本 plan + 最近一次"**；首词不可回退；跨天不可撤销；更早提示不可改 | 官方未公开改判，最小可验证扩展（05 §5.3） |
| 3 | 迁移包是否带 plan | **带**，只带导出当天、同日才恢复（`replace` 覆盖 / `merge` 保留本机 + warning）；`formatVersion` 保持 **1** | Lead 拍板 #4；只加可选字段向后兼容 |
| 4 | 旧 plan 保留天数 | **7 天**（`cleanupOldPlans({keepDays:7})`） | 设计稿推荐；为后续"今日/历史回顾"留数据 |
| 5 | 设置项命名 | 以代码为准：`study.labelSwitch`(bool) / `memory.showPredictedInterval`(bool) / `study.allowVagueComplete`(bool)；早期草案 `study.labelStyle`/`study.showIntervalHint` 废弃 | dev-algo/dev-data 已落地并测试 |
| 6 | plan 主键 | `id = \`${'${'}date}:${'${'}deckId}\``（一天一词库一行，支持一天切多词库） | 设计稿 §2；SPEC-v2 §3.4/§8 已同步 |
| 7 | Dexie 迁移 | **无 `.upgrade()`**：只新增 plans 表 + 可选字段；`SCHEMA_VERSION=2` | 设计稿 §1；本文 §2.2 |
| 8 | 降级 | **不支持**（Dexie `VersionError`）；设计稿"旧客户端可忽略新表"的说法**已更正** | 本文 §2.2；发版说明须提示先导出 |
| 9 | 撤销实现 | 以 `ReviewLog.stateBefore` 整对象恢复 + `corrected/correctedBy` 标记（不删日志）；恢复后重评 == 只评一次的路径（同一 `now` 下深比较） | §3.2/§4.3；AC5 |
| 10 | w-c 次数 | 权威仍是 `meta:session:<wordId>`；`plan.wcCounts` 仅导出冗余 | 设计稿 §4.3；D15 |
| 11 | **dev-algo 实现同步（task-26）** | `Predict{first,days,progress}` + `WordPredicts = Record<Rating,Predict>` + `predictAll/isFirstShow`（无 core 格式化函数，格式化在 UI）；`forceNextDayOnForgot=false`（忘记不再强制次日）；新基准（K=100 时期）`27→55→109→206→365`；**K=80 后更新为 `21→44→88→169→311→365`（见 #14）**；`dailyGoal 1–9999` | dev-algo task-26 + `tests/core` 151 条 |
| 12 | **QA 待同步** | `tests/e2e/algo-independent.test.ts` 仍引用旧基准 JSON（`reference.familiarSequence`、forgot 强制 1 天），需 QA 更新为新基准/新规则 | 本表 #11；task-31 执行 |
| 13 | **dev-data task-28/29 完成（2026-11-11）** | 实际文件 `src/data/plans.repo.ts` + `plan.types.ts`（re-export core + `LastReviewSnapshot/HomeStudyData`）；plans 主键/无 upgrade/同事务三写/undo 边界/迁移包含同日 plan/keepDays=7 逐条落地；统计过滤 `corrected`（兼容 `reverted` 别名）；测试 plans 18/18、study.repo 15/15、import-export 15/15 | dev-data 汇报 + 本表 #11/#12 |
| 14 | **dev-algo K=80 + 进度 v2 骨架（2026-11-11）** | `firstIntervalK` 100→80：首评 d1→63、d2→44、d3→33、d5→21、d10→10（与 Lead 消息 d5=22/d10=12 有 1–2 天差异，以公式/测试为准）；连续认识 `21→44→88→169→311→365`；新增默认关闭的 `progressModelMode='v2-levels'` 档位骨架（`progressLevels/OnVague/OnForget/OnFamiliar/InitialLevel/canFinishMode` + `ProgressLevel` + `WordState.todayProgressLevel?/canFinishToday?`），证据 D 级、不影响 v1 行为 | `tests/core/progress-v2.test.ts`（18 条）+ `tests/core/schedule.test.ts`；SPEC-v2 §1.4/§4.1/§4.2 |
| 15 | **进度模型升级为 5 档状态机并默认（2026-11-11 11:2x）** | `progressModelMode` 默认 `'v2-levels'`；5 档 L1a/L1b/L2/L3/L4（带 `name`）、显式转移表（`LevelTransition{to,inferred}`）、`canFinishMode='table'`、`progressInitialLevelVague/Forget`；`WordState.todayProgressLevel?/canFinishToday?`；face/cat/yellow 三条真机端到端序列进 `tests/core/progress-v2.test.ts`；`v1-20pp` 保留回滚。**命名已最终确定（无需拍板）**：`'v2-levels'` + 数字 level 1..5 + `name:'L1a'…`；research 04 §15.7 已确认以 `'v2-levels'` 为准，不加别名/不改名 | Lead 实机验证 + dev-algo 实现 + SPEC-v2 §1.3/§12.1 |
| 16 | **首评模糊常数解耦（2026-11-11 Lead 最后拍板）** | 新增 `firstVagueIntervalK=100`（与认识 `firstIntervalK=80` 解耦）：`firstVagueHalfLife(d)=stabilityAfterForget(d, K_v*h0(d), 0.9)`，`firstVagueDays` clamp 1–7；基准更新为 **3/2/2/2/1**（d=1 官方实测 3 天；Lead 口述 d5→1，公式精确值 2）；认识/连续认识/5 档状态机均不变 | dev-algo 实现 + `tests/core/progress-v2.test.ts` 锁定 |

> 遗留：设计稿 §7 提出的 4 个问题已全部有结论（见上表 #1–#4）；task-24 的设计稿可作为 task-28/29 的直接实现依据。
