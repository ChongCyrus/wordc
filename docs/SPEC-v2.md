# SPEC v2 · 官方口径定稿（实现唯一依据）

> 状态：**定稿**（task-23，2026-11-11）。优先级：**DECISIONS.md > 本文 > SPEC v1 > research**。
> 读者：dev-algo（core）、dev-data（data）、dev-ui（ui/app）、QA。
> 本文取代 `docs/SPEC.md` 的算法/交互/队列/设置相关章节；**v1 文档保留作对照**，差异见 §12。
> 配套架构文档：`docs/ARCH-v2.md`（Dexie v2 迁移、模块变更、任务拆分）。
> 证据基础：`docs/research/04-official-scheduling.md`（官方前端代码级）、`05-official-interaction.md`、
> 以及 01/02/03 三份研究。证据等级沿用 research：★前端代码 / 官方文档 / 截图推断 / 推断（D）。

---

## 0. 总原则：MM-5 下「交互精确复刻、数值同源逼近」

**官方 App 自 2025-08 起已升级 MM-5**（官方更新日志：HarmonyOS V5.5.02.0028「记忆算法升级至 MM-5 (Beta)」，
2025-09/2026-09 多次迭代；memodocs 的《MM 更新日志》页仍写 MM-5 Coming soon，**已过时**）。
MM-5 的间隔/进度由服务端计算，未公开任何内部参数。

因此本文的验收口径固定为（与 D11 一致，替换「逐词与官方一致」的说法）：

| 层 | 口径 | 验收方式 |
|---|---|---|
| 三键文案状态机（N天后 / 今日·N天后 / 今日进度X% / 标签切换） | **精确复刻官方前端逻辑**（逐字规则见 §2） | 用 5 张官方截图逐值复现（AC1） |
| 当天首评决定长期、同日反馈只影响当日 | **精确复刻**（help30 原文） | 单测（AC8） |
| 「今日进度%」的进度值 | 官方服务端计算，**只能逼近**：本文给 20pp 步进模型（推断 D），可逐值复现 5 张截图 | AC1 数值表 |
| 长期间隔天数（days） | 官方 MM-5 数值**不可得**：用公开 DHP 族公式 + 官方难度数据逼近 | AC2 基准表（±1 天） |
| 词难度 d0 | 官方公开难度数据（Dataverse 17,043 词，覆盖率 99%） | AC7 |

**禁止**在任何文档/UI/汇报中声称「与MaiMemo App 逐词复习时间一致」；统一表述为
「**同源 MM/DHP 调度 + 官方公开难度数据；交互文案按官方前端规则复刻**」。

---

## 1. 官方交互规则（必须实现的 / 明确不做的）

### 1.1 三键与副标题（官方前端代码★，逐字）

官方 Web 版（`tc-apis.maimemo.com/webstudy/app`）前端原文逻辑：

```ts
// 数据来自服务端 response_predicts[3]，顺序固定 [认识, 模糊/不确定, 忘记/不认识]
const fmt = (p) => p.progress >= 1
  ? `${p.days} 天后`
  : p.first
    ? `今日 / ${p.days} 天后`
    : `今日进度${Math.round(100 * p.progress)}%`;

// 主标签
familiar.label = '认识';
vague.label   = word.is_first_show ? '不确定' : '模糊';
forget.label  = word.is_first_show ? '不认识' : '忘记';
```

- **优先级**：`progress >= 1` > `first` > 百分比（三态互斥）。
- `first=true` 且 `progress<1` → `今日 / N 天后`（"今日"= 今天还会再出现）。
- `is_first_show` 语义：本文采用「**该词首次显示（=新词第一次学习）**」，即 `firstSeenAt == null`；
  做成 `params.labelSwitch: 'firstEver' | 'firstToday'`，**默认 `firstEver`**（证据 04 §3.5；残余风险已标注）。
- 主标签切换：设置项 `study.labelSwitch: boolean`，默认 **true**（true = 官方风格：首现「认识/不确定/不认识」，
  之后「认识/模糊/忘记」；false = legacy 风格：固定「认识/模糊/不认识」）。语义键 `isFirstShow` 由 core 派生；
  core 参数 `params.labelSwitch: 'firstEver' | 'firstToday'`（默认 **firstEver**）决定「首现」的精确语义。
- 设置项 `memory.showPredictedInterval`（官方「预计复习间隔 显示/隐藏」，默认 **true = 显示**；
  本文早期草案名为 `study.showIntervalHint`，以代码为准）：
  - 显示：按上述三态格式；
  - 隐藏：`progress>=1` 与 `first` 分支都只显示 `今日`（不显示天数），回炉阶段仍显示 `今日进度X%`；
  - 该开关只影响副标题，不影响调度。

### 1.2 完整状态机表（展开）

记 `isFirstEver`=新词从未学过；`isFirstToday`=该词当天还没有反馈；`P`=该词当日进度（§3）。

| # | 场景 | 主标签 | 认识副标题 | 第二键副标题 | 第三键副标题 |
|---|---|---|---|---|---|
| A | 新词首次学习（isFirstEver） | 认识/不确定/不认识 | `{firstFamiliarDays(d)} 天后` | `今日 / {firstVagueDays(d)} 天后` | `今日 / 1 天后` |
| B | 已学词跨天首次出现（!isFirstEver && isFirstToday） | 认识/模糊/忘记 | `{interval} 天后` | `今日 / {vagueInterval} 天后` | `今日 / {forgotInterval} 天后`（按公式，常见 1–2 天） |
| C | 同日回炉（!isFirstToday） | 认识/模糊/忘记 | P+0.4≥1 → `{nextIntervalDays} 天后`；否则 `今日进度{round((P+0.4)*100)}%` | 模糊：`min(0.8,P+0.2)` → `今日进度X%` | `今日进度{round(min(0.8,P)*100)}%` |
| D | 今日/历史回顾（v2 不做入口） | — | 不更新长期，不显示预测 | — | — |

> B 行第三键：官方截图样本为 `1 天后`；task-26 起**不再强制次日**，按 DHP 公式计算
> （`params.forceNextDayOnForgot=false`；首评新词忘记仍固定 `firstForgetDays=1`）。详见 §4.2。
> C 行「认识可完成当日」：`P + STEP_FAMILIAR >= 1` → 显示已固定的 `nextIntervalDays 天后`（官方 04 截图）。
> C 行第二键在 `allowVagueComplete=true` 时允许 `P+0.2>=1` → 显示 `{nextIntervalDays} 天后`（我们的设置扩展）。

### 1.3 「今日进度」：5 档状态机（**默认启用**；v1 20pp 保留回滚）

官方服务端不公开公式；Lead 2026-11-11 用官方 App 真机受控采样（face/cat/yellow 三词端到端 + 6 张截图）
交叉验证出一套 **5 档状态机**，已设为**默认**（`params.progressModelMode='v2-levels'`；`'v1-20pp'` 保留 A/B 与回滚）。
语义：每个词当天维护档位 `WordState.todayProgressLevel ∈ 1..5`（名称 L1a/L1b/L2/L3/L4），
三键副标题 = 档位表对应投影；同日评分按转移表切换到新档位。

**档位表（V=点模糊后显示、W=点忘记后显示、F=点认识后显示）**

| level | 名称 | V（模糊） | W（忘记） | F（认识） |
|---|---|---|---|---|
| 1 | L1a（首评「不确定」入口） | 0.6 | 0.2 | 0.8 |
| 2 | L1b（首评「不认识」入口） | 0.4 | 0.2 | 0.6 |
| 3 | L2 | 0.6 | 0.4 | `days`（完成当日） |
| 4 | L3 | 0.8 | 0.6 | `days`（完成当日） |
| 5 | L4 | 0.8 | 0.8 | `days`（完成当日） |

**首评入口**
- 首评「不确定/模糊」→ 档位 **L1a(1)**；首评「不认识/忘记」→ **L1b(2)**；首评「认识」→ 直接完成当日（`progress=1`）。

**同日转移表**（`to` = 提交后档位；`'complete'` = 完成当日；`inferred=true` = 未实测外推）

| 反馈 | 转移 |
|---|---|
| 模糊 | L1a→L2、L2→L3、L3→L3、L4→L3；**L1b→L1a（inferred）** |
| 忘记 | L2→L1a、L3→L2；**L1a→L1b、L1b→L1b、L4→L2（inferred）** |
| 认识 | L1a→L3、L1b→L2、L2→complete、L3→complete、L4→complete（**L4→complete inferred**） |

**完成判定**：`canFinishMode='table'`（默认）——「认识」是否完成当日，取决于档位表 `F` 列（L2+ 为 `days` ⇔ 完成）；
可选 `always / never / level>=3 / afterFirstFail` 作 A/B。
**N（`N 天后`）**：直接复用 `state.nextIntervalDays`（首评已算出的长间隔，不另算）。

**端到端基准（`tests/core/progress-v2.test.ts` 锁定；AC1）**

| 词 | 序列（三键显示 → 提交 → 新显示） |
|---|---|
| face | 首评不认识→`60/40/20` → 认识→`N天后/60/40` → 认识→**完成** |
| cat | 首评不确定→`80/60/20` → 模糊→`60/40` → 模糊→`80/60` → 模糊→`80/60` → 忘记→`60/40` → 忘记→`80/60/20` → 认识→`80/60`（含 N天后） → 认识→**完成** |
| yellow | 首评不确定→`80/60/20` → 模糊→`60/40` → 模糊→`80/60` → 模糊→`80/60` → 忘记→`60/40` → 认识→**完成** |

- **证据等级**：三词端到端序列为官方实机观测（B）；档位 V/W/F 由观测 + research 04 §15.6 推出（B/D）；
  未观测转移标 `inferred`（D）；**服务端真实公式仍未知** → 文档口径为「近似实现」，不声称逐值一致。
- **v1 回滚**：`progressModelMode='v1-20pp'` 保留旧 20pp 模型（首评失败基准 20%、认识 +40/+20/+0、失败封顶 80%）；
  `WordState.todayProgress`（标量）仅 v1/兼容存储，v2 用 `todayProgressLevel`。

## 2. 三键预测 v2 接口（core 契约，**以 dev-algo 实现为准**）

官方 Web 协议结构（`Predict{first,days,progress}`），已在 `src/core/schedule.ts` 落地；`src/core/plan.ts`
提供 plan/首页纯函数。

```ts
/** 与官方 Web 协议 `Predict` 同名同义 */
export interface Predict {
  first: boolean      // 是否属于「今日首评」场景 → 副标题 `今日 / N 天后`
  days: number        // 该反馈后的长期间隔（天）
  progress: number    // 该反馈后的当日复习进度 0..1（>=1 = 完成当日）
}

/** 三键预测：按 Rating 记录（认识/模糊/忘记），不是数组 */
export type WordPredicts = Record<Rating, Predict>

export function predictAll(state: WordState, now: number, params?: Partial<AlgoParams>): WordPredicts
export function isFirstShow(state: WordState, params?: Partial<AlgoParams>, now?: number): boolean
//   - 默认（firstEver）只需 state；firstToday 分支需显式 now（保持纯函数）

// v1 兼容（v2 升级字段）：
export interface NextPreview {
  longTermDays: number
  todayRequeue: 'requeue-forgot' | 'requeue-vague' | 'none'   // v2：由 boolean 升级为枚举
  first?: boolean; todayProgress?: number; completesToday?: boolean
}
export function previewNext(rating: Rating, state: WordState, now: number, params?: Partial<AlgoParams>): NextPreview

// plan / 首页（src/core/plan.ts）
export function deriveHomeState(input: HomeStateInput): HomeStudyState   // 6 态，SPEC §6.2
export function getCurrentWordId(plan: DailyPlan): string | null
```

- `ScheduleResult` 新增 **`completesToday: boolean`**（首评认识=true；同日认识且 `P+0.4>=1`；模糊仅在
  `allowVagueComplete=true` 时可达；忘记恒 false）；其余字段 `{ state, log, longTermUpdate, requeue }` 保持。
- **格式化不在 core**：官方三态规则（`progress>=1 → "{days} 天后"`；`first → "今日 / {days} 天后"`；
  否则 `"今日进度{round(100×p)}%"`）由 UI 实现（`src/ui/study/lib/next-hint.ts`）；
  `study.labelSwitch` 控制 `ratingLabels()`（`src/ui/study/lib/rating-labels.ts`）。core 只出数据。
- 首评（新词）：`familiar/vague/forgot` 用候选 A 的 `firstFamiliarDays / firstVagueDays / firstForgetDays`；
  同日回炉：`days` 保持已固定的长期间隔，`progress` 按 20pp 模型投影（§1.3）。

## 3. 数据模型 v2（在 v1 基础上增量）

### 3.1 `Word` 增量

```ts
export interface Word {
  // ...v1 字段不变
  /** 官方公开难度数据（Dataverse，d∈[1,10]）；未命中为 undefined */
  difficulty?: number
}
```

- 来源：`docs/research/assets/official-word-difficulty.tsv`（17,043 词，CC BY-NC 4.0）、
  `d0-mapping-kaoyan.tsv`（受限商业词表 98.9% / 大纲 99.5% 命中）。
- 未命中兜底：`difficulty = 5`；**不新增 `difficultyEstimated` 字段**，用 `word.difficulty == null` 判断是否估算
  （避免 schema 膨胀；如需展示可派生）。不再用词频回归（MAE≈1.78 级，无收益）。

### 3.2 `WordState` 增量（与已实现代码一致，**可选字段**）

```ts
export interface WordState {
  // ...v1 字段全部保留
  /** 当日复习进度 0–1（§1.3）；缺失按 0 处理 */
  todayProgress?: number
  /** todayProgress 所属本地日期 key；与今天不同则按 0 处理（与 sameDayDate 同口径） */
  todayProgressDate?: string
  /** v2：5 档状态机当前档位（1..5 = L1a/L1b/L2/L3/L4；v2 默认启用，缺失按首评入口档位派生） */
  todayProgressLevel?: number
  /** v2：当前「认识」是否会完成当日（缺失按 canFinishMode='table' 派生） */
  canFinishToday?: boolean
}
```

- 字段实现为**可选**：未写入时读取按 0 / 空串处理，旧数据无需迁移即可工作；
  但**每次评分后必须写入**（`todayProgressDate` = 当天本地日期 key）。
- `isFirstShow` 不存字段：由 `firstSeenAt == null` 派生（`is_first_show` 语义，`study.labelSwitch` 控制显示风格）。
- 回退/改判依赖**整对象快照**（§7），因此 WordState 必须可 JSON 深拷贝（无函数/无 Date 实例）。

### 3.3 `ReviewLog` 增量（回退/改判用，**只加可选字段**）

```ts
export interface ReviewLog {
  // ...v1 字段全部保留
  /** v2：评分前的完整 WordState 快照（撤销/改判的唯一依据；旧日志为 undefined；
   *  首评新词为 null → 撤销时删除该 state，而不是恢复） */
  stateBefore?: WordState | null
  /** v2：该条日志是否已被改判撤销（统计/遗忘曲线必须排除 corrected === true） */
  corrected?: boolean
  /** v2：撤销后重新评分的新日志 id（可追溯） */
  correctedBy?: number
}
```

- 只加**可选字段**：旧日志/旧迁移包缺字段 → `corrected` 视为 false，`stateBefore` 缺失则该词不可撤销（UI 禁用）。
- **兼容别名（task-29 实现）**：撤销时同时写 `corrected: true`（canonical）与 `reverted: true`（早期命名，兼容旧导出/QA）；
  读取方过滤 `corrected === true || reverted === true`。新代码以 `corrected` 为准，后续可移除 `reverted`。
- `MigratioFile.formatVersion` 保持 **1**（可选字段向后兼容，见 §6.5）。
- **不新增 `planDate`**：统计按 `reviewedAt` 推导本地日期即可（`localDateKey(reviewedAt)`）。

### 3.4 `DailyPlan`（v2 新增，与 `docs/DATA-PLAN-v2-design.md` 对齐）

```ts
export type PlanWordSource = 'goal' | 'extra' | 'requeue'

export interface PlanRating {
  wordId: string
  rating: Rating
  reviewedAt: number
  /** 该次反馈是否更新了长期状态（与 ReviewLog.longTermUpdate 一致） */
  longTermUpdate: boolean
  /** 是否已被「回退改判」撤销 */
  corrected?: boolean
  /** 撤销后重新评分的日志 id */
  correctedBy?: number
}

export interface DailyPlan {
  /** 主键 = `${date}:${deckId}`（一天一词库一份；一天内切词库会有多条） */
  id: string
  /** 本地日期 'YYYY-MM-DD'（跨天失效） */
  date: string
  deckId: string
  /** 有序词 id 列表；当日回炉 = 同一 wordId 再次插入到较后位置（**允许重复**） */
  wordIds: string[]
  /** 当前学习到第几个（0 起；= 已处理次数，含回炉重复） */
  index: number
  /** 每个词的来源（调试/统计/续学提示；重复回炉时记最后一次） */
  sources: Record<string, PlanWordSource>
  /** 建队时的目标快照（之后改设置不影响今日已建队列，次日生效） */
  goals: {
    dailyGoal: number
    dueCount: number
    newBudget: number
    extraCount: number
  }
  /** 已提交评分（按时间顺序；撤销标记 corrected，**不删除**） */
  ratings: PlanRating[]
  /** 可选：w-c 次数冗余（权威仍是 `meta:session:<wordId>`，见 §6.3；导出迁移包时需要） */
  wcCounts?: Record<string, Record<string, number>>
  createdAt: number
  updatedAt: number
  /** 完成时间（队列走完且评分全部提交）；未完成 null */
  completedAt: number | null
}
```

**与本文早期草案的字段映射**（实现按本表，不再有 queue/requeue/history 分离结构）：

| 早期草案 | 现行实现（DATA-PLAN-v2-design.md） |
|---|---|
| `queue: PlanItem[]` | `wordIds: string[]` + `sources{}` |
| `requeue: PlanRequeue[]` | 回炉直接重复插入 `wordIds`（允许同一 id 多次）+ `sources[id]='requeue'` |
| `doneWordIds` | `ratings[]` 中 `corrected !== true` 的词 |
| `history: RatingRecord[]` | `ratings[]`；撤销依据放在 `reviewLogs.stateBefore`（§3.3） |
| `activeWordId/activeStage/memoryCounts` | `meta:plan.activeId`（指向 plan.id）+ 既有 `meta:session:<wordId>`（D15） |
| `overdueLeft` | 运行时用 `countDue()` / `states` 计算，**不写入 plan** |

**meta 约定（v2 新增）**：

| key | value | 用途 |
|---|---|---|
| `plan.activeId` | `${date}:${deckId}` | 当前「继续学习」入口指向的 plan |
| `plan.updatedAt` | epoch ms | 首页快速判断是否有可续学 plan（不必查 plans 全表） |
| `schemaVersion` | `2` | 结构版本 |

**不变量**：① 同一 deck 同时最多一个 `completedAt === null` 的 plan；② `index` 单调不减（改判临时回退、改完恢复）；
③ `ratings` 与有效 `reviewLogs` 一一对应（撤销后旧日志 `corrected=true`、新日志 `correctedBy` 关联）。

### 3.5 设置项 v2（v1 的 15 项 + 新增 5 项 = **20 项**，与已实现代码一致）

| key | 类型 | 默认 | 范围/枚举 | 说明 |
|---|---|---|---|---|
| `study.dailyGoal` | number | 30 | **1–9999 整数（strict：越界/小数/NaN 直接拒绝，不 clamp）** | 任意正整数（task-24 已实现） |
| `study.labelSwitch` | boolean | **true** | — | 官方 `is_first_show` 标签切换：true=首现「不确定/不认识」、之后「模糊/忘记」；false=固定「模糊/不认识」 |
| `memory.showPredictedInterval` | boolean | **true** | — | 官方「预计复习间隔」显示/隐藏（只影响副标题格式；即本文 §1 的 showIntervalHint 语义） |
| `study.allowVagueComplete` | boolean | **false** | — | 官方「允许模糊完成复习」；false=模糊持续回炉到认识（进度封顶 80%） |
| **`study.newWordOrder`** | `'order'` \| `'random'` | **`'random'`**（用户拍板） | 二选一，非法值回退 random | 新词顺序：词库顺序 / 随机乱序。**当天计划建队后顺序固定**（plan 稳定种子 `fnv1a32(planId#wordId)`，非 Fisher-Yates）；改学习量保持同一序列前缀（30→50 不变），次日/新计划生效 |
| **`memory.showPhrases`** | boolean | **true**（用户要求，覆盖 v1 的 false/D47） | — | w-c 页词组显示；仍只显示当前 c 且 `meaningId` 有归属的词组，注释面显示全部 |
| **`study.dailyReviewCap`** | number | **0** | **0–9999 整数**（strict；0=不限） | 每日复习上限：建 plan 时按遗忘程度排序取前 cap 个入队，其余顺延；`DailyQueue.dueTotal` 保留全部到期数（首页可显示 backlog），新学预算 = max(0, goal−实际入队复习数)；cap 在**建 plan 时快照**到 `meta:plan.reviewCap`，改设置不影响当天已有 plan、次日生效；cap=0 与旧行为一致 |
> **队列口径（task-51，务必区分）**：`pickQueue()` 返回的 `dueCount` = **今日实际入队复习数**（受 `reviewCap` 限制）；
> `dueTotal` = **全部到期数**（必填字段，新增）；`HomeStudyData.dueCount` 仍 = **全部到期**（数据层单独统计），
> 积压量用 `reviewBacklog`；首页「待复习」KPI 用全部到期，`/today` 复习分区用入队数（`breakdown.review.planned`）。

> 命名以**已实现代码**为准（`src/core/types.ts` 的 `SettingsMap`、`src/data/settings.repo.ts` 的默认值/校验）。
> 本文早期草案中的 `study.showIntervalHint`、`study.labelStyle` 已废弃，**勿使用**。
> 所有设置改动实时生效；`study.dailyGoal` 只影响**次日**建队（今日 plan 的 goals 是快照）。
> **与 core 参数的关系**：`study.labelSwitch` 控制 UI 文案风格，`params.labelSwitch`（默认 `firstEver`）控制语义；
> `study.allowVagueComplete` 运行时注入 `params.allowVagueComplete`（默认 false）；
> `memory.showPredictedInterval` 只影响 UI 格式化（`showInterval`），不进入调度参数。

## 4. 调度规则 v2（间隔）

### 4.1 新词首评（用户 P0 问题：不能「所有词第二天复习」）

官方截图锚点：新词点「认识」的官方实机样本为 **56/62/78 天（同难度分散，无法逐词复刻）**；
「模糊」= 今日·2~3 天；「不认识」= 今日·1 天。我们采用 **候选 A**（K 由研究 6 样本拟合，参数化）：

```
h0(d) = -1 / log2(max(0.925 - 0.05*d, 0.025))        // 官方 TKDE 公式
K   = params.firstIntervalK = 80                      // 首评「认识」常数（Lead 指示 100 → 80）
K_v = params.firstVagueIntervalK = 100                // 首评「模糊」常数（与认识**解耦**，Lead 最后拍板）
firstFamiliarDays(d) = clamp(round(-K*h0(d)*log2(0.9)), firstFamiliarMin=7, firstFamiliarMax=90)
firstVagueHalfLife(d) = stabilityAfterForget(d, K_v*h0(d), 0.9)
firstVagueDays(d)     = clamp(round(-firstVagueHalfLife(d)*log2(0.9)), firstVagueMin=1, firstVagueMax=7)
firstForgetDays       = params.firstForgetDays = 1
```

> 参数名以实现为准：`firstIntervalK / firstVagueIntervalK / firstFamiliarMin / firstFamiliarMax /
> firstVagueMin / firstVagueMax / firstForgetDays`；进度模型见 §1.3（v2 5 档默认，`v1-20pp` 可回滚）。

基准（**AC2 必须锁定**，容差 ±1 天，K=80 精确值）：

| d | firstFamiliarDays | firstVagueDays | firstForgetDays |
|---|---|---|---|
| 1 | **63**（官方 56/62/78 分散） | **3**（官方 3/3/2） | 1 |
| 2 | **44** | 2 | 1 |
| 3 | **33** | 2 | 1 |
| 5 | **21** | 2 | 1 |
| 10 | **10** | 1 | 1 |

- 官方实机同难度首评实测 56/62/78 天（分散）→ **无法逐词复刻**；K=80 时 d=1=63 落在中部（MAE≈9.5 天）。
- **模糊基准已解耦**（Lead 最后拍板）：`firstVagueIntervalK=100` 独立于认识的 `firstIntervalK=80`；
  精确值 **3/2/2/2/1**（此前与 K 耦合的 2/2/2/1/1 作废）。⚠️ 口径备注：Lead 口述 d=5→1，
  但按 `K_v=100` 公式精确值为 **2**（`tests/core/progress-v2.test.ts` 锁定，±1 容差内）。
  ⚠️ 口径备注：Lead 消息里写 d=5→22、d=10→12；按公式 `clamp(round(-K*h0*log2(0.9)),7,90)` 的精确值是
  **21 / 10**（`tests/core/progress-v2.test.ts` 已锁定），本文以实现精确值为准。
- 首评 `familiar`：`h = K*h0(d)`、`dueAt = today + firstFamiliarDays(d)`、`todayProgress = 1`；
- 首评 `vague`：`h = K*h0(d)` 再走答错公式得到 `h'`、`dueAt = today + firstVagueDays(d)`、`todayProgress = 0.2`、回炉；
- 首评 `forgot`：`h` 同 vague 路径、`difficulty = min(d+2,18)`、`dueAt = 明天`、`todayProgress = 0.2`、回炉；
- `phase`：首评后认识 → `review`；模糊/不认识 → `learning`（与 v1 一致）。

> 证据等级：公式为 D（拟合），官方实机样本为 B；Lead 已拍板采用候选 A 且 K=80；参数化便于后续校准。

### 4.2 非首评（真正的复习日）

沿用 v1 的 DHP 公式（SPEC v1 §3.3–3.6）：`p = 2^(-Δt/h)` → 认识用答对公式、模糊/不认识用答错公式
（模糊难度不变，不认识难度 +2）→ 阈值法 `interval = clamp(round(-h·log2(0.9)),1,365)`。
**不认识不再强制次日**（task-26 起）：按公式重算，常见 1–7 天；`params.forceNextDayOnForgot` 默认 **false**
（仅 A/B 开关，置 true 恢复旧行为）。

**新基准（K=80，task-26 实现并单测锁定，d0=5、一直「认识」）**：

| 次序 | 说明 | 间隔（天） |
|---|---|---|
| 1（新词首评认识） | 候选 A（K=80）：`K·h0(5)=141.08` | **21** |
| 2 | 复习日首评 | 44 |
| 3 | | 88 |
| 4 | | 169 |
| 5 | | 311 |
| 6+ | 封顶 | 365（之后保持 365） |

> 对应 h（单测锁定）：`141.08 → 292.27 → 580.80 → 1109.40 → 2044.04 → 3635.71`（第 6 次起 clamp 4096）。

> 旧 v1 基准 `1→2→5→11→24→50→99→188→344→365` 是「首评 bug（一律 1 天）」的产物，**已废弃**。
> QA 的独立复算脚本 `tests/e2e/algo-independent.test.ts` 中 `reference.familiarSequence` 与
> 「forgot 强制 1 天」参考值需同步更新（见 ARCH-v2 §11 #12）。
>
> **官方截图交叉验证**（04 §6.4）：78 天 → 反推 h≈513，再用答错公式得模糊 3 天；56 天 → 2 天，
> 两组精确命中 → 复习路径公式可作回归基准（数值层仍为逼近）。
### 4.3 同日第 N 次反馈

- 长期 `h/d/dueAt` **不变**（help30：非当天首评只影响当天再出现的位置）；只更新 `todayProgress`（§1.3）、
  `sameDayCount`、日志（`longTermUpdate=false`）。
- 回炉：模糊/不认识每次都要回炉（默认 `allowVagueComplete=false` 时模糊无限回炉直到认识；
  开启后模糊在进度达 1 时完成当日）。
- 回炉 gap：**保持 v1 推测值 forgot=4 / vague=8 词位**（官方无数值；04/05 都标 D），参数化可 A/B；不随 v2 改。

### 4.4 d0 使用

- `createWordState({ wordId, deckId, difficulty })`：`difficulty` 来自 `Word.difficulty`（官方数据），
  缺失时 fallback 5 并用 `word.difficulty == null` 判断为估算；`d0` 不再固定 5（`params.d0` 仅作为最终兜底）。
- 词库构建（task-25）：按 `normalizeHeadword` join 官方难度，写入 deck JSON 的 `difficulty` 列；
  `dataVersion` 升级（hongbaoshu=5 / dagang=4 或统一 +1），manifest 同步，重种保留学习进度。
- 许可：Dataverse CC BY-NC 4.0；关于页/文档需署名来源。

---

## 5. 每日队列 v2（**不再硬截断**）

### 5.1 建队规则（官方口径）

```
due = states.filter(isDue && deckId 匹配)              // 全部到期（dueTotal）
dueSorted = sortBy(retrievabilityNow 升序, dueAt 升序)  // 遗忘程度高→低
reviewQueue = reviewCap > 0 ? dueSorted.slice(0, reviewCap) : dueSorted  // task-51 每日复习上限
newBudget   = max(0, dailyGoal - reviewQueue.length)   // 按实际入队复习数算
newQueue    = 未学新词按 order 取前 newBudget 个
extra       = 用户手动加学（不计入 newBudget，立即追加）
```

- 队列总长 = `reviewQueue.length + newQueue.length`（可 > dailyGoal）；
- 首页：待复习 = **HomeStudyData.dueCount（全部到期）**、待新学 = `newBudget`；`pickQueue().dueCount` = **今日入队复习数**（受 cap）、`dueTotal` = 全部到期；
- 签到/完成判定：队列清空 或 当日已评分词数 ≥ `min(dailyGoal, 当日队列量)`；
  逾期复习（overdueLeft）不阻塞签到，但保留「继续学习」入口。

### 5.2 `pickQueue` v2 签名

```ts
export interface DailyQueue {
  reviewQueue: WordState[];   // 今日入队复习（reviewCap>0 时按遗忘度截断；=0 时全量）
  newQueue: WordState[];
  dueCount: number;           // = reviewQueue.length（今日入队复习数，受 cap）
  dueTotal: number;           // 全部到期数（task-51 新增，必填；不被 cap 截断）
  newBudget: number;
  totalPlanned: number;
  extraCount: number;
}

export function pickQueue(states: WordState[], opts: QueueOptions): DailyQueue;
// opts 增加：newOrder?: 'order'|'random'；extraNewWordIds?: string[]；random?: () => number；reviewCap?: number（0/缺省=不限）
```

- 单测（AC3）：`due=100, goal=30` → `reviewQueue=100, newQueue=0, totalPlanned=100`；
  `due=10, goal=30` → `review=10, new=20`；`due=0, goal=30` → `review=0, new=30`；
  **reviewCap=20、due=100、goal=30** → `review=20, new=10, dueCount=20, dueTotal=100`；**reviewCap=0/缺省与旧行为一致**。
- **首页与学习页共用同一份 plan**（§6），不再每次进入重新 `getTodayQueue()`。

---

## 6. 今日计划持久化 + 「继续学习」

### 6.1 为什么必须持久化（官方依据 + 现状缺陷）

- 官方 CLI 能恢复 `12/50`（已完成/总数）与"返回上一个单词" → 说明服务端保存了**当天队列本身与位置**，
  不是每次重新组队（05 §2.1，B+推导）。
- 我们现状：`useStudySession` 每次进入都 `getTodayQueue()` 重新建队，`index` 只在内存 → 退出即丢顺序，
  与官方不一致（05 D2，P0）。

### 6.2 首页按钮状态机（6 态）

```ts
export type HomeStudyState =
  | { kind: 'no-deck' }
  | { kind: 'no-words' }
  | { kind: 'fresh'; pendingReview: number; pendingNew: number }        // [开始学习]
  | { kind: 'ongoing'; remaining: number; index: number; total: number } // [继续学习]
  | { kind: 'done-with-overdue'; overdue: number }                      // [继续学习（还有 N 个到期复习）]
  | { kind: 'done' };                                                   // [已完成 · 查看今日]

export function deriveHomeState(input: {
  plan: DailyPlan | null;      // 只取当天、当前 deck 的 plan
  dueCount: number;
  dailyGoal: number;
  hasDeck: boolean;
  hasLearnableWord: boolean;
  overdueLeft: number;          // plan 完成后仍剩余的到期复习数（data 用 countDue 计算）
}): HomeStudyState;
```

判定（数据层只给事实，文案 UI 定）：

```
无词库 → no-deck；有词库但无可学词 → no-words
无今日 plan（或 wordIds.length===0 且 completedAt==null）→ fresh：
    待复习 = HomeStudyData.dueCount（全部到期）、待新学 = newBudget（数据层按入队复习数计算）
plan 存在、completedAt==null：
    remaining = wordIds.length - index
    index===0 && ratings.filter(r=>!r.corrected).length===0 → fresh
    否则 → ongoing{ remaining, index, total: wordIds.length }
plan.completedAt != null：
    overdueLeft > 0 → done-with-overdue{ overdue: overdueLeft }
    否则 → done
```

UI 文案：fresh「开始学习」/ ongoing「继续学习 · 已学 index / 共 total」/
done-with-overdue「继续学习（还有 N 个到期复习）」/ done「今日已完成」。

### 6.3 plan 生命周期（数据层 API 以实现为准）

```
进入学习页
  → data.getTodayPlan({deckId, now})
       ├─ plans.get(`${date}:${deckId}`) 且未完成 → 直接返回（**续学，不重排**）
       └─ 无 → getTodayQueue() → wordIds=[...reviewQueue, ...newQueue] → 保存 plan（goals 快照）
  → 首页：data.hasResumablePlan() 决定「开始学习/继续学习」
  → 恢复：meta:plan.activeId 指向 plan + meta:session:<wordId>（w-c 次数，D15）
  → 推进：submitRating（**同一事务**：scheduleNext + states + reviewLogs + advancePlanAfterRating）
       认识 → 不回炉；模糊/忘记 → appendRequeue({gap:4/8})
       队列走完 → completePlan（completedAt=now）
  → 退出学习页：先 flush session 快照，再 saveTodayPlan（更新 wordIds/index/ratings）
  → 启动/建队前：cleanupOldPlans({keepDays: 7})
```

**数据层接口（`src/data/plans.repo.ts`，与 `docs/DATA-PLAN-v2-design.md` §4 一致）**：

```ts
getTodayPlan(opts?: { deckId?: string|null; now?: number; extraNewWordIds?: string[]; forceRebuild?: boolean }): Promise<DailyPlan>
saveTodayPlan(plan: DailyPlan): Promise<void>
hasResumablePlan(opts?: { deckId?: string|null; now?: number }): Promise<boolean>
getCurrentWordId(plan: DailyPlan): string | null
setPlanIndex(planId: string, index: number): Promise<DailyPlan>
advancePlanAfterRating(input: { planId: string; wordId: string; rating: Rating; reviewedAt: number; longTermUpdate: boolean }): Promise<DailyPlan>
appendRequeue(input: { planId: string; wordId: string; gap: number; reviewedAt: number }): Promise<DailyPlan>
completePlan(planId: string, now?: number): Promise<DailyPlan>
clearPlan(planId: string): Promise<void>
cleanupOldPlans(opts?: { keepDays?: number; now?: number }): Promise<number>
```

- **原子性（硬约束）**：`submitRating` 必须把 `states + reviewLogs + plans` 写在**同一事务**；
  不允许「先写状态、稍后写 plan」。
- **w-c 次数**：权威仍是 `meta:session:<wordId>`；`plan.wcCounts` 仅导出时冗余（跨设备续学）。
- **多词库**：一天内切词库 → 第二个 plan（id 含 deckId）；`meta:plan.activeId` 指向最近学习的 plan。

### 6.4 跨天与清理

- `date !== localDateKey(now)` → 当日无 plan：重新建队；旧 plan 只是历史快照，不影响 `states`。
- 未评分词无任何副作用（只有评分才写 WordState），次日按到期重新入队。
- `cleanupOldPlans({ keepDays: 7 })`：删除 `date < today-7` 的 plan（保留 7 天供今日/历史回顾扩展）；
  在 `ensureBuiltinDecks()` 之后、建新 plan 之前调用（幂等、失败不阻塞）。
- 时区：本地自然日（D 级；官方无文档）。

### 6.5 计划与迁移包

- `MigrationFile.data` 增加**可选** `plans?: DailyPlan[]`：只导出 `date === 导出当天` 的 plan（最多 1–2 条）；
  `counts` 增加可选 `plans`（旧文件缺省 0）。
- **`MigrationFile.formatVersion` 保持 1**（只加可选字段，向后兼容；checksum 覆盖整个 data，新旧包可互验）。
- 导入策略：`replace` → 同日 plan 覆盖、非同日忽略并 warning；`merge`/`keepNewer` → **保留本机 plan**
  （队列与设备/上下文相关，不跨设备合并），给 warning。导入的 plan 与 states 必须同一事务落地。

## 7. 返回上一个单词 + 改判（扩展，官方仅确认「查看」）

### 7.1 证据与边界

- 官方确认支持回退（截图 `<` / 鸿蒙"滑动返回上一个单词"/官方 CLI 退格/手柄），语义是**回到上一张卡片查看**；
  **官方未确认可以改判**（05 §5.1 / §11 Q3）。
- 因此 v2 实现分两级：
  - **回退浏览**（P0）：只移动位置，不撤销评分 —— 与官方一致；
  - **改判**（P1，我们的扩展）：点新评分时"撤销旧评分 + 应用新评分"，UI 明确提示。

### 7.2 撤销/改判算法（依赖 `ReviewLog.stateBefore` 快照）

**数据基础**：每次评分写 ReviewLog 时同时写入 `stateBefore`（评分前完整 WordState 深拷贝；首评新词为 null）；
撤销只需整对象恢复，**不做公式逆运算**。

```
undoLastRating({ wordId, planId?, now }):        // data API（事务）
  1) 找该 wordId 今天最近一条 corrected !== true 的 ReviewLog（须属于当前 plan）
     - 无日志 / 无 stateBefore / 非今天 → 返回 null（UI 禁用回退/改判）
  2) 事务内：
     stateBefore 非 null → db.states.put(stateBefore)；为 null → db.states.delete(wordId)
     db.reviewLogs.update(logId, { corrected: true })
     plan.ratings 对应项 corrected = true
     plan.index 回退到该词出现位置（重复回炉时撤销最近一次出现）
     若该次评分产生过回炉插入 → 删除 wordIds 中最后一个匹配位置
     plan.completedAt = null；更新 plan.updatedAt / meta.plan.updatedAt
  3) 返回 { state, plan }；UI 重开该词注释面

改判：撤销成功后正常 submitRating → 新日志自动带 `correctedBy: 旧日志 id`
```

**一致性要求（AC5）**：由于恢复的是「评分前完整状态」，改判后 WordState == 「直接按新评分评一次」的结果
（`now` 相同时深比较一致；时间戳字段除外）。单测必须锁定：
1. 撤销后用同一 rating 重提 → 与从未评分深比较一致；
2. 撤销「认识」改「忘记」→ 等于忘记路径；回炉只有一条；
3. 多步回退只浏览不撤销；只有点新评分才撤销该词最近一次；
4. 撤销不跨天；5. 完成页撤销回 ongoing（签到不回滚）；6. 回炉词二评后只撤最近一次。

**边界（拍板）**：只允许撤销 **今天、本 plan、最近一次** 评分；首词不可回退；更早反馈提示
「更早的反馈不可修改」。官方未确认可改判 → UI 标「扩展行为」，不改官方语义。

### 7.3 UI（dev-ui 实现）

- 学习页顶栏左：`<`（44×44）→ 上一个词注释面；**首词隐藏**（官方截图 03 无箭头）；退出仍在右侧/菜单。
- 水平滑动（≥32px 且以水平为主）→ 回退；与「整屏点击翻面」区分（点击不触发）。
- 回退浏览态：三键照常（复用 §1.2 预测；若该词今天已评分，标「上次：模糊（可改判）」）。
- 点新评分 → Toast 级提示「已将「模糊」改为「忘记」」，不做打断式弹窗；写库走 `undoLastRating + submitRating`。
- 退出学习（保存 plan）与回退（句内移动，不退出）区分；回退不可跨天。

## 8. 存储 schema v2（Dexie）

在 v1（decks/words/states/reviewLogs/settings/meta）基础上**新增 `plans` 表**；旧表只加可选字段（§3.3）。
**只建新表、无需 `.upgrade()` 数据迁移**（新表为空，Dexie 打开旧库时自动创建）。详见 `ARCH-v2.md` §2。

```ts
this.version(2).stores({
  decks: 'id, name, source, builtinKey, updatedAt',
  words: 'id, deckId, [deckId+order], headwordLower, *tags, createdAt',
  states: 'wordId, deckId, dueAt, phase, [deckId+phase], [phase+dueAt], lastReviewedAt',
  reviewLogs: '++id, wordId, deckId, reviewedAt, [deckId+reviewedAt], rating',
  settings: 'key',
  meta: 'key',
  // v2 新增：一天一词库一行
  plans: 'id, date, deckId, updatedAt, completedAt',
})
```

- `SCHEMA_VERSION` 1 → 2；`meta.schemaVersion = 2`；`plans` 主键 `id = `${date}:${deckId}``。
- **降级不支持**：v2 库被旧客户端打开会 `VersionError`（Dexie 行为；不是"旧客户端忽略新表"）；
  发版说明要求降级前先导出迁移包。
- 写入事务：`states + reviewLogs + plans`（一次评分三写），避免状态/日志/队列不一致。

## 9. 验收标准 v2（AC1–AC10，QA 逐条执行）

### AC1 · 三键文案状态机与官方真机序列逐值一致
- 用 `tests/core/progress-v2.test.ts` 的三条端到端序列断言 UI 格式化输出与真机观测一致：
  - face：`60/40/20` → `N天后/60/40` → 完成；
  - cat：`80/60/20` → `60/40` → `80/60` → `80/60` → `60/40` → `80/60/20` → `80/60`+`N天后` → 完成；
  - yellow：`80/60/20` → `60/40` → `80/60` → `80/60` → `60/40` → 完成。
- 三态格式优先级 `progress>=1 → "{days} 天后"` / `first → "今日 / {days} 天后"` / 否则 `"今日进度{round(100p)}%"` 逐字断言；
  主标签 `不确定/不认识` ↔ `模糊/忘记`；`memory.showPredictedInterval=false` 时只显示 `今日`/`今日进度`，
  `study.labelSwitch=false` 时标签固定「模糊/不认识」。

### AC2 · 新词首评长间隔（修复"第二天全复习"）
- 单测锁定（认识 K=80 / 模糊 K_v=100）d=1/2/3/5/10 三支间隔 = **63/3/1、44/2/1、33/2/1、21/2/1、10/1/1**（±1 天容差）；
- 连续认识基准（d0=5）：**21 → 44 → 88 → 169 → 311 → 365（封顶）**；h：141.08→292.27→580.80→1109.40→2044.04→3635.71；
- 认识首评后 `dueAt` 不是次日（21 天）；首评忘记固定 1 天；**非首评忘记按公式（不强制次日）**。

### AC3 · 队列不硬截断
- `due=100, goal=30` → `reviewQueue.length=100`、`newQueue=0`、`totalPlanned=100`；首页显示待复习 100；
- `due=10, goal=30` → 10 + 20；`due=0, goal=30` → 0 + 30。
- 每日学习量可设 1 / 30 / 200 / 9999；0/-1/小数/NaN 被拒绝（结构化错误）。

### AC4 · 续学一致性（TodayPlan）
- 学习 5 个词后退出 → 重新进入：**同一队列、同一顺序、同一 index、同一剩余词、回炉位置一致**；
- 中途进入 w-c 未完成退出 → 恢复 memory 阶段与已完成次数（D15 保持）；
- 首页按钮：fresh→「开始学习」、ongoing→「继续学习 · 还剩 N」、done→「已完成」、due>goal 且完成后→「继续学习（还有 N 个到期复习）」；
- 跨天（改系统时间/日期 key）→ 旧 plan 丢弃、新一天重新建队，旧未评分词无状态副作用。

### AC5 · 回退 + 改判一致性
- 单测覆盖 §7.2 的 6 条一致性；`reviewLogs` 撤销后 `corrected=true`（`correctedBy` 关联新日志）且统计/曲线排除；
- UI：首词无 `<`；水平滑动回退；点新评分出现"已修改"提示；不点评分仅浏览不产生日志。

### AC6 · 设置项与进度模型
- 20 项全部可读写、实时生效、重启保持；`memory.showPredictedInterval`/`study.allowVagueComplete`/
  `study.labelSwitch` 三项行为符合 §1；`study.dailyGoal` 1–9999 严格校验（越界/小数/NaN 拒绝）；
- **v2 默认模型下完成判定只看「认识」+档位表**（`canFinishMode='table'`）：模糊/忘记永远不完成当日；
  `study.allowVagueComplete` 仅对 `progressModelMode='v1-20pp'` 回滚模型生效（A/B），v2 下不改变行为；
- **`params.progressModelMode` 默认 `'v2-levels'`**（5 档状态机，§1.3）；`'v1-20pp'` 可切回旧模型做回归/A-B，
  切换不得破坏已有 `WordState`/迁移包数据（`todayProgressLevel` 缺失按首评入口档位派生）。

### AC7 · 官方难度 d0
- 内置词库：受限商业词表官方难度覆盖率 ≥98%、大纲 ≥99%；难度 ∈[1,10]；
- 已知词（如 dog/nose）难度与官方数据一致；未覆盖词 fallback 5（用 `difficulty == null` 识别估算）；
- 老安装 dataVersion 升级后自动重种、学习进度保留。

### AC8 · 同日回炉规则
- 同日第 2 次起：长期 `h/d/dueAt` 不变（`longTermUpdate=false`）；模糊/忘记每次回炉；
- gap 仍为 forgot=4 / vague=8 词位（参数化）；回炉重复失败不影响长期状态。

### AC9 · v1 功能不回归
- 已实现事实必须保留：`random` 模式新语义（每次点击后从未满 c 随机选、必收敛）、
  「记忆」按钮可重复重开一轮（task-17）、含义语义拆分（task-16，受限商业词表 28759 义项，dataVersion 4/3 起）、
  词组显示（默认关）、主题/安全区、PWA 离线、APK 壳、导入导出、不熟悉度 clicks/encounters。

### AC10 · 迁移与兼容
- v1 Dexie 库在启动时平滑升级到 v2：states/reviewLogs/settings/decks/words 无丢失（记录数前后一致），
  新字段默认值正确；plans 表建立且为空；
- 迁移包 `formatVersion` 兼容：v1 包可导入 v2；v2 包导入 v1 旧代码时给出明确错误（版本不支持）；
- APK（0.1.3+）内 WebView IndexedDB 同 origin 升级后学习数据保留。

---

## 10. 里程碑与依赖（给 Lead 的排期建议）

```
M1（数据层底座） task-24 完成 —— 但按本文 §3.5/§6 扩展（dailyGoal 1–9999 + DailyPlan 设计稿对齐）
M2（核心对齐）   task-26（types/todayProgress/params → predictAll/format → 首评/队列）→ CORE-API 更新
M3（难度数据）   task-25（依赖 M2 的 Word.difficulty）→ dataVersion 升级 → 覆盖测试
M4（UI 文案）    task-27（依赖 M2）→ 三键格式/标签/学习量输入/新设置项
M5（计划持久化） 新任务（见 ARCH-v2 §5）：data plan repo + UI 续学接线
M6（回退改判）   新任务：data undo + UI 手势/提示
M7 验收          QA：AC1–AC10 + E2E；Lead 手机走查
```

---

## 11. 与 v1 的差异清单（共 20 项，供 Lead 核对）

| # | v1 | v2 | 来源 |
|---|---|---|---|
| 1 | 新词首评一律 1 天（h0+阈值法） | 候选 A（**K=80**）：认识 7–90 天（d=1→63、d=2→44、d=5→21、d=10→10）、模糊 1–7 天、忘记 1 天 | 04 §6.1/§11.4 + Lead 指示 |
| 2 | 三键副标题「N天后 / 今日·N天后 / 今日·明天」 | 官方三态：`{days} 天后` / `今日 / {days} 天后` / `今日进度{X}%`（逐字） | 04 §3.2 |
| 3 | 三键标签固定「认识/模糊/不认识」 | 首现「认识/不确定/不认识」；之后「认识/模糊/忘记」（可配置 legacy） | 04 §3.3 |
| 4 | 无当日进度概念 | `WordState.todayProgressLevel`（1–5）+ **5 档状态机默认**（v2-levels；`todayProgress` 仅 v1 回滚） | research 04 §15 + Lead 实机 face/cat/yellow |
| 5 | `previewNext` 只给 longTermDays/todayRequeue | `predictAll` 返回 `WordPredicts = Record<Rating, Predict>` + `isFirstShow(state)`；`NextPreview` 保留 | 04 §11.1 |
| 6 | d0 固定 5 | 用官方公开难度数据（覆盖率 99%）；缺失 fallback 5+estimated | 04 §8 |
| 7 | 复习队列 `slice(0, goal)` 硬截断 | 复习默认全量入队；新增可选「每日复习上限」`reviewCap`（默认 0=不限，超出顺延、`dueTotal` 保留全部到期）；新学预算 = max(0, goal − 入队复习数) | 05 §3 + task-51 |
| 8 | 每次进入学习页重新建队 | `DailyPlan` 持久化，同队列/顺序/index/回炉恢复 | 05 §2.3 |
| 9 | 首页只有「开始学习」 | 6 态：开始/继续/已完成/继续(逾期)/空态 | 05 §2.2 |
| 10 | 每日学习量 5–200 | 1–9999 任意整数，输入框 | 用户要求 |
| 11 | 无返回上一词 | `<` 回退 + 水平滑动；首词隐藏 | 05 §5 |
| 12 | 评分不可逆 | 快照撤销 + 改判（扩展），`reviewLogs.stateBefore` + `corrected/correctedBy` | 05 §5.3 |
| 13 | 无今日进度设置在按钮上 | 新增 `memory.showPredictedInterval`（官方「显示间隔」设置） | 04 §3.2 |
| 14 | 模糊必须回炉到认识 | 新增 `study.allowVagueComplete`（默认 false=官方行为） | 04 §5.3 |
| 15 | 无标签风格开关 | 新增 `study.labelSwitch`（true=官方风格 / false=legacy） | 04 §3.5 |
| 16 | 设置 15 项 | 20 项（+5） | 本文 §3.5 |
| 17 | 无 plan 表 | Dexie v2 新增 `plans` 表（`id,date,deckId,updatedAt,completedAt`；无需 upgrade） | 本文 §8 |
| 18 | 无回退/改判留痕 | `ReviewLog.stateBefore/corrected/correctedBy`（只加可选字段，formatVersion 保持 1） | 本文 §3.3 |
| 19 | 首评常数 K=100（d=1→79） | **K=80**（d=1→63、d=2→44、d=5→21、d=10→10；官方实机 56–78 分散，不可逐词复刻） | Lead 指示 + `tests/core/progress-v2.test.ts` 锁定 |
| 20 | 进度模型只有 20pp 一套 | **5 档状态机（默认启用）**：L1a/L1b/L2/L3/L4 档位表 + 转移表 + `canFinishMode='table'`；未观测转移标 `inferred`；`v1-20pp` 保留回滚 | Lead 实机 face/cat/yellow + research 04 §15 + dev-algo 实现 |

**保留的 v1 事实（不得回退）**：random 模式新语义、「记忆」可重复重开、含义语义拆分（28759 义项）、
词组数据（默认关）、不熟悉度公式、主题/安全区、PWA/APK 交付、导入导出、MaiMemo导入通道。

---

## 12. Lead 拍板结果（2026-11-11，已确认，覆盖下方默认项）

> 下列为 Lead 最终决定，**已生效**，无需再议；实现按此执行。
> 1. **候选 A 接受**：新词首评 `K=100×h0(d)`，参数化；单测锁定 d=1/2/5/10 基准（79/3/1、55/2/1、27/2/1、12/1/1）。
> 2. `is_first_show` 默认「新词首次」，保留可切「当日首显」的开关（`params.labelSwitch`）。
> 3. **「今日进度%」上线**，明确标注为近似（D 级）；实现已从 20pp 升级为 **5 档状态机并默认启用**（2026-11-11 Lead 实机 face/cat/yellow 验证，见 §1.3/§12.1）。
> 4. **迁移包包含当天 plan**（跨设备续学）；导入时日期不同 → 忽略 plan、保留词库/状态（给 warning）。
> 5. v1→v2 迁移失败：**保留原库 + 提示用户导出备份**，不自动清空/不自动重建。
> 6. 设置项 **18 个保留**（含 `study.labelSwitch`；命名以已实现代码为准：`study.labelSwitch`/`memory.showPredictedInterval`/`study.allowVagueComplete`）。
> 7. 回炉 gap **保持 forgot=4 / vague=8 词位**，标注无法确认（U6），参数化可 A/B。
>
> 待办对应关系：task-24（dailyGoal/设计稿）、task-25（官方难度）、task-26（core 对齐）、task-27（UI 文案）、
> task-28（Dexie v2+plans，dev-data）、task-29（撤销/改判+统计过滤，dev-data）、task-30（plan 驱动续学/回退 UI，dev-ui）、
> task-31（QA 全量验收+迁移+APK 0.1.3）。

### 12.1 2026-11-11 追加（K=80 / 进度模型升级为 5 档状态机）

- **首评常数 K 100 → 80**（Lead 指示）：实现精确基准 d=1→63、d=2→44、d=3→33、d=5→**21**、d=10→**10**；
  与 Lead 消息中「d=5→22、d=10→12」存在 1–2 天差异，本文以公式/单测精确值为准（已同步告知 Lead/dev-algo）。
- **进度模型升级为 5 档状态机并设为默认**（Lead 2026-11-11 11:2x 拍板）：
  `progressModelMode` 默认 `'v2-levels'`；档位 L1a/L1b/L2/L3/L4、转移表、`canFinishMode='table'` 见 §1.3；
  face/cat/yellow 三条真机端到端序列已写入 `tests/core/progress-v2.test.ts` 并作为 AC1 基准；
  未观测转移标 `inferred`；`v1-20pp` 保留回滚/A-B。
- **命名口径（已最终确定，关闭）**：`progressModelMode='v2-levels'` + 数组 `progressLevels`
  （每项含 `name:'L1a'…'L4'`）+ 数字 level 1..5（`WordState.todayProgressLevel?: number`）+
  `LevelTransition{to,inferred?}`；**不新增别名/不改名**。research 04 §15.7 已确认以 `'v2-levels'` 为准
  （注明早期称 v3/FSM 为历史叫法，实现名以 `v2-levels` 为准）。
- `WordState` 新增 `todayProgressLevel?`（1..5）/ `canFinishToday?`（可选；旧数据缺失按首评入口档位/默认规则派生，
  迁移/导出兼容）；`todayProgress` 标量仅 v1/兼容。

## 13. 附：早期待拍板点（已由 §12 拍板结果取代，仅留档）

1. **首评间隔候选 A 的 K=100 是否接受**（数值层"拟合而非官方"）？默认：接受，参数集中可调。
2. **`is_first_show` 语义**：默认「新词首次」；若用户实测为「当天首显」，改 `params.labelSwitch='firstToday'` 即可。
3. **「今日进度%」是否上线**：默认上线（推断 D，逐值复现截图）；若要求"不猜数字"，可改 `memory.showPredictedInterval=false`
   或退化为仅显示间隔（研究 05 §6.3 的稳妥替代）。
4. **DailyPlan 是否导出到迁移包**：默认导出当天 plan（跨设备续学）；若不希望跨设备带"今日进度"，改为不导出。
5. **旧 v1 数据迁移失败的处理**：默认「保留原库 + 弹提示，不自动清空」；需 Lead 确认（数据安全）。
6. **任务拆分**：见 `docs/ARCH-v2.md` §5（建议新增 2 个任务：plan 持久化、回退改判）。

---

*（本文结束。任何与 DECISIONS.md 冲突的改动以 DECISIONS 为准并同步本文；接口变更必须同步 CORE-API/DATA-API 与测试。）*
