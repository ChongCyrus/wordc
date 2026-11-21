# 数据层审计（0.3.93 / task-275，冻结新功能）

范围：计划状态机、manual/auto 新词、旧计划迁移、添加/移除、临时复习、数据同步、升级迁移、一致性、性能。
审计方式：读代码 + 定点 tests（不并发全量，避免本机 OOM）；不调用真实 API。

## 结论摘要

| # | 风险 | 级别 | 状态 |
|---|---|---|---|
| 1 | manual 模式 `getTodayQueue` 仍按 dailyGoal−due 计算 newBudget；首页无 plan 时显示待新学 30 | P1 | **已修**：`getTodayQueue` 读 `study.newWordSource`，manual 强制 dailyGoal=0/newQueue 空；`getHomeStudyData`/home-kpi/HomePage pendingNew manual=0 |
| 2 | 切 manual 后旧 auto 计划里的未学新词继续占“待新学” | P1 | **已修**（Lead）：`getTodayPlan` 对已有 manual 计划清理 `sources='goal'` 且未评分的未学新词，保留复习/已学/手动词，goals.newBudget=0 |
| 3 | 顺序/随机添加卡住 60s（QA）：`pickUnlearnedNewWords` 走 `unlearnedWordsInDeck`，把 5528 个完整 Word（含预装本义助记/例句大字段）全量 toArray | P1 | **已修**：改为 primaryKeys 只取 id + states 过滤，再仅 `bulkGet` 选中 N 个词；添加/顺序路径不再加载全库大字段 |
| 4 | 0.3.91 私版/PWA 首启自动预装 13MB 阻塞首屏/路由 | P1 | **已修**：`data.generatedAutoSeed` 默认 false；仅 APK 且全新空库、设置开启、packs 成功后延迟 2.5s+可见才自动导入；Web/已有 state 跳过 |
| 5 | 预装导入同步解析/写入大文件 | P1 | **已修**：已有数据阈值快速跳过；本义助记/引申图每 200 条让出主线程；失败 diag + 下次重试 |
| 6 | `getWordsPage` familiarity 排序比较器内 `states.find` O(n²) | P2 | **已修**：预计算 state/familiarity Map |
| 7 | `getManualNewWordCandidates`/章节/排行收集仍全量加载 Word；预装大字段时可慢 | P2 | 观察项：当前按需路径已用 ids-only；人工筛选页一次加载仍可能受大字段影响，后续可加字段投影/轻量索引 |
| 8 | 预装状态写入并发可能乱序覆盖 completed/failed | P2 | **已修**：seed state 写入串行化 |
| 9 | 分片导入/恢复/自动备份 | — | 已测：大文件 200 条让出；applyParsed 复用 preview plan；自动备份每次启动同日覆盖 |
| 10 | manual/auto 切换后旧 plan 不自动改（预期） | — | UI 提供保留/移除/仅移除；数据 API `removeUnlearnedAutoNewWords` |

## 计划一致性检查

- **manual 新建计划**：仅自动复习入队；`goals.newBudget=0`；不产生自动新词。
- **auto 新建计划**：保持旧行为（复习 + 新学预算）。
- **旧计划**：`getTodayPlan` 不自动改 auto 计划；manual 时清理未学自动新词；已完成计划追加后 `completedAt=null`、index 保留。
- **添加**：
  - `appendNewWordsToTodayPlan` 默认只收未学、不在计划；`allowRepeat` 可重复追加今日已学/已在计划词（同日重复复习）。
  - `appendWordsToTodayPlan` 任意状态（临时复习），不改 DHP 参数；去重默认。
  - `sources` 使用 manual/random/order；重复 occurrence 由计划状态机/评分逻辑按现有 requeue 机制处理。
- **移除**：只删 `sources='goal'` 且未评分、state 缺失/phase='new'；保留复习/已学/手动；index 按保留元素重算。
- **迁移**：settings 新增键默认值在旧库缺键时读默认；plan 数据字段未改；迁移包/恢复不受影响。

## 性能证据

- `pickUnlearnedNewWords`：修复前 5528 完整词 toArray（含预装大字段）；修复后 primaryKeys + states + 选中 bulkGet。
- 本义助记导入 13404 条 preview/apply 分片 200；引申图 6684 条分片 200。
- 词库列表 familiarity 排序预计算 Map，避免 O(n²)。
- 测试命令（定点）：
  - `tests/data/manual-new-words.test.ts`
  - `tests/data/deck-insights.test.ts`
  - `tests/data/default-generated.test.ts`
  - `tests/data/settings.test.ts`
  - `tsc --noEmit`

## 已知限制/后续

- 人工筛选/章节/排行“收集全部”接口仍可能加载完整 Word（含大字段）；数据量大时建议 UI 只对当前页/前 N 使用，或后续增加字段投影查询。
- 预装自动导入默认关闭；手动导入仍可能耗时，已提供进度/状态/完成/失败提示。
- 自动备份每次启动写一份（同日覆盖），gzip/prune 由原生桥完成。
