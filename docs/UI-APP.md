# UI-APP · 其余页面 + PWA 外壳实现说明与手工验收（task-10）

> 产出：dev-ui ｜ 依据：`docs/SPEC.md` §8/§9、`docs/DECISIONS.md`（D12–D19/D30–D40/D47）、`docs/research/03-ui.md`、`src/app/styles/tokens.css`
> 范围：`src/ui/home|decks|stats|me/**`、`src/ui/components/**`、`src/app/**`、`public/icons/**`、本文件。
> 学习界面（task-9）见 `docs/UI-STUDY.md`。

## 1. 页面 / 组件 / 路由清单

### 1.1 路由（`src/app/router.tsx`，唯一事实来源）

| 路由 | 页面文件 | 底部 Tab | 说明 |
|---|---|---|---|
| `/` | `src/ui/home/HomePage.tsx` | ✅ 首页 | 今日任务仪表盘（D19）+ **6 态「开始/继续学习」**（SPEC-v2 §6.2，task-30） |
| `/study` | `src/ui/study/StudyPage.tsx` | ❌（沉浸式全屏） | 学习三态（task-9） |
| `/decks` | `src/ui/decks/DecksPage.tsx` | ✅ 词库 | 词库列表/新建/重命名/删除/导入/MaiMemo导入 |
| `/decks/:deckId` | `src/ui/decks/DeckDetailPage.tsx` | ❌（二级页） | 单词列表 + 搜索 + 筛选 + 增删改 |
| `/today` | `src/ui/today/TodayPage.tsx` | ❌（从首页「查看今日单词」进入） | 今日单词：复习/新学分区、planned/learned、评分/未学/加学/回炉标签、单词详情（task-50） |
| `/stats` | `src/ui/stats/StatsPage.tsx` | ✅ 统计 | 概览/反馈分布/14 天柱状图/不熟悉度 Top5 |
| `/me` | `src/ui/me/MePage.tsx` | ✅ 我的 | 资料卡/数据入口/深色开关 |
| `/me/settings` | `src/ui/me/SettingsPage.tsx` | ❌ | SPEC §5 全部设置项 |
| `/me/about` | `src/ui/me/AboutPage.tsx` | ❌ | 版本/算法说明（D11）/版权（D30）/许可 |
| `*` | `src/ui/components/NotFoundPage.tsx` | — | 404 |

- 底部 Tab = **4 个**：首页 / 词库 / 统计 / 我的（D38）；`src/app/routes.ts` 的 `TAB_ITEMS` 与 `tabForPath()`：一级页精确匹配、`/decks/:id` 归属词库 Tab、`/me/settings` `/me/about` `/study` 无 Tab。
- 路由测试：`tests/routes.test.ts`（5 用例，已按 SPEC §8.1 同步断言）。
- 旧占位页 `src/ui/pages/*`、`src/ui/components/PagePlaceholder.tsx` 已删除。

### 1.2 通用组件（`src/ui/components/`）

| 组件 | 用途 |
|---|---|
| `PageShell` | 页面容器 + 顶栏（标题/返回/右侧操作） |
| `SectionBand` | 通栏灰带分区标题（32px）+ `Card` 白卡 |
| `Buttons` | `Button`（primary/soft/ghost/danger，44/48）、`IconButton` |
| `SegmentedControl` | 分段控件（全部/已学/未学、默认/随机、主题三选一） |
| `Stepper` / `Slider` | 数字步进（默认 1–10）/ 滑杆（松手才写库） |
| `Switch` | 青绿开关 |
| `SettingRow` | 设置/列表行（值/控件/chevron/危险态） |
| `Sheet` / `ActionSheet` | 底部弹层 / ⋮ 操作菜单 |
| `Dialog` / `ConfirmDialog` | 对话框 / 二次确认 |
| `EmptyState` | 猫头鹰空状态 |
| `StatChart` | 纯 SVG 柱状图、CSS 堆叠条、文字图例（不引图表库） |
| `icons` | 线性 SVG 图标（24×24 / 1.5 描边，无 emoji） |
| `NotFoundPage` | 404 |

### 1.3 全局外壳 / 状态（`src/app/`）

| 文件 | 职责 |
|---|---|
| `layout/AppShell.tsx` | 内容区 + 4 Tab + 沉浸式模式；启动时 `ensureBuiltinDecks()` 幂等种库 |
| `routes.ts` | 导航元数据（路径/标题/图标/是否 Tab） |
| `theme.tsx` | 外观渲染通道：settings 表 → `data-theme` / `--mm-font-scale` / `data-reduce-motion` / `<meta theme-color>` |
| `toast.tsx` | 全局轻提示（`useToast()`：`show/error/success`，1.6s 自动消失） |
| `providers.tsx` | ThemeProvider + ToastProvider |
| `styles/tokens.css` | MaiMemo风设计 token（浅色 + 深色；**唯一一套主题变量**） |
| `styles/global.css` | 基础样式 + 外壳 + 通用组件样式（全部引用 `--mm-*`） |
| `hooks/` | 共享数据 hooks（见 §2） |
| `utils/files.ts` | 下载/读取文件、时间格式化 |

`src/app/store.tsx` 的占位 SettingsProvider 已删除（设置唯一事实来源 = Dexie settings 表）。

## 2. 共享数据 hooks（`src/app/hooks/`）

| Hook | 数据来源 | 用途 |
|---|---|---|
| `useSettings()` | `getSettings/updateSettings` + `useLiveQuery` | 设置读写；改动自动重渲染（学习页实时生效） |
| `useDecks()` / `useDeck(id)` / `useDeckProgress(id)` / `useDecksWithProgress()` | data 词库 repo | 列表/详情/进度 |
| `useStudyProgress()` | `getTodayQueue` + `getDeckProgress` + settings | 首页「当前词库 / 打卡」辅助数据 |
| `useHomeStudy()` | `getHomeStudyData()` + `core.deriveHomeState()` | 首页学习按钮 6 态（fresh/ongoing/done/…）与「继续学习」（task-30） |
| `useSettings()` | settings 表 | 每日学习量、预计间隔、允许模糊完成、标签切换等 |
| `useStatsOverview()` / `useDailyStats(days)` / `useUnfamiliarTop(n)` | data stats repo | 统计页 |
| `useSettingValue(key, fallback)` | settings | 单值读取 |

规则：UI 不直接写 db；写一律走 data 出口函数；读通过 `useLiveQuery`（SPEC §9.4）。

## 2.1 plan 驱动续学 / 首页 6 态 / 回退改判（task-30）

- **plan 驱动会话**：`/study` 通过 `getTodayPlan({deckId, dailyGoal})` 取当天计划（已存在直接续学、不重排）；
  每次评分走 `rateInPlan`（单事务写 states + reviewLogs + plan，自动按 rating 回炉 gap 4/8）；
  退出/刷新/改设置再进，学习页恢复到同一 `index/wordIds/已学词/回炉位置`。
- **首页 6 态**（`useHomeStudy` = `getHomeStudyData` → `core.deriveHomeState`，`HomeTaskCard` 渲染）：
  | 态 | 文案/按钮 |
  |---|---|
  | no-deck | 「去添加词库」 |
  | no-words | 「去词库」 |
  | fresh | 待复习/待新学 +「开始学习」 |
  | ongoing | 已学 index/共 total · 还剩 N +「继续学习」 |
  | done-with-overdue | 「继续学习（还有 N 个到期复习）」 |
  | done | 「今日已完成」+「查看今日」 |
- **返回上一词 + 改判**（扩展，官方仅确认可回退查看）：
  - 顶栏左 `<`（首词隐藏）+ 单词卡水平右滑 ≥64px（方向锁，避开底部按钮区；记忆页禁用）；
  - 回退只**浏览**（不写库），显示「上次选择：模糊（可改判）」+「不改了，继续」；
  - 点新评分才 `reRateInPlan`（撤销该词今天最近一次 + 按新评分重评），toast「已将「模糊」改为「忘记」，计划已更新」；
  - 首词不可回退、不可跨天、只允许撤销本 plan 当天最近一次。
- **启动清理**：`AppShell` 启动后 `cleanupOldPlans({keepDays: 7})`（幂等）。
- 新增文件：`src/ui/home/HomeTaskCard.tsx`、`src/ui/home/home-state-view.ts`、`src/ui/study/lib/swipe-back.ts`、`src/ui/study/lib/use-swipe-back.ts`、`src/ui/study/components/LastChoiceBadge.tsx`、`src/app/hooks/useHomeStudy.ts`。

## 2.2 APK 内导入导出桥接（task-32，v0.2.8）

- **协议**（arch 的 WebView 壳注入，同步 string）：
  - `window.MomoBridge.isNativeApp(): string` → `"momo-apk"`
  - `window.MomoBridge.saveBase64File(fileName, mime, base64): string` → `"ok:<绝对路径>"` / `"err:<原因>"`（纯 base64，不带 `data:` 前缀）
  - TS 声明在 `src/app/types/native-bridge.d.ts`。
- **导出统一走 `src/app/utils/files.ts::saveBlobFile`**：
  - APK：`Blob → base64 → saveBase64File`，toast「已保存到 下载/WordC/xxx」；**不再触发 blob 下载**。
  - 浏览器/PWA：保持 blob + `<a download>`，toast「已开始下载：xxx」。
  - `err:` 原样提示（Android 9 及以下首次导出会提示「需要存储权限」，授权后再点一次即成功）。
  - 导出文件名统一带日期：`背单词-学习进度-YYYY-MM-DD.migration.json`、`词库名-YYYY-MM-DD.deck.json`。
- **导入统一走 `pickTextFile(accept)`**：标准 `<input type="file">` + `FileReader`（APK 由壳的 `onShowFileChooser` 接管，不使用 `showOpenFilePicker`/File System Access API）。
- **覆盖入口**：词库页（导出词库 / 导入词库 JSON/CSV / 从MaiMemo导入 + MaiMemo文件降级 JSON）、我的页（导出/导入学习进度）、设置页（导出/导入学习进度、Token/代理）。
- **版本**：`src/app/version.ts` = `APP_VERSION '0.2.8'`（与 package.json 一致）单一来源（关于页/我的页/设置页均引用；arch 打 APK 用同版本号；不在别处硬编码）。

## 2.3 每日学习量实时同步（task-35，修复「改设置后今日学习量不变」）

- 设置页 / 学习页快捷设置改「每日学习量」→ 调 `data.updateDailyGoalAndResync(n)`（内部先写 settings 再单事务重算今日 plan；不重复写设置）：
  - 增大：向今日 plan 追加新学词（× 词库顺序，跳过已在 plan）→ toast「已按新学习量调整今日计划：+N 词」；
  - 减小：移除队尾未评分新学词 → toast「…：-N 词」；**复习词/已评分/回炉/当前词不删**；
  - 减到 ≤ 今日复习数：新学=0，文案追加「（复习已占满目标，今日新学为 0）」；
  - 今日无 plan/跨天：只写设置，提示「今日暂无计划需要调整」，次日建队用新值。
- 首页数据 `useHomeStudy`（`getHomeStudyData` 走 `useLiveQuery`，plans/settings 变化自动刷新）：今日 X/Y、待复习/待新学、剩余、进度条立即变。
- 学习页「当前/总数」来自 plan；学习页 ⋮ →「记忆设置」也可改学习量：重算后仅刷新 plan 数字，**不打断当前 w-c/注释面**（session 快照与已完成次数保留），返回后生效。
- 新增：`src/app/hooks/useDailyGoal.ts`（`applyDailyGoalChange` / `buildGoalResyncMessage`）；`useStudySession.actions.refreshPlan()`。

## 2.3 MaiMemo导入（APK 内置直连 / PWA 本地代理，task-39）

- 入口：词库页「从MaiMemo导入」、我的 →「从MaiMemo导入学习进度」（`/decks?maimemo=1` 自动打开弹层）。
- **APK**（`window.MomoApi.isNativeApp()==='momo-apk'`，由 data 原生 HTTP 桥直连）：
  - 显示「内置直连（无需代理）」，**隐藏代理地址输入**（保留设置值，切回浏览器/PWA 仍可用）；
  - Token 必填（MaiMemo App → 我的 → 更多设置 → 实验功能 → 开放 API 复制）；
  - 文案「进度只写本机，不上传」；错误不再提示 CORS/代理。
- **浏览器/PWA**：显示代理地址输入 + 说明「需在本机运行 `node src/data/api/maimemo-proxy.mjs`」；未填代理时「开始导入」禁用并给明确提示（浏览器直连会被 CORS 拦截）。
- 导入流程（task-40/41）：连接中 → **「正在扫描词库 X / Y（N%）· 预计剩余 s 秒 / 约 1 分钟」**（语义=已扫描词数/总词数，不是导入记录数）→ 结果摘要「匹配 N 词 · 未匹配 M 个 · 跳过 K 条 · 共 T 条记录 · 用时 s 秒」。
- **可取消**：导入中按钮变「取消导入」，点击 `AbortController.abort()`；关闭弹层/离开页面也会 abort；`E_CANCELLED` 静默处理（提示「导入已取消（未写入任何数据）」，不弹错误）。
- 失败按 `MaimemoError.code` 映射：`E_RATE_LIMITED`「MaiMemo接口限流：稍等 1–2 分钟」、`E_BAD_RESPONSE`「接口返回异常（可能忽略过滤参数）」、原生网络错误「网络失败或 Token 失效」、代理模式提示运行 proxy 脚本。导入前提示「按词库扫描，约需 1 分钟；期间可取消」。
- 实现：`src/app/hooks/useMaimemoTransport.ts`（纯函数 `resolveMaimemoTransport` / `describeMaimemoFailure` / `formatMaimemoSummary` / `hasNativeHttpBridge`）。

## 2.3.1 今日复习/新学拆分 + 今日单词页（task-50）

- 首页今日任务卡：**KPI 行固定三项**（不随 6 态变化）：待复习（dueCount）/ 待新学（plan 内未学新词 remaining，无 plan 用 newBudget）/ 今日已学（todayReviewed）；其下保留原状态说明与主按钮（开始学习/继续学习/已完成等）；再下一行 `复习 a · 新学 b`（a/b 为已学词数）+ 次级文字入口「查看今日单词 ›」→ `/today`。"
- `/today`「今日单词」页：顶部汇总今日已学/复习已学/新学已学；两分区「复习（planned）」「新学（planned）」各显示 `已学 x · 未学 y`；每词行 = headword + 标签（已学显示评分 认识/模糊/忘记；未学显示「未学」；加学标「加学」；回炉标「回炉」）；点击行打开单词详情底部 sheet（音标/释义/例句）；无记录时「今天还没有学习记录」；深色主题沿用 tokens。
- 数据：`useTodayBreakdown`（data task-49 `getTodayBreakdown` / `HomeStudyData.breakdown`），词按去重后 plan 首次出现顺序分组。
- 路由：`/today` 为二级页（无底部 Tab，返回首页）。

## 2.3.2 每日复习上限 + 顺延（task-52）

- 设置页「学习设置」→「每日复习上限」：不限（0，默认）/50/100/200/自定义（0–9999）；说明「超出上限的到期复习顺延到之后（不丢失），今日新学预算 = 学习量 − 今日入队复习数」。
- 首页：`reviewBacklog>0` 时显示「另有 X 个到期复习，今日上限 Y 个（不限），将顺延」小字；`reviewBacklog=0`（如 cap=0 不限）不显示该行。
  - 示例（QA S17 对照）：无 plan、due=459、cap=50 → 文案「另有 **409** 个到期复习，今日上限 **50** 个，将顺延」，待复习 459、待新学 0；建 plan 后 backlog 仍 409；cap=0、due=459 → 无顺延行、待新学 0；cap=0、due=2、goal=30 → 无顺延行、待新学 28。
- `/today` 复习分区：`reviewBacklog>0` 时显示「其余 X 个到期复习将在之后复习（每日复习上限）」。
- 数据（task-51 + task-54 修正）：`study.dailyReviewCap`（0=不限，默认）；`HomeStudyData.dueCount` 仍是**全部到期**（非 pickQueue.dueCount）。
  - **无 plan**（新用户/跨天未开始）：`plannedReview = cap>0 ? min(dueCount, cap) : dueCount`（按今日预算入队预计算）；`reviewBacklog = dueCount − plannedReview`（due=459/cap=50 → 409）；`newBudget = max(0, goal − plannedReview)`。
  - **有 plan**：`plannedReview = breakdown.review.planned`（实际入队数）；`reviewBacklog = dueCount − plannedReview`；`newBudget = plan.goals.newBudget`（建队快照）。
  - 已有 plan 沿用建队快照，设置次日/新建 plan 生效。
- 口径边界：首页「待复习」= `HomeStudyData.dueCount`（全部到期，如 459）+ 小字展示 cap 与 backlog；学习页队列/进度 = plan 与 `getTodayBreakdown().review.planned`（如 50）。两者不要混用 pickQueue.dueCount/dueTotal。

## 2.4 多机型适配（task-46：卡片竖向间距 + 旧 WebView 底栏固定）

- **卡片与标题栏间距**：`.mm-section-band` 上下留白各 16px（首个 band 上 8px）；其后 `.mm-card`/`.mm-list`/`.mm-stat-grid` 不再额外加 margin-top（避免双倍间距）。首页/我的/统计/词库/设置统一对称留白，卡片不再贴 band 底边；页面底部最后一张卡与页面 padding-bottom（24 + safe-area）保持不贴边。
- **底栏固定（华为 nova7 等旧 WebView）**：`.app-shell` 改为 `height: 100vh; height: 100dvh;`（旧内核不支持 dvh 时 vh 兜底，否则高度退化为内容高度、tabbar 浮在内容下方）；`.app-main` 加 `min-height: 0` 保证 flex 滚动；`.tabbar` 增加 `position: sticky; bottom: 0; z-index: var(--mm-z-tabbar)` 双保险；安全区仍用 `env(safe-area-inset-bottom)`（`--mm-safe-bottom`），`index.html` viewport 保持 `viewport-fit=cover`；弹层 `max-height` 补 80vh/86vh 兜底。
- **headless 实测（360×640 / 390×844 / 412×915，Chromium 150）**：`tabbar.bottom - innerHeight = 0px`（三视口）；band→卡片间距 16px、卡片上方留白 16px（首页/我的）；滚动到底最后内容不与 tabbar 重叠。截图：`docs/assets/ui/{home,me,stats}-{360x640,390x844,412x915}.png`。
- **QA 待补 E2E**：断言 `tabbar.getBoundingClientRect().bottom ≈ window.innerHeight`（≤1px）与 band/card 间距（jsdom 无布局，需真实 Chromium）。

## 2.5 品牌配置（task-57：公开版 WordC 铺路）

- **单一来源**：`src/app/brand.ts` 导出 `BRAND`（`name/shortName/tagline/description/packageId/exportFolderLabel/exportMetadataGenerator/defaultDeckId/builtinDeckIds/enableMaimemoImport/isOfficialLike`），纯常量、无依赖。私版默认值保持现有输出逐字不变。
- **替换点**（均 import BRAND，无行为变化）：
  - `src/app/version.ts`：`APP_NAME = BRAND.name`（`APP_VERSION` 仍单一来源）；
  - `src/ui/me/AboutPage.tsx`：名称 / 副标题（`BRAND.tagline ?? BRAND.description`）；
  - `src/app/utils/files.ts`：`EXPORT_FOLDER_LABEL = BRAND.exportFolderLabel`；
  - Me/Settings 迁移包文件名前缀：`${BRAND.shortName}-学习进度`；
  - `index.html`：品牌占位符 `%BRAND_NAME%/%BRAND_SHORT_NAME%`，由 `src/app/brand-html.ts::injectBrandHtml` + vite `transformIndexHtml` 构建时注入；
  - `vite.config.ts` PWA manifest：`name/short_name/description` 读 BRAND。
- **公开版**：sanitize 只覆盖 `brand.ts`（WordC / com.wordc.app / 大纲词库），源码不改；`builtinDeckIds` 用 `readonly string[]` 避免类型收窄。
- **测试**：`tests/ui/brand.test.ts`（5）断言字段结构/关系（`APP_NAME === BRAND.name`、导出目录、内置词库包含默认词库）、关于页渲染、index.html 占位符注入、源码无「WordC」硬编码（brand.ts 除外）。
- **关于页第三方说明（task-57 尾）**：`BRAND.backgroundNote/deckNotice/affiliationNotice/tokenNotice` 为可选字段——私版提供完整「MaiMemo/受限商业词表」说明（输出逐字不变）；公开版 brand.ts 省略这些字段 → 回退通用文案（「数据来源与许可见 FEATURES-COMPLIANCE / THIRD-PARTY-NOTICES」「API Token…」），公开树 About 页不出现「MaiMemo/受限商业词表」。
- **已知边界**：`src/data` 的 `GENERATOR`/`selectedDeckId` 默认值由 data 任务接管；`tools/apk/AndroidManifest.xml` label 私版保留（公开树不含 APK）；关于页「MaiMemo/受限商业词表」第三方说明文案未纳入品牌字段（公开版 sanitize 需另行处理）。

## 2.5.1 长文本显示（task-105）

- 设置项副标题/列表 subtitle：允许换行最多 3 行（`-webkit-line-clamp:3`），不再 `text-overflow: ellipsis` 单行截断；标题最多 2 行。
- 按钮：`white-space: normal`，文字可换行（12px 字号、行高 18px），保持 ≥44px 可点区域。
- 内容包 name/subtitle 同样换行显示；窄屏 360px 与深色模式沿用 tokens。
- 验收：设置页「减少动效」等长副标题完整可见；内容包名称/说明不出现省略号；按钮不溢出。

## 2.6.1 内容包管理（task-86）

- 设置页「内容包」区新增「内容包管理」：列出已导入 packs（名称/kind/条目数/已应用/来源），支持单个「导出」为 `.pack.json`（`exportPack` + `saveBlobFile`，APK 走桥接保存）、「导出全部」（逐个导出并汇总成功/失败）、「删除」（危险确认；已应用内容默认保留）。
- 空态显示「还没有导入过内容包」；导出文件名 `名称-日期.pack.json`（非法字符替换）。
- 验收：导入一个 pack → 列表出现条目 → 导出文件可再导入（往返一致）→ 删除后列表消失；空列表显示空态。
- **task-91（骨架）**：「重新检查内置内容」按钮（`ensureDefaultContentPacks({force:true})` + loading「正在重新应用内置内容…」/结果 toast）；pack 行 subtitle = `kind · 已应用 N / 总 M · 来源 source`，N<M 时显示「重新应用」入口（`reapplyPack` 就绪后注入 `onReapply`）。
- **task-91**：每行 subtitle `kind · 已应用 N / 总 M · 来源 source`；N<M 显示「重新应用」（`reapplyPack`，成功 toast「已重新应用「名称」：应用 N 条，跳过 M 条」）；「重新检查内置内容」force seed 后对未完整应用的旧 packs 逐个 `reapplyPack`，toast 汇总应用/跳过条数。
- **task-93**：「重新检查内置内容」运行中按钮禁用 + 分阶段进度（`ensureDefaultContentPacks({force,onProgress})` / `reapplyPack({batchSize,onProgress})` 显示 phase done/total）；重复 pack 警告 +「清理重复内容包」→ 确认框（只删重复记录、已应用内容保留）→ `dedupePacks()` → toast「已清理 N 个重复内容包（保留 M 个）」并自动刷新列表；列表按 createdAt 稳定倒序、每行「已应用 N / 总 M」。
- 测试：`tests/ui/content-pack-manager.test.ts`（5，含重复检测）。

## 2.6 AI 扩充（task-71，可选）

- 设置页「AI 扩充（可选）」：启用开关、provider（DeepSeek 默认/OpenAI 兼容）、baseURL/model、API Key（掩码回显；persistent=本机 DB / session=仅内存刷新失效；保存/清除/测试连接）、单次费用上限、全量预生成预算、隐私说明（Key 只存本机、不导出/不上传/不写日志）。
- 学习页菜单「AI 补内容（当前词/当前 c）」打开生成面板：范围（今日要学/当前词库/当前词）、类型（例句/词组/助记多选）、排除（已有例句/词组/助记/已拒绝）、费用预估/单次上限、开始/取消/进度；错误码 401/402/429/超时等映射为中文文案。
- 生成完成进入审核对话框：✓ 勾选（全选/全不选）、❌ 拒绝并记忆排除、保存已选（落库接口接通前仅预览禁用保存）。
- 隐私：`ai.apiKey` 不导出、不进日志；公开树 sanitize 有 `sk-` 泄漏自检。

## 3. 设置项（设置页覆盖 SPEC §5 全部 key）

| # | key | 默认 | 范围 | 控件 | 生效面 |
|---|---|---|---|---|---|
| 1 | `study.dailyGoal` | 30 | 5–200 | 行 → 弹层 Stepper（步 5） | 首页任务/队列配额（下次取队列生效） |
| 2 | `study.recallMode` | `en2cn` | 固定 | 只读展示「英 → 中」 | v1 固定 |
| 3 | `board.exampleCount` | 2 | 0–3 | 行 → 弹层分段 | 白板面例句条数（学习页实时） |
| 4 | `board.showPhonetic` | true | — | Switch | 白板/注释面音标+发音（实时） |
| 5 | `memory.totalRepeats` | 3 | 1–10 | Stepper | w-c 总次数（实时；学习页 ⋮ 也可调） |
| 6 | `memory.mode` | `sequential` | sequential/random | 分段 | w-c 选 c 策略（实时） |
| 7 | `memory.showPhrases` | **true**（用户拍板，覆盖 D47/SPEC 旧值 false） | — | Switch | w-c 词组块显隐（实时，无数据不占位） |
| 8 | `memory.fontScale` | 1.0 | 0.8–1.6 | Slider（松手保存） | w-c 页 w/c 字号（实时） |
| 9 | `memory.cardSize` | 1.0 | 0.8–1.4 | Slider | w-c 卡片宽/内边距（实时） |
| 10 | `app.fontScale` | 1.0 | 0.9–1.2 | Slider | 全局字号（`--mm-font-scale` 乘 token，实时） |
| 11 | `app.theme` | `system` | system/light/dark | 分段 | `<html data-theme>` + meta theme-color（实时） |
| 12 | `app.reduceMotion` | false | — | Switch | 动画时长 1ms（尊重系统偏好，实时） |
| 13 | `data.maimemoToken` | `''` | ≤2048 | 行 → 密码弹层 | 仅本机存储；MaiMemo导入用；不进导出包 |
| 14 | `data.proxyUrl` | `http://127.0.0.1:8787` | URL | 行 → 输入弹层 | MaiMemo API 代理（CORS） |
| 15 | `data.selectedDeckId` | `kaoyan-hongbaoshu-2025` | 存在的 deck id | 行 → 跳词库页「设为在学」 | 首页/学习页当前词库（实时） |
| 16 | `study.dailyReviewCap` | **0（不限）** | 0–9999 | 行 → 弹层（不限/50/100/200/自定义） | 每日自动入队的到期复习上限；超出部分不顺延修改 dueAt、明天自然再入队；今日新学预算 = 学习量 − 今日入队复习数 |
| 17 | `study.newWordOrder` | **`random`**（用户拍板） | `order` / `random` | 分段「词库顺序 / 随机乱序」（默认选中随机乱序） | 新词顺序（默认随机乱序）；当天计划创建后顺序固定，改学习量保持同一随机序列（明天/新计划生效）。数据层 key 未落地时该行自动隐藏 |

> 说明：上表逐项与 `src/data/settings.repo.ts` 的 `SETTINGS_DEFAULTS` 对齐；`memory.showPhrases` 默认 **true**、`study.newWordOrder` 默认 **'random'** 均为用户后续拍板（覆盖 SPEC/D47 旧值），UI 只读值、可开关并实时生效。
> 其余设置入口：导出/导入学习进度（迁移包）、清空全部数据（**两次确认**）、关于页（版本/算法/版权/许可）。学习页 ⋮ →「记忆设置」可快捷调 5/6/7/8（AC4 演示）。

## 4. 手工验收清单（手机 Chrome · 375–390 宽，逐条勾选）

> 前置：`pnpm test && pnpm build` 全绿；按 docs/RUN.md 启动预览服务；打开首页。

**A. 首页 → 学习全流程**
- [ ] 首页显示「今日」标题、今日任务卡（6 态之一：fresh→「开始学习」/ ongoing→「继续学习 · 已学 x / 共 y」/ done→「今日已完成」/ …）、当前词库卡、连续打卡卡。
- [ ] **续学（task-30）**：学到第 3 个词退出 → 首页按钮变「继续学习」→ 再进学习页回到第 3 个词（队列顺序/回炉位置保持）；刷新页面同样恢复。
- [ ] 点当前词库卡 → 进入词库详情；返回后点「开始学习」→ 学习页（全屏、无底部 Tab、顶部 `×` + `1 / N` + `⋮`）。
- [ ] 白板面：只有单词（青绿大字）+ 音标（有数据时）+ 英文例句（无中文）；点整屏 → 注释面。
- [ ] 注释面：含义行可点（百分比/条上升）、例句英+中、助记/词组按数据显隐；底部固定「记忆」+ 认识/模糊/不认识。
- [ ] 点「记忆」→ w-c 大卡（w↓c、`0/3`、点阵）；点屏幕 +1 到 `3/3` → 自动切下一个含义；全部满 → 回注释面（toast「记忆完成」、滚动位置保持）。
- [ ] 点「认识」→ 400ms 防连点后进入下一词白板面；`2 / N` 与进度条前进；对某词点「不认识」→ 该词稍后在本会话再次出现（回炉）。
- [ ] 学到队列结束 → 完成页「今日任务完成！学习 N 个 · 用时 M 分钟」→「查看统计」/「回首页」可用。
- [ ] 学习页 `×` → 退出确认（文案「今天的进度会自动保存，下次可继续。」）；记忆页 `×`/`⋮ → 退出记忆` → 退出记忆确认，再进记忆从未满 c 继续。

**B. 词库页（CRUD / 导入导出）**
- [ ] 词库页显示「当前在学」卡 + 全部词库列表（词数/已学/到期）；右上 ＋ 新建词库 → 自动进入详情。
- [ ] 词库行 ⋮：设为在学（首页当前词库随之变化）、重命名、导出词库（下载 .deck.json）、删除（二次确认）。
- [ ] 词库详情：统计条（全部/已学/未学/进度）、分段筛选、搜索（英/中）、上滑加载更多；点单词 → 详情弹层（释义/例句/助记/编辑/删除）；右上 ＋ 添加单词（释义每行一条，支持 `vt. 释义` 词性前缀）。
- [ ] 词库页「导入词库」：选 JSON/CSV → toast 显示导入结果；「从MaiMemo导入」弹层填写 Token/代理（当前 task-8 未完成，见 §6）。

**C. 统计页**
- [ ] 概览三数字（连续打卡/累计已学/今日已学）；今日反馈堆叠条 + 文字图例（认识/模糊/不认识）；近 14 天柱状图（悬停/长按可看柱值 title）；不熟悉度 Top5（词 + 释义 + 条 + 百分比）；复习压力（今日/明天/未来 7 天）。
- [ ] 尚未学习时显示空状态「还没有学习记录」。

**D. 我的 / 设置 / 关于**
- [ ] 我的：头像卡（词汇量/连续打卡）+ 深色模式开关；学习数据/词库管理/导出学习进度/导入学习进度/设置/关于入口均可点。
- [ ] 导出学习进度 → 下载 `.migration.json`；重新导入 → toast 报告（校验和不符时弹「仍要导入」二次确认）。
- [ ] 设置页逐项修改并返回验证：每日学习量、标记新词顺序、白板面例句数量、白板面音标、记忆总次数、记忆模式、显示词组、w-c 字号、卡片大小、全局字号、主题、减少动效、Token、代理地址、当前在学词库。
- [ ] **新词顺序（task-48）**：学习设置 →「新词顺序」两个选项，**默认选中「随机乱序」**；切到「词库顺序」后无报错并持久化；副标题「默认：随机乱序；当天计划创建后顺序固定，改学习量也会保持同一随机序列」；刷新后保持；明日/新计划生效（当天已在学 plan 不重排）。
- [ ] **今日复习/新学拆分（task-50）**：首页今日任务卡无论 fresh/ongoing/done 都固定显示「待复习 / 待新学 / 今日已学」三项，下方显示「复习 a · 新学 b」；点「查看今日单词 ›」→ `/today` 显示复习/新学两分区（planned/learned）、每词评分/未学/加学/回炉标签，点击词行弹出详情；无学习记录显示空态；深色模式正常。
- [ ] **每日复习上限（task-52）**：设置页设为 50 → 首页显示「另有 X 个到期复习，今日上限 50 个，将顺延」；`/today` 复习区显示「其余 X 个…」；改回「不限」后不再显示；今日新学预算 = 学习量 − 今日入队复习数（如 due=459、cap=50、goal=30 → 待复习上限 50、待新学 0、backlog 409）。
- [ ] **每日学习量实时同步（task-35）**：已学 2 词后把学习量从 30 改到 50 → toast「已按新学习量调整今日计划：+20 词」；回首页「今日 X/50」、剩余/总数立即变（无需重进）。改到 1 → 移除未学新词、当前词仍在、首页总数变小；若复习数 > 1 → 提示「复习已占满目标，今日新学为 0」。
- [ ] 在学习页 ⋮ →「记忆设置」把学习量从 30 改到 40 → 当前 w-c/注释面状态不被打断；关闭弹层后顶部「当前/总数」与进度条已变。
- [ ] **设置实时生效**：设置页改「记忆总次数 1」「显示词组开/关」「w-c 字号 1.4」「主题深色」→ 直接去学习页（不刷新）验证：w-c 显示 `0/1`、词组块显隐、字号变大、整页深色。
- [ ] 清空全部数据 → 两次确认 → 清空后回首页，内置词库自动重新种入。
- [ ] 关于页：版本号 **与 package.json 一致（当前 v0.2.8）**、「同源 MM/DHP 调度模型」说明（D11）、词库版权声明（D30：版权归原书/MaiMemo，仅供个人学习，请勿分发商用）、数据隐私、开源许可。
- [ ] **APK 导入导出（task-32）**：我的 → 导出学习进度 → 系统提示「已保存到 下载/WordC/背单词-学习进度-YYYY-MM-DD.migration.json」；文件管理器可见；再「导入学习进度」选择该文件 → 导入成功。
- [ ] APK 内词库页：导出词库（带日期文件名）/ 导入 JSON、CSV 词库 / 从MaiMemo导入（Token 或「从文件导入」）均可用；浏览器/PWA 下仍走普通下载。
- [ ] **APK 内导入MaiMemo进度（task-39/41）**：词库页/我的 →「从MaiMemo导入」→ 显示「内置直连（无需代理）」、**无代理地址输入**；粘贴 Token → 开始导入 → 约 1 分钟内显示「正在扫描词库 X / Y（N%）」进度、按钮变「取消导入」（点取消立即停止、提示已取消）→ 完成显示「匹配 N 词 · 未匹配 M 个 · 跳过 K 条 · 用时 s 秒」摘要；错误提示为「网络失败或 Token 失效」类，不再提示 CORS。
- [ ] 设置页 APK 下「MaiMemo代理地址」显示「内置直连」说明（不可编辑，原值保留）；浏览器/PWA 仍可编辑代理并提示运行 `maimemo-proxy.mjs`。
- [ ] 回退到上一词：显示「上次选择：X」+「点其它评分键可直接改判」，三键中上次选择有白色描边高亮；窄屏（375）不换行溢出。

**F. 返回上一词 / 改判（task-30）**
- [ ] 注释面顶栏左出现 `<`（第 1 个词不出现）；点 `<` 或向右滑单词卡 ≥64px → 回到上一词注释面，顶部「上次选择：X（可改判）」。
- [ ] 回退后点「不改了，继续」→ 回到当前进度（不写库）；再点 `<` 可继续往回浏览。
- [ ] 回退后点另一个评分 → toast「已将「X」改为「Y」，计划已更新」；统计页被撤销的旧评分不计入。
- [ ] 纵向滚动/点击不会触发回退；记忆 w-c 页内不回退；首词回退按钮隐藏。

**E. 主题 / 动效 / 移动端 / PWA**
- [ ] 设置主题「深色」→ 首页/词库/统计/我的/设置/关于 + 学习三态全部深色（背景 #101312、面 #1A1E1C、文字提亮），无白底残留（自检见 §5）。
- [ ] 设置「减少动效」或系统开启减少动态效果 → 页面切换/弹层/开关无动画（1ms）。
- [ ] 全局字号 1.2 → 页面文字整体变大，不横向滚动。
- [ ] 375×667 / 390×844 下：Tab 4 项均分不换行、三键不挤压、w-c 超长文本降字号不溢出、底部操作区不被安全区遮挡。
- [ ] Chrome 菜单「添加到主屏幕」→ 使用 owl 图标（青绿底）+ 名称「背单词」；断网后从桌面图标打开仍可用（service worker 预缓存 14 项）。

## 5. 深色模式自检（无浏览器截图环境，按代码/令牌逐项自检）

> 本会话环境无法截图（手机无障碍未开、proot 内无浏览器/截图工具），以下为**静态自检结论**；`ThemeProvider` 在设置变化时把 `resolved` 写入 `<html data-theme>`，全部页面样式只消费 `--mm-*` 变量（`src/ui/**/*.tsx` 中无硬编码色值；唯一 `#fff` 为评分按钮白字与 Switch 圆点，深色下仍合规）。

| 页面/状态 | 自检结论 |
|---|---|
| 首页 | 底 `--mm-bg`、卡 `--mm-surface`、文字 `--mm-text/-text-2`、进度 `--mm-primary`；深色下全部由 tokens 覆盖 ✅ |
| 词库 / 词库详情 | 列表行/卡/分段选中/搜索框均 token 化；无浅色写死 ✅ |
| 统计 | 图表色使用 `--mm-chart-*`（深色另有一套提亮值）；图例文字同步 ✅ |
| 我的 / 设置 / 关于 | 卡片、行、Switch（`--mm-primary`/`--mm-surface-3`）、滑块 `accent-color`、危险红 `--mm-danger` 全部 token 化 ✅ |
| 学习页·白板面 | 面 `--mm-surface`（深色 #1A1E1C）、单词 `--mm-primary`（深色提亮）、例句 `--mm-text`、提示 `--mm-text-3` ✅ |
| 学习页·注释面 | 含义行文字/进度条 5 档色（深色有 `--mm-fam-*-text` 提亮文字色）、分区带 `--mm-surface-2`、三键 `--mm-rating-*` ✅ |
| 学习页·w-c | 底 `--mm-bg`、卡 `--mm-surface`、次数/点阵/词组块全 token ✅ |
| PWA 外壳 | `theme-color` 由 ThemeProvider 同步为 `#101312`（深色）/`#FFFFFF`（浅色）；manifest theme `#36B59D` ✅ |
| 动效 | `data-reduce-motion="true"` 时全局 `animation/transition: 1ms`；`prefers-reduced-motion` 双通道 ✅ |

**深色模式关键令牌**（`src/app/styles/tokens.css` 的 `:root[data-theme="dark"]`）：bg `#101312`、surface `#1A1E1C`、surface-2 `#232826`、text `#E8ECEA`、primary `#45C6AC`、primary-text `#6FD8C0`、打分色 `#35A98F/#C08325/#C25A40`。

## 6. 依赖 task-8（MaiMemo导入）尚未可用的部分

- 「从MaiMemo导入」（词库页弹层）与「MaiMemo API Token / 代理地址」设置项 UI 已完成；当前 `importMaimemoProgress` 为占位实现，调用会抛 `MaimemoError(code='E_NOT_IMPLEMENTED')`，UI 显示错误 toast，不会白屏/卡死。
- 任务书中的「展示导入进度」已接 `onProgress(done,total)` 文案；task-8 完成后无需改 UI（签名不变）。
- 其余功能（词库 JSON/CSV 导入导出、迁移包、内置词库、学习流程、统计）均不依赖 task-8。

## 7. 自动化测试

- `tests/ui/pages-smoke.test.ts`（9 用例）：8 条路由 + 404 在 Provider/Router 中 SSR 渲染不抛错；学习页无底部 Tab；关于页含 D11/D30 文案。
- `tests/ui/plan-flow.test.ts`（6）：plan 续学不重排、首页 fresh→ongoing→done、回退浏览不改数据、撤销/改判 correctedBy。
- `tests/ui/home-state-view.test.ts`（7）+ `home-task-card.test.ts`（6）：首页 6 态文案/按钮/KPI/进度。
- `tests/ui/swipe-back.test.ts`（5）：64px 阈值/方向锁/阻尼。
- `tests/ui/files-bridge.test.ts`（6）：mock `window.MomoBridge` 断言 APK 分支调用 `saveBase64File`（纯 base64/中文文件名）且不触发 blob；`err:` 提示透传；非 APK 分支保持 `<a download>`；`datedFileName` 日期与中文文件名。
- `tests/ui/ai-ui.test.ts`（9）：semantics 类型/审核、失败分类、设置表单、生成面板。
- `tests/ui/derivation-chain.test.ts`（4）：本义链渲染/无映射隐藏/AI 标识/注释面多 c/w-c 切换/长文本。
- `tests/ui/content-pack-import.test.ts`（2）：内容包导入入口（未接落库禁用/接通可用）。
- `tests/ui/ai-ui.test.ts`（5）：错误码文案、预算/进度/汇总格式、AI 设置表单、生成面板、审核对话框。
- `tests/ui/brand.test.ts`（8）：BRAND 字段/关系、关于页私版/公开版文案条件渲染（公开版无「MaiMemo/受限商业词表」）、index.html 占位符注入、品牌名「独立词」校验（公开版 WordC 不误伤 TodayWordCategory/ratedWordCount）、功能性导入文案白名单、源码无品牌名硬编码。
- `tests/ui/pages-smoke.test.ts`：关于页按 `BRAND.deckNotice` 条件断言（私版完整版权说明；公开版通用 FEATURES-COMPLIANCE/THIRD-PARTY-NOTICES 且不含「受限商业词表」）。
- `tests/ui/daily-review-cap.test.ts`（5）：预设/自定义解析、0=不限、非法不写、updateSettings 写入、说明文案。
- `tests/ui/today-words.test.ts`（6）：两分区/planned/learned 渲染、评分与未学/加学/回炉标签、分组顺序、复习上限 backlog 说明、空态。两分区/planned/learned 渲染、评分与未学/加学/回炉标签、分组顺序、空态。
- `tests/ui/new-word-order.test.ts`（6）：两选项渲染、`updateSettings` 写入 `study.newWordOrder`、非法值不写、文案断言、key 未落地时设置页隐藏。
- `tests/ui/layout-css.test.ts`（6）：vh→dvh 兜底、tabbar sticky+安全区、app-main min-height、band 上下 16px 对称、弹层 vh 兜底。
- `tests/ui/version.test.ts`（2）：单一来源校验 `APP_VERSION === package.json.version` + 格式 `^\d+\.\d+\.\d+$`；关于页显示 `v{APP_VERSION}` 且无 0.1.0。
- `tests/ui/daily-goal-change.test.ts`（7）：mock data 断言 resync 调用、+N/-N/新学为 0 文案、无 plan、异常、非法值。
- `tests/ui/daily-goal-resync.test.ts`（4，fake-indexeddb）：增大追加、减小只删尾部且当前词保留、复习占满新学 0、重算不影响 w-c 快照。
- `tests/ui/maimemo-transport.test.ts`（17）：APK/PWA 两种模式的代理显隐与文案、未填代理提示、错误映射（原生不提示 CORS）、扫描进度 X/Y 与 ETA、AbortController 取消、E_CANCELLED 静默、限流/异常文案、结果摘要格式。
- `tests/routes.test.ts`（5 用例）：路由/4 Tab/`tabForPath` 归属规则。
- `tests/ui/study-components.test.ts`（15）+ `tests/ui/study-flow.test.ts`（5）：见 docs/UI-STUDY.md（学习页）。
- 本轮 UI 回归：`npx vitest run tests/ui --pool=forks --poolOptions.forks.maxForks=1` → 15 文件 / **113 用例**全绿（task-35 后）；`npx tsc --noEmit` 0 错误。全量 `pnpm test`/`pnpm build` 由 Lead/QA 统一跑。

## 8. 已知问题 / 边界

1. **无法提供真机截图**：本会话手机无障碍未开、proot 内无浏览器；已提供逐项自检清单（§5）与手工验收清单（§4）。手机访问 URL 由 task-12 提供。
2. **MaiMemo导入**当前为占位（见 §6），task-8 完成后生效。
3. 内置词库无音标/词组数据 → 学习页音标与词组块隐藏（D32/D33）；用户手动添加的单词可填音标/例句。
4. 「每日学习量」弹层用步长 5（5–200）；如需任意整数可在后续版本改输入框。
5. 词库详情采用「分页 + 触底加载」而非严格虚拟滚动（100/页，最多按需加载；12k 词库流畅）。
6. 迁移包导入默认策略 `merge`（按 wordId 保留较新状态）；`replace` 策略保留在 data 层接口，UI 未暴露（降低误操作风险；QA 可在脚本中验证 AC5）。
6.1 回退/改判为**扩展行为**（官方仅确认可回退查看）；UI 文案标「可改判」，且仅支持「今天 + 本 plan + 最近一次」，更早反馈提示不可修改。
7. PWA 图标为自绘单色猫头鹰（青绿底，maskable 版本内容缩入安全区）；非官方素材。
8. 深色模式下 Switch 圆点固定 `#fff`、评分按钮白字固定 `#fff`（语义色底上均 ≥3:1，符合 D17/03-ui 规范）。
9. APK 内导出（task-32）：Android 9 及以下首次可能返回 `err:需要存储权限…`，按提示授权后**再点一次**即可；重名文件由原生侧自动加 `(1)(2)`；保存目录固定 `下载/WordC/`。
10. 浏览器/PWA 仍使用 `<a download>`（部分移动浏览器会打开预览而非直接保存，属浏览器行为）。
