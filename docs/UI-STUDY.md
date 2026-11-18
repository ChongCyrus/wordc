# UI-STUDY · 学习界面实现说明与手工验收（task-9）

> 产出：dev-ui ｜ 依据：`docs/SPEC.md` §4/§8.2/§9、`docs/DECISIONS.md` D12–D19/D32/D33/D39/D40、`docs/research/03-ui.md` §4.2–4.4/§5、`docs/research/assets/tokens.css`
> 范围：`src/ui/study/**`、`tests/ui/**`、本文件。学习页是项目核心体验，用户直接验收。

## 1. 文件结构

```
src/ui/study/
├─ StudyPage.tsx                 路由页：三态渲染 + 完成页 + 退出确认 + ⋮ 菜单 + 快捷设置 + toast
├─ hooks/useStudySession.ts      队列加载 / 会话推进 / 不熟悉度写入 / 快照 / 评分提交
├─ lib/speech.ts                 浏览器语音合成发音（无第三方依赖）
├─ lib/familiarity-display.ts    不熟悉度 5 档 / 宽度 / 百分比展示映射（纯函数，单测覆盖）
├─ lib/pos-label.ts              词性MaiMemo化映射（n.→[名]、vt.→[动]、phr.→[词组]；未知原样，单测覆盖）
├─ lib/next-hint.ts              三键「下次出现」文案（官方 predictAll 三支格式化 + 旧 previewNext 兼容）
├─ lib/rating-labels.ts          三键主标签（首次 认识/不确定/不认识；之后 认识/模糊/忘记；可回退旧文案）
├─ components/
│  ├─ BoardStage.tsx             白板面：单词 + 音标（可关/缺失隐藏）+ 英文例句（无中文）
│  ├─ AnnotationStage.tsx        注释面：含义行/不熟悉度条/例句/助记/词组
│  ├─ MemoryStage.tsx            w-c 页：大卡 w → c + 次数/点阵 + 词组块 + 整屏点击
│  ├─ ActionBar.tsx              记忆按钮（44px 居中）+ 三键（48px 均分）
│  ├─ MeaningRow.tsx             含义行（整行可点，clicks+1，120ms 高亮）
│  ├─ FamiliarityBar.tsx         4px 不熟悉度条 + 5 档色 + 百分比
│  ├─ WordHead.tsx               单词 + 音标 + 发音（board/annotation/wc 三尺寸）
│  ├─ CompletionPage.tsx         完成页 / 空状态（猫头鹰单色 SVG）
│  ├─ StudyTopBar.tsx            顶栏（× / 进度 / ⋮）+ 2px 顶部进度条
│  ├─ StudyOverlay.tsx           退出确认弹窗 / ⋮ 底部菜单
│  ├─ QuickSettingsSheet.tsx     学习页内快捷设置（实时生效，AC4 演示）
│  ├─ HighlightedText.tsx        例句中的目标词高亮（只换色）
│  ├─ icons.tsx                  线性 SVG 图标（24 视框 / 1.5 描边）
│  └─ types.ts                   纯展示 ViewModel 类型（不依赖 core/data）
└─ styles/study.css              学习页样式（全部走 token，深色模式自动跟随）
                                  ※ 设计 token 统一在 src/app/styles/tokens.css（全局引入，避免两套主题变量）
```

## 2. 实现要点（对照 SPEC / DECISIONS）

| 规则 | 实现位置 | 行为 |
|---|---|---|
| 白板面只显示单词+音标+英文例句（D12） | `BoardStage` | 不渲染任何中文释义；`board.exampleCount` 截断 0–3 条；例句中目标词只换色高亮 |
| 整屏点击进入注释面（D13） | `BoardStage` | 顶栏不在组件内；发音按钮 `stopPropagation`；进入注释面后 **300ms 内三键禁用**防误触 |
| 音标缺失隐藏、无数据不占位（D33） | `WordHead` | `phonetic` 空则整行（含发音按钮）不渲染；`board.showPhonetic=false` 同样隐藏 |
| 注释面含义可点标记不熟（D14） | `MeaningRow` | 整行 `role=button`，点击 `clicks+1` + 10ms 振动 + 120ms 高亮；百分比与 `clicks/encounters` 同屏 |
| 不熟悉度可视化 | `FamiliarityBar` | 4px 条 + 5 档色（`--mm-fam-0..4`）+ 深色文字色（`--mm-fam-*-text`）；0/0 显示 `—`；宽度 240ms 过渡 |
| 记忆按钮在三键上方居中 | `ActionBar` | 记忆 44px / 三键 48px；颜色走 D17 压深色 `--mm-rating-*`；提交后 400ms 防连点 |
| w-c 大卡「w → c」 | `MemoryStage` | 字号受 `memory.fontScale`（0.8–1.6）；卡片宽/内边距受 `memory.cardSize`（0.8–1.4）；超长文本降字号 |
| 当前/总次数 + 点阵 | `MemoryStage` | `2 / 3` 24px/600 + `total` 个 8px 圆点；点击 +1 有 scale 弹动 |
| w-c 整屏点击 +1 | `StudyPage` → `useStudySession.memoryTap` | 顶栏除外；满次数后等 220ms 动画再调 `advanceMemory` 切下一个 c / 回注释面 |
| mode=默认/随机 | `src/core/session.ts`（dev-algo，task-22） | 顺序：当前 c 满 → needsAdvance → UI 220ms 后 `advanceMemory` 切下一个；随机：**每次点击后 core 立即重随机**下一个未满 c（needsAdvance 恒 false，UI 不再调 advanceMemory），最后一次点击直接回注释面 + toast「记忆完成，可再次点击继续」 |
| 词组开关（D16/D32） | `MemoryStage` / `AnnotationStage` | 开启且存在含 w/c 的词组时最多显示 3 条；无数据整块不渲染、不占位 |
| 全部 c 完成回注释面、状态保留 | `useStudySession` | `advanceMemory` 回 `annotation`；滚动位置恢复；toast「记忆完成」；wcCounts 已持久化 |
| 中途退出保留次数（D15） | `useStudySession` | `stage=memory` 时每次 +1 debounce 500ms 存快照；退出记忆/离开页面立即存；再次进入 `createSession({savedCounts})` 继续 |
| 进入注释面 encounters+1（D40） | `useStudySession.boardTap` | `shouldRecordEncounters` → `recordMeaningEncounters(全部含义)`，每会话仅一次；乐观更新 + data 返回值合并 |
| 点击含义 clicks+1 | `useStudySession.markMeaning` | 乐观 +1 → `recordMeaningClick` → max 合并，避免与 encounters 写入竞态丢计数 |
| plan 驱动续学（task-30） | `useStudySession`（`getTodayPlan`/`rateInPlan`） | 进入学习页按当天 plan 的 `wordIds + index` 加载；每次评分 `rateInPlan` 单事务写 states+logs+plan（自动回炉插入）；退出/刷新/改设置再进**恢复到同一进度**；队列进度用 `plan.index / plan.wordIds.length` |
| 首页 6 态 + 继续学习（task-30） | `useHomeStudy`（`getHomeStudyData` → `core.deriveHomeState`）→ `HomeTaskCard` | no-deck/no-words/fresh/ongoing/done-with-overdue/done；按钮：开始学习 / 继续学习 · 已学 x / 共 y / 继续学习（还有 N 个到期复习）/ 查看今日 |
| 返回上一词 + 改判（task-30，扩展） | 顶栏 `<` + `useSwipeBack` + `LastChoiceBadge` + `reRateInPlan` | 首词不可回退；水平右滑 ≥64px 或点 `<` 回到上一词注释面（**只浏览、不撤销**）；显示「上次选择：X（可改判）」+「不改了，继续」；点新评分才 `reRateInPlan`（撤销旧评分+应用新评分），toast「已将「模糊」改为「忘记」，计划已更新」；回退不可跨天 |
| 队列空 → 完成页 | `StudyPage` | 今日学习 N 个 · 用时 M 分钟；查看统计 / 回首页；无词库时给「去添加词库」 |
| 顶部/底部进度 | `StudyTopBar` | 单词进度 `3 / 50` + 2px 进度条；记忆页显示 `已满含义 / 含义总数` |
| 退出确认 | `StudyPage` | 文案按 SPEC §4.1：标题「退出学习？」正文「今天的进度会自动保存，下次可继续。」；记忆页 × 先确认退出记忆 |
| 动效与减少动效 | `study.css` | 160–240ms / 标准缓动；`prefers-reduced-motion` + 设置项 `reduceMotion`（html 类 `study-reduce-motion`，由 task-10 全局层挂）时 1ms |
| 深色模式 | `tokens.css` | 全量使用 `--mm-*` 变量，无写死颜色；`data-theme=dark` 自动切换；`theme-color` 由 task-10 外壳同步 |
| 触控/安全区 | `study.css` | 顶栏按钮 44×44、三键 48、含义行 ≥64；底部操作区 `padding-bottom: 14px + safe-area` |
| 发音 | `lib/speech.ts` | `speechSynthesis`（en-US）；不可用时 toast 提示，不影响学习 |

### 状态机（与 core 一致）

```
先队列（getTodayQueue → reviewQueue + newQueue）
  └ 逐词：createSession（savedCounts 恢复）
       board --tapBoard--> annotation --openMemory--> memory
         ▲                     ▲                       │
         │               评分/下一词                  │ 全部 c 满
         └── submitRating ←── annotation ←── advanceMemory
                          （wcCounts 保留）
```

## 3. 手工验收步骤（手机 Chrome · 375–390 宽）

> 前置：`pnpm test && pnpm build` 通过；用预览服务打开 App（详见 docs/RUN.md / START.md）。
> 学习页入口：首页「开始学习」→ `/study`。

### 3.1 白板面
1. 打开学习页，确认整屏只显示：单词（青绿大字）、音标+🔊（若无音标数据则整行不显示）、1–3 条英文例句；**不出现任何中文**。
2. 点单词以外的空白处 → 进入注释面；观察「记忆」按钮与三键出现后 **300ms 内点「认识」无效**（防误触）。
3. 要点：例句里的目标词是青绿色（不是加粗/下划线）；底部提示「轻点屏幕，回忆释义」。

### 3.2 注释面
1. 顶部单词 30px + 音标；下方含义行每条：`[n.] 蜘蛛 …… 60%`。
2. 词性标签为MaiMemo风方括号中文：`n.`→`[名]`、`vt./vi.`→`[动]`、`adj.`→`[形]`、`phr.`→`[词组]`；未知词性（如 `abbr.`）按原样显示。
3. 点一条含义 → 数字/百分比立即上升（clicks+1），条变宽变色，行有 120ms 淡青高亮（手机可感知 10ms 振动）；连续点可 >100%（展示 clamp 到 100%）。
4. 区块顺序：释义 → 例句（英文 + 中文翻译）→ 助记（类型标签）→ 词组（无数据时整块不出现）。
5. 点 🔊 朗读单词；不支持时出现 toast「当前浏览器不支持发音」。
6. 滚动到底部，确认底部操作区（记忆按钮 + 三键）固定不随内容滚动、不被安全区遮住。

### 3.3 记忆 w-c 页（默认顺序）
1. 注释面点「记忆」→ 全屏大卡「english ↓ 中文」，下方 `0 / 3` + 3 个灰点；顶部显示 `0 / N 个含义`。
2. 轻点屏幕 → 次数 1/3，点阵亮 1 个；再点至 `3 / 3` → 220ms 后自动切到下一个 c（卡片内容变化，次数归 0）。
3. 全部含义满次数后自动回注释面，toast「记忆完成，可再次点击继续」；回到注释面时滚动位置保持、不熟悉度条数值保持。
3.1 **记忆按钮可重复**：完成一轮后「记忆」按钮仍可点（`记忆` 永不置灰）；再点 → 重置本轮次数（`0 / N`）从第一个含义重新开始，且不会重复累计「遇到」次数。
3.2 **续学（plan 驱动）**：学到第 3 个词时退出学习 → 首页按钮变为「继续学习 · 已学 2 / 共 N」→ 再进学习页回到第 3 个词（队列顺序/回炉位置/已学词保持）；中途在记忆页退出也能恢复 w-c 次数。
4. 中途点顶栏 `×` → 「退出记忆？」→ 取消：继续记忆；确认：回注释面。**再点「记忆」应从上次未满的 c 继续**（次数不丢）。
5. 记忆中途直接退出学习（× → 退出）：重新进入学习后（该词再次轮到），记忆次数应保留。

### 3.4 随机模式 / 总次数 / 词组开关（设置实时生效，AC4）
1. 学习页点右上 `⋮` → 「记忆设置」。
2. 把「记忆总次数」调成 1 → 关闭弹层 → 再点「记忆」：卡片显示 `0 / 1`，点 1 次就切 c。
3. 「记忆模式」切到「随机」→ 点「记忆」：每次点击后 c 立刻随机切换（可能仍是同一个 c，也可能跳到别的未满 c），无需等待；点满所有含义后**直接**回注释面并出现 toast「记忆完成，可再次点击继续」。
4. 「显示词组」开关（task-43）：w-c 页**只显示当前 c（含义）的词组**（`phrase.meaningId === 当前含义 id`），最多 3 条；切到下一个 c 后词组即时变化；`meaningId` 缺失/null 的词级词组**不显示（不硬猜）**；当前 c 无匹配则整块不渲染；注释面仍显示该词全部词组。
5. 拖动「w-c 字号」→ 关闭弹层 → 再进记忆页，w/c 字号立即变大/变小。

### 3.5 评分与队列
1. 注释面点「认识」→ 词条淡出、200ms 后进入下一词的白板面；顶部 `2 / 50` 与进度条前进。
2. 对某个词点「不认识」→ 之后队列中该词会再次出现（当日回炉，gap≈4）；「模糊」gap≈8。
3. 三键在提交后 400ms 内不可连点；提交失败会有 toast 提示且停留在当前词。
4. 连续学到队列结束 → 完成页「今日任务完成！学习 N 个 · 用时 M 分钟」→ 点「查看统计」进统计页、「回首页」回首页。
4.1 回首页后：今日任务卡「今日已学」下显示「复习 a · 新学 b」；点「查看今日单词 ›」→ `/today` 查看今天复习/新学单词及评分标签（task-50）。
5. **三个评分按钮下方显示「下次出现」**（官方规则逐字，11px 小字单行，按钮仍 48px 高，390px 宽不截断）：
   - `progress >= 1` → `N 天后`（如「63 天后」）；
   - 否则 `first`（今日首评/新词首次）→ `今日 / N 天后`；
   - 否则 → `今日进度N%`（如「今日进度60%」）。
   认识/模糊/不认识分别用 `core.predictAll()` 的独立预测；刷新/换词后仍正确。
   数值基准（core 首评常数解耦：认识 K_f=80、模糊 K_v=100；官方实机区间内逼近）：新词 d=1/2/3/5/10 → 认识 **63/44/33/21/10 天后**、不确定 **今日 / 3/2/2/2/1 天后**、不认识 **今日 / 1 天后**。
   **同日回炉 = 默认 v2-levels 5 档状态机**（Lead 拍板；`progressModelMode='v1-20pp'` 保留 A/B 回滚）：
   | 档位 | 模糊 | 忘记 | 认识 |
   |---|---|---|---|
   | L1a（首评不确定） | 60% | 20% | 80%（百分比） |
   | L1b（首评不认识） | 40% | 20% | 60%（百分比） |
   | L2 | 60% | 40% | N 天后（完成当日） |
   | L3 | 80% | 60% | N 天后 |
   | L4 | 80% | 80% | N 天后 |
   真机序列已用 `tests/ui/next-hint.test.ts` 锁定：face（不认识→认识→完成）、cat（不确定→模糊×3→忘记×2→认识×2→完成）、yellow（不确定→模糊×3→忘记→认识→完成）。
6. **三键主标签**：新词首次显示「认识 / 不确定 / 不认识」；同一词再次出现（或复习词）显示「认识 / 模糊 / 忘记」；设置「三键官方文案」关闭后固定旧文案「认识 / 模糊 / 不认识」。
7. **官方设置项**（设置页 → 学习设置/记忆设置）：
   - 「显示预计复习间隔」关：副标题只显示「今日」/「今日进度N%」（隐藏 N 天后）；
   - 「允许模糊完成复习」默认关：模糊持续到认识；开启后按 core 规则可在满足次数后完成（学习页实时生效）。

### 3.5.2 返回上一词 + 改判（task-30）
1. 学到第 2 个词（注释面）→ 顶栏出现 `<`（首词不出现）→ 点 `<` 或单词卡向右滑 ≥64px → 回到上一词注释面，顶部显示「上次选择：模糊（可改判）」。
2. 再点 `<` 可继续往回（只浏览，不改数据）；点「不改了，继续」回到当前进度（不回退数据）。
3. 回到上一词时**三键上方出现明显提示条**（浅青底 + 左侧强调竖线，字号 13px）：「正在回看上一词 · 上次选择「模糊」——点下方评分键即可改判，或「不改了，继续」」；首词/非回退/记忆阶段不显示；360px 宽最多两行不溢出。
4. 在回退浏览态点另一个评分 → toast「已将「模糊」改为「忘记」，计划已更新」；回首页统计里被撤销的旧评分不计入。
4. 首词（index 0）时 `<` 隐藏、右滑不触发；记忆 w-c 页内不触发回退。
6. 退出学习（`×`/菜单）与回退的区别：退出保存进度；回退只是页内移动。

### 3.4.21 生成式记忆三阶段（task-167 B）

- ActionBar 在「记忆」与「加权记忆」之间新增「生成式记忆」；全屏三阶段：
  - 阶段1：提示「记忆单词到生成元的映射…」、`word → 生成元`（字号设置）、右页 AI 文字（Markdown/占位「请点击 AI 生成」）、Mermaid（设置开关，含全屏）、AI 生成/保存；点页面计数达设置次数进入阶段2。
  - 阶段2：隐藏 Mermaid；每屏 `perScreen` 个 c + 例句（英/中）；顶部 nc 说明；c 可多选，已有 nc 默认选中；上一屏/下一屏；「下一步」持久化 nc（`setNcMeaningIds`）。
  - 阶段3：关系网络提示、`word → 生成元`、AI 文字、当前 nc 列表、Mermaid（开关）；「完成/退出」回注释面。
- 设置 → 生成式记忆（本机 localStorage）：点击次数 1–10（默认3）、每屏 c 数 1–5（默认2）、生成元字号 0.8–1.6、显示 Mermaid。
- 组件 `GenerativeMemoryStage.tsx`、设置 `app/hooks/generativeSettings.ts`。

### 3.4.34 批量尾部停滞：单条 30s 超时 + 自动重试（task-194）

- 数据层 `attemptOne` 用单条 30s AbortController 与外部 signal 合并：单条超时只失败该条、其它 worker 继续；`autoRetryTimeouts` 自动重试超时项一次，progress 带 `phase/retryDone/retryTotal/inFlight`，结果带 `retried`。
- UI 面板消费 retry 进度显示「自动重试 i/n」，最终失败可手动重试；UI 安全 watchdog 30s 兜底；连续 ≥2 超时提示降并发到 2。
- 单测：service 9 条（超时/自动重试/其它 worker 继续）+ UI watchdog/收尾。

### 3.4.37 本义助记（task-200，0.3.65）

- 注释面新增「AI 本义助记」（与「AI助记·生成元映射」「AI 标记不常考」同级）；本义列表每行显示「本义助记·本义N「label」：…」+「AI/我的」徽标，与「映射助记」区分。
- `SenseMnemonicPanel`：列当前本义及已有助记（可编辑/保存/删除）、AI 生成全部/单条重新生成（预览后应用）、覆盖已有 AI 开关、手动永不覆盖、结果提示 applied/skippedManual/skippedExisting/stale；stale 旧助记显示「本义已变化：旧助记…」可删除或迁移。
- `SenseMnemonicBatchPanel`：范围 当前词/今日计划/当前词库（≤200），并发1–4默认2，一次提交全部；onProgress 进度条/成功失败/inFlight；abort 停止、失败只重试失败项、预览勾选应用；done=total；无本义/无 Key/成本/取消提示。
- 层级：单面板 Dialog 默认层；批量面板顶层 `.batch-derivation` z80（不被 AI/生成式浮层裁切）。

### 3.4.48 本义手动标记/取消不常考（task-215，0.3.71）

- 本义卡底部新增 `.rare-toggle-btn`：未标记「标记不常考」→ 点击立即 `setRareCoreSenseIndexes` 合并当前 index 并 toast；已标记「取消不常考」→ 走现有二次确认（徽标同样保留）。
- 按钮 `stopPropagation`，不触发整卡 +clicks、不打开本义助记编辑；`aria-label` 含本义序号/label。
- 标记成功后按 `study.hideRareBlocks`（默认 true）隐藏该卡，「已隐藏 N 条」计数+1；点「点此显示」可见并取消。失败 toast「标记本义不常考失败」；与 AI 标记同存于 `Word.rareCoreSenses`，持久/迁移。

### 3.4.47 本义助记排除不常考本义（task-214，0.3.70）

- 当前词 `SenseMnemonicPanel`：新增「排除已标记不常考的本义」复选框默认勾选（会话级不持久）；`AI 生成全部` 用 `collectSenseMnemonicSources(...,{includeExisting:false,includeRare:!exclude})`，取消勾选才包含；全部被排除时空态提示并可取消勾选重试；单条「重新生成」仍可手动生成 rare 本义。
- 批量 `SenseMnemonicBatchPanel`：同样复选框默认勾选；`includeRare: !exclude`，候选为空提示「已排除不常考本义后无候选」；候选文案标注「已排除不常考本义」。
- 已保存助记不改；数据侧 `source.rare` 仅 includeRare=true 时标记。

### 3.4.46 本义不熟悉度 + 加权「只记本义」（task-212，0.3.70）

- 注释面本义卡整卡可点（排除助记块/徽标/按钮），`recordCoreSenseClick` +1；首次进入注释面 `recordCoreSenseEncounters` 全量 +1 一次（coreEncounteredRef 防重复）；显示 `clicks/encounters`、百分比、4px FamiliarityBar，与 c 的 meaningStats 完全独立；rare/隐藏卡不可点。
- 加权记忆页右上角持久开关「只记本义」`memory.weightedCoreSenseOnly`：开启时 `buildCoreSenseWeightedUnits`（默认排除 rare 本义）→ `toCoreSenseSessionWord` + `createSession({weightedTotals})` 打开 w-c；无可用本义 toast「该词暂无可用本义，已回退普通加权记忆」并走含义加权；会话中切换回到注释面按新模式重开、进度重置并 toast。
- `tests/ui`：本义 stats 展示/卡片点击/rare 不可点/加权开关与回退/切换断言。

### 3.4.45 批量不常考 core-only 汇总修复（task-213）

- 根因：批量面板解析结果时用 `source.coreSenses` 过滤 `rareCoreSenseIndexes`，mock/部分数据下 source 无 coreSenses 导致本义序号被清空；同时候选框仅按 `rareCns` 渲染。
- 修复：`rareCoreBatchFields` 保留原始本义序号（label 仅展示，缺失回退「本义N」）；应用本义写入独立于含义 ids 是否为空；汇总按实际应用数量输出「含义 N · 本义 M」。

### 3.4.44 本义不常考 + 默认隐藏（task-209/210，0.3.69）

- 设置：`study.markRareCoreSenses` 默认 true（「AI 标记不常考时也标记本义」，关闭仅标记含义、不请求本义、保留已有本义标记）；`study.hideRareBlocks` 默认 true（「隐藏标记为不常考的含义/本义」，与 hideRareMeanings 区分）。
- 注释面：本义卡「不常考」徽标（右上/头部，窄栏不竖排），点击走二次确认取消；`rareCoreSenseStale` 显示「本义已变化」+ 清理旧标记。
- 默认隐藏：被标 rare 的 c 整块（行+例句/助记/笔记）与本义卡整卡不渲染；显示「已隐藏 N 条不常考 · 点此显示」，点开后全部显示（带徽标）、再点恢复；计数=实际隐藏块数。
- 当前词 AI 预览含「本义」复选框，应用合并 rareMeaningIds + rareCoreSenseIndexes；批量面板开关传 `markCoreSenses`，结果含本义，按词应用两套字段，汇总「含义 N 条 · 本义 M 条」。
- 生成式阶段3 c 列表在 hideRareBlocks 开启时过滤 rare c（nc 不受影响）。
- 本义助记面板/批量仍显示全部本义（编辑用，不隐藏）。

### 3.4.43 c 行 AI 助记整行编辑（task-207，0.3.68）

- 去掉 c 级 AI 助记（`.meaning-mnemonic`）末尾「编辑」按钮；整行 `role=button/tabIndex=0`，`aria-label="编辑含义{cn} 的 AI 助记"`，点击或 Enter/Space 打开现有编辑弹窗。
- 笔记/用户助记的编辑按钮保留不变；沿用手势 click 抑制，不新增滑动手势逻辑。

### 3.4.42 390 分栏 50% 左栏本义区不竖排（task-206）

- `.core-sense-head` 允许 flex-wrap；label `flex:1 1 120px; min-width:0`，窄卡片时换到整行，徽标不挤压文字；`core-sense-badge` 顶部对齐。
- `.annotation-ai-rare` flex-wrap：按钮整块换行，按钮内 `white-space:nowrap; word-break:keep-all`，不再把「AI 标记不常考 / AI 本义助记」压成两行。
- `@media(max-width:520px)` 缩小本义区/卡片横向 padding，给窄栏更多文字宽度。

### 3.4.41 本义助记 P1 加载兜底（task-205）

- 根因排查：dev-data repo `listSenseMnemonicViews` fixture 毫秒返回，QA 0.3.67 dist 构建时间早于面板修改；同时 UI 侧存在 useEffect 依赖不稳定风险（`coreSenses` 数组每渲染新引用）。
- 修复：面板改用 `listSenseMnemonics` 原始字段 + `buildSenseMnemonicViews(coreSenses, stored)` 本地匹配回填；coreSenses 为空时依次回退 `listSenseMnemonicViews` → `getEffectiveContent` 的 coreSenses；`coreSensesKey`（按 label）作为 effect 稳定依赖，避免反复重置 loading；8s `withTimeout` + 错误+重试兜底，不永久卡 loading。
- 行点击编辑器回填：已保存助记优先，否则回填未应用的 AI 建议（`senseEditorInitialText`）。
- 面板头部重排：操作 2 列（AI 生成全部/批量生成，按钮 nowrap）、覆盖开关独立行、进度+并发状态卡、统一间距/按钮高度。

### 3.4.40 本义助记并发生成/行点击编辑（task-203，0.3.67）

- 「AI 生成全部」改为受控并发 2–4（Stepper），一次提交 batch + `onProgress` 逐本义刷新「生成中/成功/失败」与总进度；`AbortController` 取消 1–2s 生效；单条 30s 超时+自动重试一次；结束汇总；不阻塞其它按钮。
- 去掉每项「编辑/保存/删除」按钮，本义助记整行可点（`button` + aria-label）打开编辑弹窗：textarea + 保存/删除/重新生成；空行也显示「点击添加本义助记」。
- 面板打开显示「正在加载本义助记…」，避免异步加载期间误显示空态；加载后按 `listSenseMnemonicViews.current` 回填已有助记。

### 3.4.39 AI 补内容面板重设计 + modal 手势禁用（task-202，0.3.66）

- 手势：`useStudyPanelGesture` 内部 `hasBlockingModal()` 检测 `.mm-mask/.mm-dialog/[role=dialog]/.batch-derivation`，pointer/touch start/move 均 return；任何弹层打开时右页不再被滑动调宽，关闭后自动恢复。
- AI 面板展示层重设计（不动业务逻辑）：`ai-generate-form`，草稿独立 `ai-draft-card`（继续/放弃横排），范围/上限/类型/排除/模式/预算分组 `ai-section` 卡片；选项统一 `.ai-chip-grid` 2 列 + `.ai-chip`（font13、min-height34、选中**描边+淡色底+✓**，不再大面积实心绿）；模式行 `ai-mode-row`；底部 `ai-generate-actions` sticky，与滚动内容分离。
- 390 深色：chips 2 列/文字正常换行不竖排；测试覆盖结构、选中态、sticky、2 列/字号/描边断言。

### 3.4.38 草稿放弃后无法重新生成（task-201，0.3.65）

- 根因：`handleStart` 对「完成草稿/待继续草稿」两个守卫早退时只设 summary，未释放 `startLockRef`，后续开始生成永远被锁；放弃草稿只清 draft state，未清 pending/items/summary/error/progress 与锁。
- 修复：守卫早退释放 startLock；放弃草稿清空 draft/pending/items/selected/summary/error/progress 并释放锁，之后可立即对当前词重新生成。

### 3.4.36 注释面视觉 P3（0.3.64）

- ActionBar 三按钮（记忆/生成式记忆/加权记忆）：`flex:1 1 0; min-width:0; padding 0 8px; font-size:14px; white-space:nowrap; word-break:keep-all`，390 宽下「生成式记忆」不换行。
- 注释面含义行右侧留 28px 给「‹ 引申」悬浮按钮；nc/不常考徽标移到中文前（`meaning-cn-text` 之前），避免贴右缘被遮挡。

### 3.4.35 生成元/4 阶段/不常考（task-197）

- 生成式记忆 4 阶段：P1 映射页（去计数，`下一步`）；P2 与 w-c 一致的垂直居中卡片（`.wc-card` 复用：word 大号/↓/rootLabel 大号/第一段小字），卡片内显示共享「映射助记：…」，卡片下方「AI助记·生成元映射」+ `x/n` 与 w-c 小圆点，点击屏幕任意非按钮区域计数；P3 原选 nc；P4 关系页新文案「请记忆、默背…（尤其是 nc）」；标题 `阶段 n/4`。
- 注释面：`w ↓ rootLabel` + 第一段（无数据隐藏；有 label 无 text 仍显示映射行）、映射助记展示/编辑；阶段2 与注释面共享同一 `rootMnemonicText`。`MeaningRow` 增加「不常考」badge + 点按切换。
- 白板面：`nc × N` + 词性/含义列表；无 nc 不渲染。
- `AI 补内容` 新增「批量标记不常考含义」入口（今日单词分块生成、进度/停止/失败重试、预览勾选后应用）。
- 边界：若某词全部 c 都被标为不常考且 `hideRareMeanings=true`，session 回退为全部 meanings（`meaningsForMemory`），不会产生 0 个 c；加权记忆 totals 基于同一 session 词，自动一致。
- 注释面新增「AI 标记不常考」：当前词调用 `generateRareMeanings`，结果先预览（可逐个取消勾选）再应用；已有标记保留，空结果提示「没有需要标记的含义」。
- `RareMeaningsBatchPanel` 支持范围「当前词 / 今日计划 / 当前词库」（词库最多 200，切换重置进度）；一次提交全部候选，`concurrency` 2–4（默认2），消费 `onProgress(done/total/succeeded/failed/inFlight)` 显示进度条；单条 30s 超时自动重试一次、外部 Abort 后 UI 立即进入「已停止」（按钮/范围恢复），服务收尾补最终统计；失败项仅重试失败项；空结果提示「没有需要标记的含义」，无 Key/成本上限/取消分别提示。
- 手动「不常考」按钮移出含义行按钮（`.rare-toggle-btn` 独立 button，aria-label/aria-pressed 正确，不触发「标记不熟悉」）。
- 我的→数据：导出学习进度默认**轻量**（不含引申图/内容包）；新增次级「完整备份（含引申图/内容包，体积大）」点击先弹确认（体积大/可能较慢/内存有限），确认后 `exportMigration({includeDerivationMaps:true,includeContentPacks:true,maxBytes:FULL_BACKUP_MAX_BYTES(20MB)})`——超限在数据层估算后直接取消并提示，不构建大字符串；建议改用「导出学习进度 + 导出全部引申图 + 内容包导出」分项备份；导入 hint 说明兼容轻量/完整包且轻量包不清空本机引申图/内容包。
- 设置→学习 `study.hideRareMeanings`（默认开）；`useStudySession` 的记忆/加权记忆 session 按该设置过滤 rare 含义，注释面仍用 Word 全量 meanings。
- 生成式记忆设置文案对齐 4 阶段：点击次数=「阶段 2（居中映射页）…进入阶段 3」、每屏含义数=「阶段 3」、生成元字号=「阶段 2 居中映射页」、Mermaid=「阶段 1/4 显示；阶段 2/3 隐藏」。


- watchdog 降到 **30s** 无进度即 abort+收尾。
- 首批失败项**自动重试一次**（面板显示「自动重试 1/1」），仍失败才进入最终失败列表，可手动「重试失败」；自动重试同样受 watchdog 约束。
- 进度显示「已完成/总数 + 成功/失败 + 当前请求数（min(并发, 剩余)）」；连续 ≥2 个 `AI_TIMEOUT` 提示「建议把并发降到 2」。
- tests/ui：30s 边界、超时收尾总数守恒、自动重试/停止/进度源码路径。

### 3.4.33 批量生成超时/重试收尾（task-192）

- 批量面板增加 60s 无进度 watchdog：任一 AI 请求挂起不返回时自动 abort 并收尾，`总数 = 成功 + 失败 + 跳过`（`summaryStuckRun` 把未成功项列入失败并给「AI 请求超时（未返回，可重试）」）。
- 每次开始/重试重置进度、成功集合、摘要、错误；「重试失败」只重跑失败项；「停止」立即 abort 并收尾，可再次重试；`onSaved` 成功后记录成功集合用于超时收尾。
- tests/ui：watchdog 边界、42 词 40 成功 2 超时收尾、重试/停止源码路径断言。

### 3.4.32 右页滑动灵敏度设置（task-191）

- 设置 → 外观新增「右页滑动灵敏度」滑块（`derivation.swipeSensitivity`，0.2–3.0，步 0.1，默认 1.0=1:1），显示当前 × 值；写入 `updateSettings` 并 clamp。
- StudyPage 读取设置并作为 `sensitivity` 传给 dev-algo 手势 hook（`readSwipeSensitivity(settings)`），返回学习页立即生效。

### 3.4.31 用户文案 c →「含义」（task-189）

- 「用法」三段与「我的→使用说明」推荐工作流统一：`各个 c`→`各个含义`、`c 的例句`→`含义的例句`、`那些 c`→`那些含义`、`各个实际含义 c`→`各个实际含义`；nc 首次出现保留「不容易理解出真实指代的含义（记为 nc）」。
- 其它用户可见提示：加权记忆设置「每个含义」、助记占位「单词→含义」、AI 选义 aria-label「选择含义 N」；内部注释/代码标识不变。

### 3.4.30 Mermaid 全屏时隐藏拖拽手柄（task-183）

- `MermaidPreview` → `DerivationPanel` → `StudyPage` 通过 `onViewerOpenChange` 上报查看器开合；查看器打开时 StudyPage 不渲染 `.derivation-resize-handle`，关闭后恢复；与右页全屏/用法弹层同一套手柄隐藏逻辑。

### 3.4.29 用法三段/原理折叠（task-182）

- 「用法」弹层补齐三段：①生成元代入各含义例句体会真实指代；②生成元忘记时可由已记住的含义反推生成元；③推荐工作流（映射→引申→代入例句找 nc→记忆生成元到 c/nc 关系网络）；可滚动、完整换行。
- 我的「原理」改为 `<details>` 点击展开：展开后首行「原理：」+ 三条无序列表圆点（核心义代入语境/可引申各含义/只需记核心义且忘记可从实际含义反推），原文完整换行。

### 3.4.28 生成式阶段1误计数 + 保存反馈（task-181）

- 阶段1只有 `.generative-tap-zone`（提示/word→生成元/文字）计入点击；Mermaid、AI/保存按钮、全屏查看器、弹层不在计数区；阶段2/3无计数。
- 保存/失败在浮层内显示 `generative-feedback`（sticky 底部，高 z-index），不再只依赖可能被浮层遮挡的全局 toast。

### 3.4.27 生成式记忆重叠/阶段回退 + Android 左滑修复（task-179/180）

- **生成式记忆**：打开时自动收起右页/全屏/用法；阶段重置 effect 依赖只保留 `[open, word, initialPhase]`，nc 保存导致的 `initialNc` 变化不再把阶段 3 重置回阶段 1；阶段 3 正确显示「请记忆下述生成元…」+ word→生成元 + AI 文字 + nc + Mermaid。
- **左滑手势**：annotation body/wrap `touch-action: pan-y` + `overscroll-behavior-x:none`；pointerdown `setPointerCapture`；新增 touchstart/touchmove/touchend fallback；打开阈值降到 24px，跨阈值当帧固定 50% 并**重置起点**，之后才按相对位移继续调宽（不再整段 dx 算宽度）。
- headless（CDP touch，390×844）：左半页 100px 左滑打开右页 265px（≈68%），无 pageerror；gen 流程验证打开后右页消失、阶段 1→2→3 正确。

### 3.4.26 滑动调宽改相对位移（task-175）

- `useSidePanelSwipe` 不再用绝对指针位置换算宽度：pointerdown 记录起点（未开=50/已开=当前），pointermove `width = clamp(startWidth - dx/vw*100)`，左半页任意位置起手都不会突增到 70–80%；把手同逻辑（`derivationWidthFromDrag`）。

### 3.4.25 P0 学习页黑屏修复（task-174）

- 根因：task-172 新增的原生返回键 `useEffect` 被放在 `study.phase === 'loading'` 等 **early return 之后**，loading→ready 时 hooks 数量变化，React 抛错导致只剩 root（黑屏）。已把该 effect 移到所有 early return 之前。
- 新增 `src/app/ErrorBoundary.tsx` 并包裹 AppProviders：渲染错误显示「页面渲染出错」+ message/stack + 重试/回首页；`componentDidCatch` 与全局 `error`/`unhandledrejection` 记录到 `window.__mmLastError`，不再纯黑。
- tests/ui：ErrorBoundary 正常渲染/回退文案/全局记录；源码断言 native-back hook 必须在 loading early return 前。
- **旧 SW 缓存**：`app/swUpdate.ts` 在版本变化（`mm.appVersion` 不一致且 SW 已控制页面）时自动注销全部 SW、清 caches 并重载一次；`main.tsx` 使用 `virtual:pwa-register` 的 `onNeedRefresh → updateSW(true)` 自动更新，避免旧 chunk + 新 HTML 混用导致 React #310。

### 3.4.24 批量生成引申图（task-170 F11）

- 入口：我的 → 数据 →「批量生成引申图」，全屏面板；不自动调用 AI。
- 选词：今日要学 / 词库（词库选择、关键词搜索）；「排除已生成过引申图」默认开；候选列表多选/全选当前筛选；上限 200（超出提示）。
- 生成前：显示已选数量、预计调用次数、并发 1–4（默认2），确认弹窗后执行。
- 执行：`generateDerivationMapsBatch` 并发调用，进度 `done/total`、停止（AbortController）；`onSaved` 对每个成功词 `saveDerivationMap({...result,source:'ai'})`（含 lines，不覆盖 nc/用户内容）；失败继续并记录原因。
- 结果：成功/失败/跳过摘要 + 失败词列表/原因 +「重试失败」；断点在同一批内已成功不重复。
- 纯函数 `filterBatchCandidates`（前缀优先）、`batchSummaryText`；tests/ui 覆盖过滤/摘要/入口。

### 3.4.23 w-c 显示 AI lines 行（task-173）

- 右页保存 `derivationMap` 时必须带 `lines`（原来只存 rootLabel/text/mermaid，导致 w-c 无当前 c 行）；保存后同步回填 `derivationContents.lines`。
- w-c 卡片在中文 c 下方直接显示当前 c 命中的 `lines` 行（`meaningIndexes` 1 起匹配 Word.meanings 下标），旧数据无 lines 不显示。
- 「保存」按钮增加 `保存中…` 状态与成功/失败 toast；`saving` 由页面状态驱动。

### 3.4.22 真机返回键 + 右页初始 50/50（task-172）

- **系统返回键**：新增 `lib/native-back.ts` 注册 `window.__mmHandleBack`（APK MainActivity 优先调用）；Mermaid 全屏查看器注册最高优先级（关闭查看器 return true）；StudyPage 依次消费 生成式记忆/局部词/用户编辑/删除确认/用法弹层/全屏/右页；未消费返回 false 走系统。保留浏览器 `popstate` 兼容。
- **初始 50/50**：每次点「引申」/滑开右页均重置为 50%，不读取上次持久化；拖拽仅本次会话（不再写 localStorage）。

### 3.4.20 w-c 生成元/行映射、nc、局部词与引申图导入导出（task-166）

- **w-c**：顶部显示当前 w「生成元：…」，当前 c 若 `lines.meaningIndexes` 命中则显示对应 `- ` 行；nc 含义显示「nc」徽标；旧数据无 lines 仅显示生成元不报错。
- **nc**：注释面每个 c（`MeaningRow`）与 w-c 当前 c 显示 nc；右页文字底部列出当前 w 的 nc 中文；数据由 `getNcMeaningIds` 加载。
- **局部词**：点击注释面单词 → `SubwordDialog`（`findSubwordMeanings`），显示 headword/词性/中文；无结果提示。
- **当前词 JSON**：右页「导出 JSON」`buildDerivationJson` 下载 `<word>-derivation.json`；「导入 JSON」`parseDerivationJson` 校验后 `saveDerivationMap`（含 lines）并立即刷新/回文字模式，错误 toast。
- **整库 bundle**：我的 → 数据新增「导出全部引申图」`exportAllDerivationMaps`（`wordc-derivation-bundle` v1）与「导入引申图」`parseDerivationBundle`+`importDerivationBundle({mode:'merge'})`，toast 显示 imported/skipped/failed；缺失词跳过、不覆盖 nc/用户内容/进度。

### 3.4.19 0.3.48 第一批修复（task-163）

- **AI 助记显示（A1）**：`useStudySession.mnemonics` 直接由 `Word.mnemonics` + `visibleMnemonics`（hidden 过滤、用户副本覆盖）同步计算，AI apply/`reloadCurrentWord` 后注释面与对应 c 行立即可见并标「AI」；不再依赖异步 merged 列表。
- **Markdown 圆点（A3）**：`.derivation-markdown ul/ol` 显式 `list-style: disc/decimal outside` + 缩进/嵌套 circle，`li` 显式 `list-item`。
- **默认文字模式（A4）**：点「引申」/滑开/载入 map 均不自动切 Mermaid；仅用户点 Mermaid 才切换。
- **Mermaid 全屏返回键（A5）**：查看器打开 `history.pushState({mmMermaidViewer:true})`，`popstate` 只关闭查看器并回到原状态，不触发路由回首页。
- **手柄层级（A6）**：右页全屏或「用法」弹层打开时 `.derivation-resize-handle` 不渲染（不可调控）。
- **默认 50/50（A6）**：`DERIVATION_WIDTH_DEFAULT=50`，首次打开各 50%；之后拖拽并持久化。
- **任意位置滑动（A7）**：`useSidePanelSwipe` 在注释面任意位置识别水平手势，左滑打开；打开后同一手势按**相对起始位移**实时调宽（30–75%，从当前宽度起算，不按绝对指针位置跳变），纵向滑动保留（`touch-action: pan-y`）。
- headless 自检（390×844）：打开 panel/wrap 各 195px、模式「文字」；在左栏内容拖动 50px → 右页 75%/左栏 25% 且持久化；用法弹层打开手柄数 0、关闭恢复、全屏 0；`document.scrollWidth==390`。截图 `docs/assets/e2e/f163-open-390.png`。

### 3.4.18 右页文字轻量 Markdown（task-162 F10）

- F8 右页「文字」模式支持安全 Markdown 子集：段落/换行、**加粗**、*斜体*、`行内代码`、# 标题(1–3)、-/* 无序列表、1. 有序列表；链接/原始 HTML 一律按纯文本（React 文本节点构造，无 `dangerouslySetInnerHTML`，防 XSS）。
- 设置 → 外观新增「右页文字 Markdown 渲染」开关（`derivation.markdown`，默认开）；关闭回退纯文本 `pre-wrap`；编辑框始终显示源码，AI/保存/Mermaid 行为不变。
- 组件：`src/ui/study/components/DerivationMarkdown.tsx`；设置读取 `src/ui/study/lib/derivation-markdown.ts`。

### 3.4.17 分栏宽度同步/说明长段落/Mermaid 模式保持（task-155/156/157）

- **task-155 宽度同步**：左栏与右页共用同一 CSS 变量（`.study-page` 内联 `--derivation-panel-width`），左栏 `width: calc(100% - var(--derivation-panel-width))`，拖拽 pointermove 同时写变量与 state；75% 时左栏 25% 仍 `scrollWidth<=clientWidth`、无横向文档溢出、右页不覆盖左栏；60/70/75 自检截图 `docs/assets/e2e/f9-width75-360.png`。
- **task-156 使用说明截断**：引导段去掉 `mm-row-sub` 3 行 clamp，改为 `mm-caption usage-guide-note` + `display:block; white-space:normal; overflow:visible; -webkit-line-clamp:unset`，卡片随内容增高；360/390 与 1.6× 字号下 `scrollHeight==clientHeight`、末句完整（截图 `me-usage-360.png`）。
- **task-157 AI 不切模式**：右页模式受控于页面状态；`mergeGeneratedDerivation` 只合并 text/mermaid/rootLabel，永不改 `mode`；当前模式无结果时显示「尚无文字内容/Mermaid 内容：点编辑或 AI 生成」占位，重新生成同样保持。

### 3.4.16 引申副页分栏拖拽/全屏 + 思维导图手势（task-154 F9）

- 分栏：右页 `width: var(--derivation-panel-width)`（30%–75%，默认 46%，`mm.derivationPanelWidth` 本机记忆）；左栏 wrap 宽度 `100% - 宽度`，`min-width:0; overflow-x:hidden` 真 reflow；两栏间 12px 拖拽把手（pointer 拖动实时调整、方向键 ±2%）；`.study-page`/面板 `overflow-x:hidden`，按钮 `flex:0 0 auto; min-width:max-content` + 行内换行，避免文字截断/文档横向滚动。
- 全屏：右页「全屏」→ 隐藏左栏、右页占满内容区（topbar 与三键仍可见）；「退出全屏」恢复原宽度。
- Mermaid：图右上「全屏查看」→ 全屏查看器；双指缩放 0.5–4×、单指平移、双击 1×↔2×、重置/关闭；`touch-action:none` 不误触翻页。
- 自检（headless 360×800 / 390×844）：`scrollWidth==innerWidth`、左 wrap≈54%、右页≈46%、面板内无 `scrollWidth>clientWidth` 元素；拖拽 46→60/59 且 localStorage 已记；全屏宽度=视口、左栏 `display:none`。截图见 `docs/assets/e2e/f9-split-360.png`、`f9-split-390.png`、`f9-fullscreen-360.png`。

### 3.4.15 生成元引申「用法」说明（task-151）

- 右页底部新增「用法」按钮，弹层展示完整说明：把统一生成元直接作为含义代入各实际含义例句，体会真实意思/真实指代/如何实例化到具体场景事物。
- 弹层正文 `max-height:60vh; overflow-y:auto`、完整换行（`white-space:normal; overflow-wrap:anywhere`）；「知道了」/遮罩/Esc 关闭；不影响右页内容与保存。

### 3.4.14 生成元引申副页布局修复（task-150）

- 展开时包裹层 `study-annotation-wrap.is-side` 宽度 `calc(100% - 46%)` + `overflow-x:hidden`，正文真正 reflow/换行不裁；左栏仍可纵向滚动；右页 fixed 于 topbar 下、评分栏上（top 52 / bottom 96）。
- 右页宽 46%（≤300），标题允许换行（`white-space:normal; overflow-wrap:anywhere`）、「收起」按钮 `flex-shrink:0` 不截字；面板自身纵向/横向溢出可控。
- Mermaid：无源显示「尚无 Mermaid 内容：点「编辑」或「AI 生成」」；有源渲染失败回退源码+错误；渲染区可滚动。

### 3.4.13 生成元引申副页（task-147 F8）

- 注释面左滑（pointer dx ≤ -56）展开右侧副页（约 42% 宽）；左栏 `padding-right` 自动变窄重排，长文本换行不裁切；右滑/「收起」关闭；切词自动收起。右缘「‹ 引申」按钮作为入口。
- 右页内容来自 `getDerivationMap(wordId)`：文字模式完整换行；Mermaid 模式按需 `import('mermaid')` 渲染，失败回退源码+错误不阻塞；可切换模式、编辑（生成元/文字/Mermaid 源码）后保存（`saveDerivationMap`，manual）立即生效。
- 「AI 生成」：`loadAiConfig` + `generateDerivationMap({word,coreSenses,meanings})` 只生成预览（编辑器可改），点保存才写入（`source:'ai'`）；失败显示错误、不自动保存。
- 数据：Word.derivationMap 本机字段，随迁移/导出；AI replay 不覆盖人工内容。

### 3.4.12 我的助记展示修复（task-149）

- 注解面词级区与各 c 行直接渲染 `word.userMnemonics`（标「我的」+ 类型），不依赖异步 merged 列表；保存后 `getWord` 刷新立即显示。
- AI/内置助记仍走合并列表（过滤 hidden、用户副本覆盖同 key）；用户助记独立渲染，避免与 AI 条目互相覆盖丢失。

### 3.4.11 使用说明「本义引申」引导（task-145）

- 我的 →「使用说明 · 推荐主流程」在流程句之后、逐页说明之前增加：每次回忆从尽可能单个、最共性的本义出发，再按使用场景/作用对象/词性引申出各实际含义；记忆时先找「生成元」（本义）再引申。
- 文本完整换行（`white-space:normal; overflow-wrap:anywhere`），不改变现有操作。

### 3.4.10 白板面 per-c 信息生效修复（task-144）

- `study.meanings` 的 examples 以 `Word.meanings[].examples` 为准并加入 `word` 依赖，词库/AI 更新后白板与注释同时刷新。
- `.board-stage` 允许纵向滚动、`.board-main` 从顶部排布（去掉 -6vh 居中），含义多/例句多时不再被裁到视口外；F4 词性+英文例句与 F7 英文词组可见。

### 3.4.9 白板面显示各 c 词组（task-143 F7）

- 设置 → 白板面新增开关「白板面显示各 c 词组」（`board.showMeaningPhrases`，默认关，持久化/导出）。
- 开启后白板面每个 c 的词性/英文例句下方显示该 c 的英文词组（`phrase.meaningId === meaning.id`，不显示中文）；无词组不占位；关闭不显示。

### 3.4.8 我的笔记/助记（task-140 F6 + task-141 修复）

- 编辑弹层按目标（w/cX）+ 类型（note/mnemonic）用 `listUserNotes/listUserMnemonics(wordId, meaningId?)` 精确预填；无内容为空；切换目标/类型重置表单与助记类型（弹层按目标 key 重挂载 + open/initial 变化重置）。
- 保存/删除后用 `getWord` 即时刷新，不重建会话/不延迟；用户助记展示改用 `listMergedMnemonics`（AI 过滤 hidden、用户副本覆盖同 key、含用户独有条目），词级与对应 c 行立即显示并标「我的」。
- 白板面 per-c 词性 + 英文例句：session 词含义保留 examples（toSessionWord）+ 词库 Word.meanings 兜底，进入学习即显示，不显示中文。

- 注释面词级「我的笔记/助记」区 + 每个 c 行的「笔记/助记」编辑入口；用户内容标「我的」，AI/内置标「AI」。
- 编辑弹层：目标（单词/cX 中文）、多行文本、助记类型（联想/谐音/词根/词源/串记/口诀/其他）、保存/删除/取消；保存后立即刷新（reloadCurrentWord），不改学习进度。
- AI/内置助记可编辑（保存为用户副本并隐藏原 key）或删除（仅隐藏，不删 AI 包数据）；隐藏后重应用 AI 包不恢复。
- w-c 页当前 c 只读展示用户笔记/助记（无编辑入口）。

### 3.4.5 w-c 信息增强 + 加权记忆（task-136 F1/F2）

- **F1 w-c 信息区**：当前 c 卡片下方（不触发 +1）显示例句（en+cn，最多 3）、该 c 助记、不熟悉度条+百分比、排名「第 X / N 不熟悉」；无数据不占位。
- **F2 加权记忆**：注释面「记忆」旁新增「加权记忆」（次级样式）；流程与普通记忆一致，per-c total = `weightedMemoryTotals(base, familiarity, {memory.weightedMin/Max/K})`；计数/点阵/完成按 per-c weighted total（`memoryTotalForMeaning`）。普通「记忆」仍用固定 `memory.totalRepeats`。

### 3.4.6 白板面各 c 词性 + 英文例句（task-136 F4）

- 白板面单词下方按 c 分组显示词性 + 该 c 英文例句（**不显示中文**），最多数量沿用 `board.exampleCount`；无数据不占位。
- 长文本换行，不泄露中文答案。

### 3.4.7 长文本/裁切修复（task-136 B1/B4/B5）

- B1：注释面/审核框/w-c 助记与内容完整换行，不 clamp/省略（`.mm-review-line`/`.meaning-mnemonic`）。
- B4：本义链（`.derivation-chain`）完整换行、不裁切。
- B5：注释面本义区左右 ≥16px 安全内边距，窄屏/大字号不裁字。

### 3.4.4 注释面本义列表（task-98）
1. 注释面单词/音标下方、含义列表上方显示「本义1「label」/ 本义2「label」…」（来自 `getEffectiveContent().coreSenses`）；无 coreSenses 不显示区块。
2. 每个本义三层渲染：`本义N「label」` → gloss/note 小字下一行 → 有 origin 时单独一行「词源：…」；旧 v3 违规 label（>6 字/含 是否/看/检查/源自/语言名/箭头）显示「本义待重新生成」+ 原标签小字灰显。
3. 每个 c 行下方继续显示对应的「本义N「label」→ steps」链，**不折叠、不去重**。
3. 样式紧凑 12px 次要色、可换行；深色模式自动适配；点击本义行无操作。

### 3.4.3 本义→引申链（task-77）
1. 注释面每个含义行下方显示小字：`本义{①/②/③/④} 「{coreSense.label}」→ steps…`（序号取 `meaningMap.coreSenseIndex`，>4 显示 `(N)`，旧数据回退 ①）（v4 label 与 steps 分离；v3 无 label 时回退 steps[0]）；无映射不显示；11–12px 次要色，不挤压三键/记忆按钮。
2. w-c 记忆页当前 c 下方显示当前本义链，切到下一个 c 时即时更新。
3. 链来自 AI 生成内容时，链尾显示「（AI 推演，仅供参考）」。
4. 长文本自动换行（`overflow-wrap:anywhere`），360px 宽不溢出。

### 3.5.0 每日复习上限（task-52）
1. 设置页 →「每日复习上限」：不限（默认）/50/100/200/自定义；保存后回首页。
2. 有大量到期复习时：首页出现「另有 X 个到期复习，今日上限 Y 个，将顺延」；`/today` 复习区出现「其余 X 个将在之后复习」。
3. 上限只限制自动入队：超出部分不丢失（明天仍到期）；今日新学预算 = 学习量 − 今日入队复习数。

### 3.5.1 每日学习量（task-27 + task-35 实时同步）
1. 设置页 → 学习设置 → 每日学习量 → 数字输入框（1–9999）；输入 `0` / `-1` / `1.5` / `abc` → 中文提示且不保存。
2. **改大**（如 30 → 50）：toast「已按新学习量调整今日计划：+20 词」；回首页「今日 X/50」「待新学/剩余」立即变（useLiveQuery，无需重进）。
3. **改小**（如 50 → 10）：toast「…：-N 词」；只移除队尾未学新词，**当前词/已评分/复习/回炉词不删**；首页总数与学习页「当前/总数」同步变小。
4. 减到 ≤ 今日复习数：提示「（复习已占满目标，今日新学为 0）」，复习词仍全量保留。
5. 学习页 ⋮ →「记忆设置」也可改学习量：重算后数字刷新，**当前 w-c 次数/注释面状态不打断**；今日无 plan 时只保存设置（提示「今日暂无计划需要调整」）。

### 3.6 多义项 / 长释义（375–390 宽）
1. 打开含义被拆成多条（最多 12 个 c）的词（如 embrace）：注释面逐条显示，整行高度自适应，无横向滚动条。
2. 长中文释义自动换行（不截断、不溢出）；右侧 `clicks/encounters` 与百分比不换行、不上浮错位。
3. 上滑可看到全部 12 条；底部操作区固定不遮挡最后一条（内容区预留 150px + 安全区）。
4. w-c 页：中文 c 超长时自动降字号并最多 3 行省略，不横向溢出。

### 3.7 深色模式 / 动效 / 视口
1. 设置页把主题切到「深色」→ 学习页三态均为深色：背景 `#101312`、卡片 `#1A1E1C`、单词青绿提亮；不出现白底块。
2. 系统开启「减少动态效果」或设置里打开「减少动效」→ 学习页切换无动画（时长 1ms）。
3. 375×667 与 390×844 下检查：白板单词不横向滚动；w-c 中文超长自动降字号不溢出；三键宽度均分不换行。
4. 键盘（桌面调试）：Space/Enter 推进白板面与记忆页；Esc 弹退出确认。

## 4. 自动化测试

- `tests/ui/study-components.test.ts`（vitest + `react-dom/server`，21 个用例）：


- 白板面：只显示单词/英文例句、不出现中文；音标缺失/开关关闭时隐藏；例句按 `exampleCount` 截断；目标词高亮。
- 注释面：含义行/百分比/`clicks/encounters`/0-0 显示 `—`；例句翻译/助记/词组；`showPhrases=false` 时词组隐藏。
- 记忆页：w/c 文案、`2 / 3` 次数与点阵；`fontScale` 影响字号（36→43px@1.2）；词组开关；无数据不渲染词组块。
- 操作区：三键文案、锁定 disabled；完成页/空状态文案与入口。
- 不熟悉度展示映射：null/0/边界 20%/40%/60%/80%、宽度下限 2%、百分比取整。
- 词性MaiMemo化：`[名]/[动]/[形]/[词组]`、组合词性去重、未知原样；12 义项 + 长释义全部渲染。
- 记忆按钮永不禁用；三键「下次出现」副标题渲染（3 个 rating-sub）与缺省降级；主标签可切换（不确定/忘记）。
- `tests/ui/pos-label.test.ts`（5 用例）：词性映射表逐条、大小写/点号归一、组合去重、未知原样。
- `tests/ui/next-hint.test.ts`（16 用例：v2 五档表 + face/cat/yellow 三条真机序列 + 首评 K=80 快照；回炉 20pp 快照显式传 `progressModelMode:'v1-20pp'` 作 A/B 回滚覆盖）：官方三分支逐字断言（`80 天后` / `今日 / 20 天后` / `今日进度60%/40%/20%`）、隐藏间隔时「今日」/进度、三键独立格式化；**core 数值快照**（新词 d=1/2/3/5/10 → 认识 63/44/33/21/10 天后、不确定 今日/3/2/2/2/1 天后、不认识 今日/1 天后；回炉 P=20%→60/40/20%、P=40%→80/60/40%、P=80%→认识 1 天后/模糊 80%/忘记 80%）；旧 previewNext 兼容文案与非法天数兜底。
- `tests/ui/rating-labels.test.ts`（7 用例）：首次「认识/不确定/不认识」、之后「认识/模糊/忘记」、labelSwitch 关闭回退旧文案、isFirstShow 判定、官方设置项默认值/兼容层。
- `tests/ui/daily-goal.test.ts`（5 用例）：1/9999 边界、>200 合法、0/负数/小数/非数字/空非法、超大数提示。

- `tests/ui/daily-goal-change.test.ts`（7）：mock data 的 resync 调用/文案（+N/-N/新学 0）/无 plan/异常/非法值。
- `tests/ui/daily-goal-resync.test.ts`（4，真实 data）：改大追加、改小删尾部且当前词保留、复习占满新学=0、重算不影响 w-c 快照。
- `tests/ui/plan-flow.test.ts`（fake-indexeddb，6 用例）：plan 驱动续学（同 plan 不重排）、首页 fresh→ongoing→done 状态机、回退浏览不改数据、撤销 index 回退、改判 correctedBy 关联。
- `tests/ui/home-state-view.test.ts`（7）+ `home-task-card.test.ts`（6）：首页 6 态文案/按钮/KPI/进度渲染。
- `tests/ui/swipe-back.test.ts`（5）：右滑阈值 64px、方向锁定、阻尼位移、NaN 安全。
- `tests/ui/study-flow.test.ts`（fake-indexeddb，8 个用例）：用真实 core+data 驱动整条学习链路：
  队列分配 → createSession → encounters/clicks 写入 → 顺序模式 w-c 全满回注释面 → 快照保存/恢复/删除 →
  记忆完成后重开一轮（counts 归零、不重复记 encounters）→ random 模式新语义（立即重随机/needsAdvance 恒 false/最后一次直接回注释面）→
  `predictAll` 官方三键文案（认识 progress=1 →「N 天后」、模糊/忘记 →「今日 / N 天后」、隐藏间隔 →「今日」）→
  submitRating 返回 requeue 且状态落库。
- `tests/ui/pages-smoke.test.ts`（SSR，9 个用例）：8 条路由 + 404 在 Provider/Router 中渲染不抛错，
  且学习页无底部 Tab、关于页含 D11 算法表述与 D30 版权声明。

> 说明：项目未安装 @testing-library（D35 只批准 fake-indexeddb），因此 UI 测试采用服务端静态渲染断言 + 纯函数/集成测试；交互链路按上方手工步骤验收。

## 5. 已知问题 / 边界

1. **词库数据无音标/词组时**（商业词表与大纲词表当前均为空）：白板面/注释面不显示音标行、w-c 页无词组块，均符合 D32/D33，不是 bug。
2. **路由已接线**：`src/app/router.tsx` 的 `/study` 指向本页；学习页为沉浸式全屏（`position: fixed`），底部 Tab 不渲染（D38）；旧 `src/ui/pages/*` 占位页已删除。
3. **剪贴板/语音合成**：`speechSynthesis` 在部分 Android WebView/Chrome 上首次发音可能延迟；无可用语音时 toast 提示。
4. **随机模式不连续同 c**：由 core 的 `advanceMemory` 保证；若未来 core 改动，UI 无需变更。
5. **记忆页顶栏 ×** 按研究 §5.3 实现为「退出记忆并回注释面」；退出整个学习用 `⋮ → 退出学习`。SPEC §4.1 的「×=退出确认」在注释面/白板面成立。
6. 会话内 `wcCompletedOnce` 只用于提示；完成后再次点「记忆」会重开一轮（次数归零），不再锁死入口。
7. 词性MaiMemo化本次只落在学习页（task-18 写入范围 src/ui/study/**）；词库详情页等仍显示原始词性，如需统一可复用 `lib/pos-label.ts`（task-10 页面，另行处理）。
8. 三键「下次出现」已接 `core.predictAll`（dev-algo task-26，官方 `Predict{first,days,progress}`）；旧 `previewNext` 仅保留兼容，UI 不再使用。
9. 「允许模糊完成复习」「预计复习间隔」的**业务语义**在 core/data 侧（队列/评分/预测），UI 只负责设置项读写与展示；本页验收以「设置可改 + 学习页副标题实时变化」为准。
10. 首页「继续学习」、plan 驱动续学、滑动回退/改判已在 task-30 完成（plan API 由 data task-28/29 提供）；改判为**扩展行为**（官方仅确认可回退查看），UI 文案已提示。

- 0.3.35/F2：注释面「加权记忆」按钮用当前 c 不熟悉度计算 total；设置项 `memory.weightedMin/Max/K` 生效；普通「记忆」不变。
