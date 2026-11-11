# ARCH · 技术架构与脚手架说明

> 状态：脚手架阶段完成（task-4）。本文是**全队共享地基的说明书**：目录职责、路由、构建方式、
> 主题与 PWA 方案、手机访问、踩坑记录、以及后续 dev 开工时的接口契约。
>
> 相关文档：`docs/DECISIONS.md`（产品决策 D1–D29，最高优先级）、`docs/research/01-algorithm.md`、
> `02-data-api.md`、`03-ui.md`、以及后续的 `docs/SPEC.md`（实现规格，dev 依据）。
> 决策冲突时优先级：**DECISIONS.md > SPEC.md > research > 本文**。

## 1. 技术栈（实际安装版本）

| 能力 | 选型 | 锁定版本 | 说明 |
| --- | --- | --- | --- |
| 构建 | Vite | 5.4.21 | 不用 Vite 6/7：proot + Node 24 下 5.x 更稳，插件生态匹配 |
| 视图 | React | 18.3.1 | Lead 拍板 18（不上 19，避免生态/类型波动） |
| 路由 | react-router-dom | 6.30.6 | HashRouter，见 §3 |
| 语言 | TypeScript | 5.9.3 | `strict: true` + `noUncheckedIndexedAccess` |
| 存储 | Dexie | 4.4.7 | IndexedDB 封装，`src/data/` 专属 |
| 状态 | React Context | 内置 | 目前只做 settings/theme；不足时再加 zustand（见 ARCH 变更规则） |
| PWA | vite-plugin-pwa | 0.21.2 | Workbox `generateSW` + `autoUpdate` |
| 样式 | Tailwind CSS | 3.4.19 | PostCSS 版（非 v4，理由见 §5） |
| 测试 | Vitest | 2.1.9 | node 环境，纯函数单测 + 架构约束测试 |
| 质量 | ESLint 9 / Prettier 3 | 9.39.4 / 3.9.10 | flat config + `.prettierrc.json` |
| 包管理 | pnpm | 11.28.5 | registry.npmmirror.com |
| 运行环境 | Android proot Ubuntu 24.04 / Node 24.22 | — | arm64，4GB 级内存，构建要快 |

依赖安装：`pnpm install`（默认走 npmmirror，已配好）。

## 2. 目录职责与依赖方向

```
src/
├─ main.tsx          入口，只负责挂载
├─ App.tsx           Provider + Router + 路由表装配（保持稳定，dev 不用改）
├─ app/              「应用装配层」：路由、全局 store、主题、布局、全局 CSS
│  ├─ router.tsx     路由表（唯一事实来源，path ↔ 页面组件）
│  ├─ routes.ts      导航元数据（纯数据：tab 栏、标题），可单测
│  ├─ providers.tsx  全局 Provider 汇总
│  ├─ store.tsx      SettingsProvider / useSettings（占位内存态，后续接 Dexie）
│  ├─ theme.tsx      ThemeProvider / useTheme（system / light / dark）
│  ├─ layout/AppShell.tsx  骨架：<main> 内容区 + 底部 TabBar + 安全区
│  └─ styles/global.css    Tailwind 指令 + 主题 CSS 变量 + 布局组件类
├─ core/             「领域与算法层」：纯 TS，零 UI/DB 依赖
│  ├─ types.ts       Word / Deck / ReviewState / ReviewLog / DailyStat …
│  ├─ scheduling.ts  调度算法（SM-2 精简版占位；dev-algo 按 SPEC 替换内部实现）
│  ├─ time.ts        本地日期 key、加天数等纯函数
│  └─ index.ts       唯一出口（dev 只从 '@core' 等价路径 import）
├─ data/             「持久化与 IO 层」：唯一允许碰 IndexedDB / fetch 的地方
│  ├─ db.ts          Dexie 实例 + schema v1 + resetDatabase
│  └─ index.ts       出口：db 与后续 repo/import/export/maimemo-api
└─ ui/               「展示层」：页面与组件，消费 core/data 的 hooks
   ├─ pages/         7 个页面（每页默认导出无参组件）
   └─ components/    通用展示组件（PagePlaceholder 等）
tests/               Vitest 单测（core 纯函数、路由元数据、架构约束）
docs/                DECISIONS.md、research/、ARCH.md、SPEC.md
public/icons/        PWA 图标（192/512 PNG，脚本生成的占位几何图，可随时替换）
data/raw/            研究阶段落地的原始数据/归一化词库 JSON（导入进 src/data/builtin/ 的来源）
```

**依赖方向（硬约束，有单测兜底，见 `tests/architecture.test.ts`）**

```
ui ──▶ app ──▶ data ──▶ core
ui ──────────────▶ data ──▶ core
ui ──────────────────────▶ core        （ui 可直接调纯函数，但不许直接 IndexedDB）
core 不得依赖任何上层（react / dexie / 路由 / window / document / localStorage）
```

- `core` 只用纯函数 + 类型，保证「算法可以脱离浏览器跑单测」。
- 只有 `data` 能 new Dexie、碰 `indexedDB`、发 `fetch`；UI 通过 hooks 拿数据。
- `app` 只做装配（路由/store/主题/布局），不放业务逻辑。
- 模块出口都是 `index.ts`，跨层 import 走出口；同一层内部可以直连文件。

## 3. 路由

**选型：HashRouter**（`#/study` 形式）。理由：

1. 本应用是纯静态 PWA（`vite preview` / 任意静态托管 / 甚至 `file://` 打开），没有服务端 rewrites；
   HashRouter 不需要「所有路径回退到 index.html」的服务器配置。
2. 与 Service Worker 离线回退天然兼容：导航请求永远只请求 `index.html`，不会出现刷新 404。
3. 部署到子路径（`base: './'`）时不需要 `basename` 计算。
4. 代价：URL 带 `#`、不能做「干净的深链接分享」——本项目是单机学习工具，无分享需求，可接受。

| 路由 | 页面 | 文件 | 底部 tab |
| --- | --- | --- | --- |
| `/` | 今日学习（首页） | `src/ui/pages/HomePage.tsx` | ✅ |
| `/study` | 背单词会话 | `src/ui/pages/StudyPage.tsx` | ✅ |
| `/decks` | 词库 | `src/ui/pages/DecksPage.tsx` | ✅ |
| `/stats` | 学习统计 | `src/ui/pages/StatsPage.tsx` | ✅ |
| `/me` | 我的 | `src/ui/pages/MePage.tsx` | ✅ |
| `/me/settings` | 设置 | `src/ui/pages/SettingsPage.tsx` | ❌（从 /me 进入） |
| `*` | 404 | `src/ui/pages/NotFoundPage.tsx` | — |

**页面接口约定（dev-ui 必须遵守）**：每个页面文件 `export default` 一个**无参 React 组件**，
路由路径**只在** `src/app/router.tsx` 与 `src/app/routes.ts` 里改。页面从 hooks 取数据：

```tsx
import { useSettings } from '../../app/store'
import { useTheme } from '../../app/theme'
import { scheduleNext } from '../../core'
```

底部 tab 栏项目由 `src/app/routes.ts` 的 `TAB_ITEMS` 驱动，dev-ui 改文案/图标只改这个纯数据文件。

## 4. PWA 方案

- `vite-plugin-pwa` 0.21.2，`generateSW` 模式：构建时由 Workbox 自动生成 `dist/sw.js` +
  `dist/workbox-*.js` + `dist/registerSW.js`，**不手写 service worker**。
- `registerType: 'autoUpdate'` + `injectRegister: 'auto'`：新版本装好后下次进入自动接管，无需自写更新提示。
- `base: './'`：产物可在子路径、`vite preview`、静态服务器下直接跑。
- manifest 由 `vite.config.ts` 内联生成（`dist/manifest.webmanifest`），字段：中文名、`display: standalone`、
  `orientation: portrait`、`theme_color #2f6f4e`、`background_color #0f1210`、192/512 图标（含 maskable）。
- 离线：`globPatterns` 预缓存 js/css/html/png/svg/webmanifest/woff2（当前 10 条 180 KiB），
  `navigateFallback: 'index.html'`。
- 开发时 `devOptions.enabled = false`：dev 不注册 SW，避免缓存干扰开发；PWA 行为用 `pnpm build && pnpm preview` 验证。
- **Secure Context 提醒**：Service Worker 只在「安全上下文」注册。`http://127.0.0.1` / `http://localhost`
  被 Chrome 视为安全上下文，可用；`http://<局域网 IP>` 不行（SW 不注册，安装提示也不会出现）。
  所以手机上真正测 PWA 能力要用 127.0.0.1，局域网 IP 只用来测页面渲染。

## 5. 样式与主题

- **Tailwind 取舍（重要）**：保留 **Tailwind CSS v3.4（PostCSS 实现）**，没有退化成纯 CSS，
  也**没有**升 v4。原因：
  - Tailwind v4 依赖 `@tailwindcss/oxide` 原生二进制（Rust），在 Android proot arm64 上要么包不齐、
    要么构建更慢/偶发失败，而本项目要频繁 `pnpm build` 验证。
  - v3 是纯 JS/PostCSS，实测整包构建 4 秒内，稳。
  - 但主题**不用** Tailwind 内置调色板：所有语义色映射到 CSS 变量（`bg-surface`、`text-muted`、
    `bg-primary`、`border-border` …），这样做「深色模式 / 换主题色 / 之后对照设计稿改 tokens」不用改页面。
- 主题变量在 `src/app/styles/global.css`：
  - `:root` = 亮色默认值；
  - `@media (prefers-color-scheme: dark)` = 跟随系统（`data-theme` 未设置时生效）；
  - `:root[data-theme='dark']` / `[data-theme='light']` = 用户手动覆盖（`useTheme().setMode`）。
- 语义 token：`--color-bg / surface / surface-2 / text / text-muted / primary / primary-weak /
  on-primary / border / danger / success / warning`、`--radius-card`、`--shadow-card`、`--tabbar-height`。
  **页面里禁止写死颜色**，否则暗色模式必坏。
- 主题 token 的最终命名以 `docs/SPEC.md` §11-11 为准：UI 落地时统一使用 `03-ui.md` 的 `--mm-*`
  tokens（替换本文脚手架占位的 `--color-*`），两套不并存，`tailwind.config.js` 的语义色映射同步改。
- 移动端：`index.html` 有 `viewport-fit=cover` + `user-scalable=no`（工具类 App 惯例，输入法缩放问题另解）；
  安全区用 `--safe-top/bottom/left/right`（`env(safe-area-inset-*)`），由 `AppShell` 统一承担，
  页面内不要再加底部 padding；高度用 `100dvh` 防地址栏伸缩抖动；触摸目标 `min-height: 44px`。
- 浅色/深色 `theme-color` meta 已分别声明，Android 状态栏颜色跟随。

## 6. 构建 / 测试 / 质量（实测日志摘要）

环境：Android proot Ubuntu 24.04 · Node v24.22.1 · pnpm 11.28.5 · 2026-11-10。

```
$ pnpm install
Already up to date
Done in 604ms using pnpm v11.28.5

$ pnpm build
$ tsc --noEmit && vite build
vite v5.4.21 building for production...
✓ 48 modules transformed.
dist/registerSW.js                0.14 kB
dist/manifest.webmanifest         0.48 kB
dist/index.html                   1.35 kB │ gzip:  0.70 kB
dist/assets/index-*.css           9.62 kB │ gzip:  2.68 kB
dist/assets/index-*.js          168.30 kB │ gzip: 56.02 kB
✓ built in 4.08s

PWA v0.21.2
mode      generateSW
precache  10 entries (180.09 KiB)
files generated
  dist/sw.js
  dist/workbox-*.js

$ pnpm test
 ✓ tests/routes.test.ts (3 tests) 6ms
 ✓ tests/scheduling.test.ts (5 tests) 6ms
 ✓ tests/architecture.test.ts (3 tests) 5ms
 Test Files  3 passed (3)
      Tests  11 passed (11)
```

`pnpm install && pnpm build && pnpm test` 三条命令退出码 0，无 warning（验收标准达成）。
其他命令：`pnpm lint`（ESLint flat config）、`pnpm format`、`pnpm test:watch`、`pnpm preview`。

现有测试分工：
1. `tests/scheduling.test.ts` —— core 调度算法行为（新词/评分/ease 边界/间隔上限）；
2. `tests/routes.test.ts` —— 路由与 tab 元数据完整性（防止 dev 改路由时漏页面）；
3. `tests/architecture.test.ts` —— **架构约束**：扫 `src/core/*.ts` 源码，禁止 import
   react/dexie/路由库，禁止 `window.`/`document.`/`localStorage`/`indexedDB`（注释已剔除）。
   dev-algo 以后如果让 core 依赖 UI，这条测试会直接红。

## 7. 手机访问与预览（重点，proot 环境实测）

**结论：手机 Chrome 直接用 `http://127.0.0.1:5173` 访问 proot 内的 Vite dev server 即可。**
依据：proot 不创建独立 network namespace，proot 进程与 Android 系统/各 App 共用同一个网络栈，
所以 proot 里 bind 在 127.0.0.1 的端口就是手机的 loopback 端口；Android Chrome 访问 127.0.0.1 命中同一个端口。
`127.0.0.1` 同时被浏览器视为 Secure Context，Service Worker / PWA 安装都能用。

本机实测（proot 内执行）：

```
$ pnpm dev                                  # vite --host 127.0.0.1 --port 5173
VITE v5.4.21 ready in 573 ms  ➜  Local: http://127.0.0.1:5173/
$ curl -sI http://127.0.0.1:5173/          → HTTP/1.1 200 OK, <title>WordC</title>

$ pnpm preview                              # vite preview --host 0.0.0.0 --port 4173（构建产物）
$ curl -o /dev/null -w '%{http_code}' http://127.0.0.1:4173/                → 200
$ curl -o /dev/null -w '%{http_code}' http://10.39.234.205:4173/            → 200（本机网卡 IP）
$ curl http://127.0.0.1:4173/manifest.webmanifest                           → 200（manifest 正常）
$ curl -o /dev/null -w '%{http_code} %{size_download}' http://127.0.0.1:4173/sw.js        → 200 3580B
$ curl -o /dev/null -w '%{http_code} %{size_download}' http://127.0.0.1:4173/icons/icon-192.png → 200 689B

$ pnpm dev:mobile                           # vite --host 0.0.0.0 --port 5173
$ curl -o /dev/null -w '%{http_code}' http://10.39.234.205:5173/            → 200（0.0.0.0 绑定生效）
```

> 说明：本次未能用手机浏览器 UI 实拍确认（手机操作被用户中止），但 proot 内 curl 对 127.0.0.1 /
> 设备 IP 均 200、manifest/sw/icons 均可取，链路已通；手机 Chrome 打开 `http://127.0.0.1:5173/`
> 若首次被 Vite 的 host 检查拦下，用 `pnpm dev:mobile` 走 0.0.0.0 + 设备 IP 兜底（此路径无 SW）。

可执行命令清单：

| 场景 | 命令 | 手机地址 | PWA/SW |
| --- | --- | --- | --- |
| 日常开发（推荐） | `pnpm dev` | `http://127.0.0.1:5173/` | ❌（dev 不注册 SW，正常） |
| 开发但需局域网/其他设备 | `pnpm dev:mobile` | `http://10.39.234.205:5173/` | ❌ |
| 验证构建产物 + PWA | `pnpm build && pnpm preview` | `http://127.0.0.1:4173/` | ✅ |
| 验证局域网内 PWA | `pnpm preview` | 设备 IP:4173 | ⚠️ 非安全上下文，SW 不注册 |

注意事项：
- **不要长期占用端口**：验证完 `kill` 掉 vite 进程（本次已关闭 dev/preview 进程）。
- 设备 IP 会变（`hostname -I` 实查）；HMR 在 127.0.0.1 下工作正常。
- `pnpm preview` 必须先把 `--host 0.0.0.0` 打开（脚本已带）才能被设备 IP 访问；127.0.0.1 不需要。
- 端口被占：`--port 5174` 换端口，或先找到占用进程 kill。

## 8. 踩坑记录（proot / Node 24 / pnpm 11）

1. **pnpm 11 默认拦截依赖的 install 脚本**：`pnpm install` 报
   `ERR_PNPM_IGNORED_BUILDS: esbuild@0.21.5`。处理：执行一次 `pnpm approve-builds --all`
   （本机已执行，esbuild postinstall 已跑）。`package.json` 的 `pnpm.onlyBuiltDependencies` 字段
   pnpm 11 已不再读取（新家在 `pnpm-workspace.yaml`），本项目保留 `pnpm-workspace.yaml` 记录 allowlist。
2. **workbox-build 7.4.1 + @rollup/plugin-terser 1.0.2 在 Node 24 下卡死**：
   `vite build` 最后生成 SW 时报
   `Unable to write the service worker file ... Unfinished hook action(s) on exit: (terser) renderChunk`。
   处理：`vite.config.ts` 里 `workbox.mode = 'development'`，跳过 SW 的 terser 压缩。
   影响：`sw.js` 未压缩（3.6 KB）+ `workbox-*.js` 未压缩（129 KB），但 SW 只下载/解析一次，
   且 app 主包仍由 esbuild 压缩（168 KB / gzip 56 KB），对体验无感；换来的是构建稳定可重复。
   （若以后升级 vite-plugin-pwa / workbox 修了该问题，可删掉这一行恢复 SW 压缩。）
3. **tailwindcss 不升 v4**：见 §5（arm64 原生依赖风险）。
4. **TS 严格项带来的迁移成本**：`noUncheckedIndexedAccess` 会让 `arr[i]` 变成 `T | undefined`，
   写遍历/查表时用 `for...of`、`map`、或先判空；`noUnusedLocals/Parameters` 会拦住草稿代码。
5. **架构约束测试会把注释也算进去**：`tests/architecture.test.ts` 已先剥注释再扫关键字，
   在 core 注释里写「不用 localStorage」这类说明也不会误报。

## 9. 给 dev 队友的交接约定

- **谁写哪里**：`dev-algo` 只改 `src/core/`（+ `src/core/index.ts` 导出）；`dev-data` 只改 `src/data/`
  （Dexie schema、repo、导入导出、MaiMemo API 客户端）；`dev-ui` 只改 `src/ui/`（+ 必要时 `src/app/styles/global.css`
  的 token 值，但保持变量名）。`src/app/router.tsx` 的路由路径与 `src/app/routes.ts` 的 tab 结构是公共契约，
  要改先在群里说。
- **新增依赖**：先 `send_message` 给 lead 报备（会同步到本文件 §1 版本表）；优先用已有依赖。
- **加页面**：在 `src/ui/pages/` 新建组件 → `src/app/router.tsx` 加路由 → 若进 tab 栏，改 `src/app/routes.ts`。
- **加 core/data 导出**：必须同步更新 `src/core/index.ts` / `src/data/index.ts`，并补 1 个单测。
- **数据 schema 升级**：`src/data/db.ts` 只加 `version(n)`，不改旧 version 的定义（老用户数据要能升级）。
- **提交前自检**：`pnpm test && pnpm build`（两条都要绿；build 里含 `tsc --noEmit`）。
- **已知限制**：`src/core/scheduling.ts` 目前是 SM-2 精简占位实现（接口稳定、内部待替换）；
  `src/app/store.tsx` 的 settings 还是内存态（接 Dexie 时保持 `useSettings()` 接口不变）；
  PWA 图标是脚本生成的几何占位（品牌图确定后替换 `public/icons/` 同名文件即可，manifest 不用动）。

## 10. 变更记录

| 日期 | 变更 |
| --- | --- |
| 2026-11-10 | task-5 完成：`docs/SPEC.md` v1 定稿（数据格式/调度/状态机/设置/导入导出/页面拆分/接口契约/AC1–AC8） |
| 2026-11-10 | task-4 完成：Vite+React18+TS strict+Dexie+react-router6(Hash)+vite-plugin-pwa+Tailwind3 脚手架；路由/主题/安全区/占位页/3 个测试文件；ARCH.md 初版 |
