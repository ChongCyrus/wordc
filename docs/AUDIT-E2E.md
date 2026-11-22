# 背单词 App E2E 覆盖矩阵与系统审计（task-276）

> 审计目标：0.3.93（冻结新功能）发布前，对核心用户路径做系统化 E2E 覆盖盘点。
> 当前执行基线：`index-Y5pjUVJM.js`（0.3.92 构建，4173 production dist）。
> **最终 0.3.93 重打后必须用新入口复跑本文标“待终包”的项。**
> 原则：不修改 `src`、不调用真实 AI/MaiMemo API；fixture pack 请求统一 abort；仅用 mock/本地 DB。

## 1. 结论摘要

| 维度 | 状态 | 说明 |
|---|---|---|
| 核心学习/注释/三击/触摸 | PASS | 历史 gate + 0.3.92 prod/touch 回归 |
| 词库列表 / 单词详情 / 选择模式 | PASS | 100 行首屏、详情无评分、选择态仅一套 Bulk |
| 添加今日新词（手动/随机/顺序/计划弹窗） | PASS（功能）/ 待终包（toast） | 顺序 plan 3→4、随机 4→7 实际写入成功；5/10/15s 未观测到「已追加」toast |
| 临时复习 practice/rate/rate-only | PASS（前轮） | practice 零写库、rate 更新 state/log 不动 plan、rate-only `scheduleMode=skip` 保留调度 |
| 首页 manual 无计划 | PASS | 待新学 0、显示添加按钮；开始学习仅原计划/复习词 |
| 旧计划清理 | PASS | 旧 plan 下首页待新学 0、开始学习 1/1 denounce |
| 备份/恢复/预装 | 部分 | mock native 备份/恢复/prune7 PASS；真机 GZIP、预装 defaultSeeded 未验 |
| 360/390/411 | PASS（smoke） | home/deck/me 三视口均无横向溢出 |
| 全新安装/覆盖升级/重装 | 部分 | Web fixture 可模拟；APK 安装/重装/升级需真机 |
| 视觉回归 | PASS | 03/04/06 基线，diff 0（更新后） |

**无新增 P0/P1 功能阻断；存在 1 个待终包确认的 toast 文案缺口和若干 native-only 未覆盖项。**

## 2. E2E 覆盖矩阵

### 2.1 DB 状态维度

| DB 状态 | 覆盖项 | 结果/证据 | 状态 |
|---|---|---|---|
| 干净库（fixture 重新 seed） | 首屏、词库、详情、添加、统计 | `qa-prod-gate`、`qa-task268-gate`；首页待复习0/待新学0 | PASS |
| 已学库（states>0） | 词库行不熟度、详情 encounters、排行、抽词 | `qa-task263-sync-gate`：标记后 0%→100%，重进 50%；词库行「不熟悉 0%」 | PASS |
| 旧计划（旧 auto 词计划） | 首页待新学0、开始学习、追加清理 | `qa-task273-gate`：首页待新学0；开始学习 `/study` 1/1 denounce；`qa-task273-diag` 顺序3→4、随机4→7 | PASS |
| 备份后（auto restore merge） | 恢复、pre-restore、报告 | `qa-autobackup-native-gate`：restore ok=true，12230 词/1 状态，pre-restore 生成 | PASS（mock bridge） |

### 2.2 安装/升级维度

| 场景 | 覆盖方式 | 结果 | 状态 |
|---|---|---|---|
| 全新安装（Web） | 清 DB + fixture seed，首屏/词库/预装行 | 0.3.92 首页/词库正常；Web「预装内容=浏览器版不含预装数据」 | PASS（Web） |
| 全新安装（APK） | 需真机安装包 + generated 预装 | `generated.defaultSeeded`/手动导入进度未验 | **native-only 待真机** |
| 覆盖升级 | `qa-upgrade-gate` / `qa-upgrade-sw-gate`（历史套件） | 本轮未在 0.3.93 重跑 | 待终包 |
| 重装 | 需 APK 卸载重装；Web 清 site data 近似 | 未跑 | **待真机/终包** |
| SW 缓存 | 生产构建注册 `/sw.js` | arch 确认私版 PWA 预期；非旧缓存 bug | 已知预期 |

### 2.3 词库 / 详情 / 选择维度

| 路径 | 覆盖 | 结果 | 状态 |
|---|---|---|---|
| 词库列表（5528 词） | `qa-task268-gate` | 首屏 100 行，不冻，行显示不熟悉度 | PASS |
| 详情默认点词 | `qa-return-diag`、`qa-task262-gate` | `/study?detailWord=…`，annotation 渲染，**无认识/模糊/不认识** | PASS |
| 详情返回（顶栏） | `qa-return-diag` | 10s 内回 `#/decks/…`，rows=100，`.study-loading=0` | PASS（Y5） |
| 详情返回（浏览器 back） | `qa-task272-gate` | 搜索框恢复、不停「正在加载今日学习」 | PASS（Y5） |
| 详情内容 | `qa-task263-sync-gate` | 本义/含义 pos+cn+不熟/例句/AI 助记；无评分 | PASS |
| 选择模式 | `qa-task267-gate` | 原搜索/Segmented 消失，仅一套 Bulk；完成恢复 | PASS |
| 批量工具条 | `qa-task267-gate`、`qa-task263-extra-gate` | 搜索/状态/四档排序/升降序/全选跨页/999/前N | PASS |
| 批量 AI/引申图 | `qa-task263-extra-gate` | AI `已选1/共1` target1；引申图候选1/已选1 | PASS |
| 单元列表点词 | `qa-task268-gate` | 进 `/study?detailWord` 完整详情，无评分 | PASS |
| 单元工具条 | `qa-task261-extra-gate` | 全选跨页 85/85、反选/取消、四档排序、360 | PASS |
| 单元首帧 | `qa-task268-gate` | 无「没有单词」空态，显示「正在加载单元单词…」 | PASS |

### 2.4 添加今日新词全路径

| 路径 | 覆盖 | 结果 | 状态 |
|---|---|---|---|
| 打开弹窗/三模式 | `qa-task260-gate` | 手动筛选/随机选择/顺序选择、搜索、单元 | PASS |
| 数量输入边界 | `qa-task261-gate` | `-5→1`、`1200→999`、清空→20、`0→1` | PASS |
| 默认数量 | `qa-task261-gate` | 随机默认 20 | PASS |
| 记住上次模式/数量 | `qa-task268-gate` | 随机 + 7 重新打开仍保持 | PASS |
| 手动多选添加 | `qa-task260-gate` | 计划增长，去重 | PASS |
| 顺序添加（旧计划） | `qa-task273-diag` | plan 3→4，5s 内完成；按钮处理中 disabled | PASS（功能） |
| 随机添加（旧计划） | `qa-task273-diag` | plan 4→7，5s 内完成 | PASS（功能） |
| 计划四选项 | `qa-task260-gate`、`qa-task273-diag` | 保留/移除后追加/仅移除/取消；三选项各1次 | PASS |
| 追加 toast | `qa-task273-diag` | 5/10/15s body 未出现「已追加」 | **待终包确认** |
| 候选 = 0 / 超上限 | `qa-task261-gate` | 999 上限、空候选提示历史覆盖 | 部分 |

### 2.5 临时复习 / 抽词

| 路径 | 覆盖 | 结果 | 状态 |
|---|---|---|---|
| 抽词弹窗 | `qa-task262-gate` | 二选一「加入今日计划/立即复习」+ 三记录方式 | PASS |
| 加入今日计划 | `qa-task262-gate` | plan 3→4，states/logs 不变 | PASS |
| practice | `qa-task262-gate` | 无评分、有「下一个」；states/logs/plan 全不变 | PASS |
| rate | `qa-task262-gate` | states 1→2、logs 1→2、plan 不变 | PASS |
| rate-only | `qa-task263-extra-gate` | dueAt/stability/difficulty/phase 不变；log `scheduleMode=skip`；plan 不变 | PASS |
| 结束回来源 | `qa-task262-gate` | returnTo 回词库/来源页 | PASS |

### 2.6 首页 manual/auto

| 模式/状态 | 覆盖 | 结果 | 状态 |
|---|---|---|---|
| manual 无 plan | `qa-home0` 检查 | 待新学0、显示「添加今日新单词」 | PASS |
| manual 旧 plan | `qa-task273-gate` | 待新学0；开始学习仅 1/1 denounce | PASS |
| manual 添加后 | `qa-task260/273` | 计划增长、可继续 | PASS |
| auto 新词来源 | 历史 `qa-threetap` 等 + 设置页 | 本轮未专项重跑 | 待终包 |

### 2.7 边界/稳定性

| 项 | 覆盖 | 结果 |
|---|---|---|
| 999 选择上限 | `qa-task267`、`qa-task263-extra` | `已选999/筛选5528`，不越界 |
| pack 请求 abort | 全套 gate | 预期 console `ERR_FAILED`，已过滤 |
| 页面错误 | 全套 | 0 pageerror / 0 非 pack console |
| 详情 encounters | `qa-task263-sync-gate` | detail 进入记 encounters，标记后 familiarity 50%/100% |
| OOM/串行 | 审计执行 | 单 Chromium 串行，避免并发 |

### 2.8 视口

| 视口 | 页面 | 结果 |
|---|---|---|
| 411 | home/deck/me | 无横向溢出 |
| 390 | home/deck/me | 无横向溢出 |
| 360 | home/deck/me | 无横向溢出 |
| 390/360 | 选择态、诊断、预装、首页 manual0 | 截图 `91–98` |

证据：`qa-audit276-smoke` 输出 `411/390/360 × home/deck/me` 全部 `overflow:false`，console 空。

## 3. 已发现风险 / 待办

1. **添加 toast 未观测（P2 验证缺口）**
   - 顺序/随机实际写入成功（plan 3→4/4→7），但 5/10/15s body 无「已追加 N 个新词到今日计划」
   - 可能为 toast 生命周期短/时序窗口；终包复验，若仍无则报 dev-ui
2. **native-only 未覆盖**
   - APK 预装 `generated.defaultSeeded` / 手动「立即导入」x/y/完成/失败 toast
   - APK 自动备份 GZIP/真实 `auto/*.json.gz`/`diag.log`
3. **安装矩阵**
   - APK 全新安装/覆盖升级/重装未跑；升级套件未在 0.3.93 重跑
4. **SW**
   - `/sw.js` active 为私版 PWA 预期（arch 确认），不作为 bug
5. **构建版本**
   - 本文基线为 `index-Y5pjUVJM.js`；0.3.93 终包重打后需复跑 prod/touch/visual + 添加 toast + 返回详情

## 4. 复跑命令（生产 dist）

```bash
export LD_LIBRARY_PATH=$PWD/tools/e2e/chromium/usr/lib/aarch64-linux-gnu:$PWD/tools/e2e/chromium/usr/lib/chromium
export QA_FIXTURE=$PWD/tests/e2e/fixtures/minimal-profile.json
export QA_BASE=http://127.0.0.1:4173/

# 基础
node tests/e2e/qa-prod-gate.mjs
node tests/e2e/qa-touch-gate.mjs
node tests/e2e/qa-visual-compare.mjs

# task-276 矩阵
node tests/e2e/qa-audit276-smoke.mjs
node tests/e2e/qa-task268-gate.mjs
node tests/e2e/qa-task267-gate.mjs
node tests/e2e/qa-task263-extra-gate.mjs
node tests/e2e/qa-task263-sync-gate.mjs
node tests/e2e/qa-task262-gate.mjs
node tests/e2e/qa-task273-gate.mjs
node tests/e2e/qa-task273-diag.mjs
node tests/e2e/qa-task272-gate.mjs
node tests/e2e/qa-backup-native-gate.mjs
```

> 串行执行；每 gate 间确认无残留 Chromium，避免 OOM。

## 5. 通过标准

- P0/P1：学习/详情/添加/临时复习/备份恢复核心路径无阻断
- P2：文案/toast/空态/布局问题记录但不阻断，终包前确认
- native-only 项在 APK 真机记录，不以 Web 结果替代
- 0.3.93 终包新入口：prod/touch/visual + 添加 toast + 详情返回 + 411/390/360 smoke 全绿后放行

## 6. 截图索引

| 文件 | 内容 |
|---|---|
| `91-deck-bulk-only-390.png` | Deck 选择态仅一套工具条 |
| `92-unit-bulk-only-390/360.png` | 单元选择态 |
| `93-ai-count-390.png` | AI 已选1/共1 |
| `94-unit-word-detail-390.png` | 单元点词详情 |
| `95-deck-first-n-390.png` | 选择前 N |
| `96-add-remember-390.png` | 记住模式/数量 |
| `97-preinstall-web-390/360.png` | Web 预装行 |
| `98-detail-back-390.png` | 详情返回 |
| `98-home-manual-0-390.png` | 首页 manual 待新学0 |
| `99-return-appback.png` | 顶栏返回后 Deck |
| `63-add-order-diag.png` / `63-add-random-diag.png` | 添加运行时诊断 |

---

审计人：QA（task-276） · 基线：0.3.92 `index-Y5pjUVJM.js` · 终包 0.3.93 需复跑标注项

---

## 7. 0.3.93–0.3.98 收尾补充（含 0.3.96/0.3.97 并入说明）

> **0.3.96 / 0.3.97 未公开发布，修复并入 0.3.98。** 以下为 0.3.98 起必须复跑的回归项。

| 场景 | Gate | 关注点 | 状态 |
|---|---|---|---|
| 批量面板（T297） | `qa-task297-gate` | 来源预选、筛选、批次、确认、预览勾选；390/360 不溢出 | PASS（mock） |
| 详情冷启动词根卡片 | `qa-detail-root-card-gate` | `/study?detailWord` 直接渲染 `.root-etymology-card`，不等待聚合；编辑弹层可用 | PASS（mock） |
| 同日回炉/最后词 | `qa-requeue-gate` | 同日 familiar 未完成继续回炉；最后词不提前 completed | PASS（2 词场景） |
| 自动备份原生桥 | `qa-autobackup-native-gate` | 立即备份/列表/保留7/恢复 merge + pre-restore/异常弹窗/持久化；100MB/gzip/旧 sources | PASS（mock bridge） |
| 全屏面板 open=false | `qa-task297-gate` + DOM 检查 | 关闭时不渲染 DOM/遮罩/监听；返回哨兵单层 | 手动 DOM + 返回路径 |
| fresh 预装顺序 | fresh 安装手测 | 先内容包 apply，再 mnemonics/衍生数据；失败重试；Web 不 seed | 待 APK 终包 |
| 安装矩阵 | `qa-upgrade-gate` / `qa-upgrade-sw-gate` + 手动 | 覆盖升级、卸载重装、手动导入、fresh 预装四路径 | 待 0.3.98 终包复跑 |

**复跑命令（追加）**
```bash
node tests/e2e/qa-task297-gate.mjs
node tests/e2e/qa-detail-root-card-gate.mjs
node tests/e2e/qa-requeue-gate.mjs
node tests/e2e/qa-autobackup-native-gate.mjs
```

**结论**：0.3.98 发版前上述 gate 全绿；APK 安装矩阵与 fresh 预装顺序必须在真机完成，不以 Web 结果替代。
