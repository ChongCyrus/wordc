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

1. **词库数据无音标/词组时**（受限商业词表与大纲词表当前均为空）：白板面/注释面不显示音标行、w-c 页无词组块，均符合 D32/D33，不是 bug。
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
