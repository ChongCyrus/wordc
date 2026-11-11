# dsh-get-it-for-free 插件调研（免费 token / ZCode 接入）

> 任务：task-82 · 负责人 research-api · 调查时间：**2026-11-11 23:24–23:40**（Asia/Shanghai）
> 插件：`dsh-get-it-for-free@3.0.9`（作者 hulibuld，MIT，<https://github.com/hulibuld/dsh-get-it-for-free>）
> 安装位置：`/root/.dsh/profiles/web/node_modules/dsh-get-it-for-free/`（pnpm 硬链，实测路径即包目录）
> 约束：本次**只读调查**，未改插件源码、未改产品代码、未改 DSH 运行配置；未登录任何账号、未 star 任何仓库、token 未打印。

---

## 0. 一句话结论

**架构完整、插件已在当前 profile 生效，但「按官方渠道真跑起来」需要用户本人浏览器登录 + 接受风险，且从本机当前出口（CN 移动 IP）免费车道模型全部被限流；因此结论是「仅测试 / 不建议作为主通道」。**
若用户接受封号风险，最可行的是 **ZCode（智谱）渠道**：本机若有 `~/.zcode/v2/credentials.json` 可零配置直读；没有就得在插件设置页走浏览器授权（含 captcha）。批量生成脚本可以走它自带的 **OpenAI 兼容本地转发端口**（`http://127.0.0.1:18899/v1/chat/completions`），但前提是该插件里已有可用账号/模型。

---

## 1. 插件是什么（功能 / 渠道 / 路由）

**定位**：把「免费/签到型」大模型账号渠道接进 DSH，账号登录、每日签到、模型池探测，模型以普通 provider 出现在模型选择器；另带本机用量看板与 OpenAI 兼容转发端口。纯本地运行，无遥测、无自更新。

**支持的渠道（包内 `vendor/channel-pack` + 内置）**：

| 渠道 | 组织 | 登录方式 | 备注 |
|---|---|---|---|
| **ZCode** | **智谱** | 浏览器授权（captcha）/ 自动读 `~/.zcode/v2/credentials.json` | 积分制（tokens），支持「一键领取」；模型 `GLM-5.3-Flash`、`GLM-5.3` |
| CodeArts | 华为云 | 浏览器授权 / AK-SK | 积分制 |
| WorkBuddy 国内版 / 国际版 | 腾讯 | 浏览器授权 | 免费档 + 每日签到 |
| Qoder 中国版 / 国际版 | 阿里系 | 浏览器授权 | — |
| TRAE | 字节 | 设备码 / 浏览器授权 | 含签到 |
| Raccoon | 商汤 | 浏览器授权 | — |
| LobsterAI | 有道 | 浏览器授权 | — |
| MiniMax Code | MiniMax | 浏览器授权 | — |
| Loomy | 讯飞 | 微信扫码 | 积分分临时/永久两池 |
| Gemini | Google（Antigravity） | 浏览器授权 | — |
| MiMo | 小米 | 复用桌面端已登录 cookie | 无需加账号；额度按天重置 |
| CodeBuddy CLI 通道 | 腾讯 | 用本机已登录的 `codebuddy` CLI | 可选，多账号；本机**未安装**（实测日志） |
| 免费车道（EAC） | OpenCode 免费模型经第三方中转 | **GitHub 登录 + star 仓库** | 服务端校验 star，取消 star 即失效 |

**注册到 DSH 的 LLM route（`src/adapter.js` / `src/mimo` / `src/cli-lane.js`）**：
- `get-it-for-free`（主车道，本次可用模型）
- `get-it-for-free-region`（按出口地区受限的模型）
- `mimo`（小米桌面端通道）
- `codebuddy-cli`（腾讯官方 CLI 通道）

> 与我们已有手声明 route（`juflowai`、`zhipu`，见 `~/.dsh/profiles/web/cordis.patch.yml`）**不冲突**（route id 不同）。模型 id 可能重名（如都出现 `glm-5.3-flash`），但选择器按 provider 分组隔离，不互相覆盖。

**当前激活状态（实测）**：`dsh --profile web --dump-config` 输出中有
```yaml
# == dsh-get-it-for-free
- id: get-it-for-free
  name: dsh-get-it-for-free
  config: {}
```
即 **bundle 层已挂载、config 为空（用默认）**；插件数据目录 `~/.dsh/get-it-for-free/` 已生成，`session-map.json` 里已有 `catalog:get-it-for-free` / `probe:get-it-for-free` 两个 session → **Host 半身正在运行并已做过真实探测**。

---

## 2. 如何启用 / 配置（照做）

### 2.1 入口与风险确认（必做）
1. DSH Web（`http://127.0.0.1:3080`）→ **Settings → Get It For Free**（插件导航名就叫 `Get It For Free`）。
2. 首次进入会弹全屏风险告知（标题「贪生怕死勿入斯门」），正文三句原文：
   > 官方从不支持代理链接行为，随时可判定违规并永久封禁相关账号。软件内部余额、会员权益全部清空，不会保留。
   > 同时也可能会对相关使用者进行进一步的追究（本插件完全开源，作者不负任何责任）。
   > 若在使用本插件过程中相关损失实有发生，损失应由使用者全权承担。
3. 继续使用要点右下角几乎不可见的 **「无视风险继续使用。」**（左侧红色「删除该插件并退出」会真的卸载插件）。接受后写 `settings.json → riskAccepted: true`。

### 2.2 接 ZCode（用户目标）
- **路径 A（零配置，若有官方 ZCode CLI）**：插件会自动解密读取 `~/.zcode/v2/credentials.json`（字段 `zcode_jwt` + `device_mid`），无需填任何东西。**本机实测：`~/.zcode` 不存在、无 `zcode` 命令 → 此路径当前不可用。**
- **路径 B（浏览器授权）**：渠道页 ZCode 卡片 →「添加账号」→ 浏览器打开智谱授权页（内部走 captcha，可能依赖本机 Chrome/CDP）→ 完成后卡片显示「已接入」→ 点「测试」→ 「一键领取」（每日签到额度）→ 在模型开关里打开 `GLM-5.3-Flash` / `GLM-5.3`。
- ZCode 模型能力（包内声明）：`GLM-5.3-Flash`：1M 上下文 / 128K 输出 / 支持图片 / 思考档位 low·high·max（默认 max）；`GLM-5.3`：1M / 128K / **不支持图片** / 同样思考档位。
- 登录态存哪：账号池在 `~/.dsh/channel-pack/state.json`（本次调查时**该文件不存在**，即还没有任何账号登录）；插件自设置/缓存/用量在 `~/.dsh/get-it-for-free/`。

### 2.3 免费车道（EAC，OpenCode 免费模型）
- 需要 **GitHub 登录并给插件仓库 star**（服务端校验；取消 star 授权自动失效）。登录在浏览器完成，无需复制粘贴。
- 卡内文案：「EAC（协付）模型需要 GitHub 登录并 star 仓库；免费车道的模型不受影响。」
- 本机现状：免费车道**已探测**但无可用模型（见 §4）。

### 2.4 其它可选
- **MiMo（小米）**：需本机已登录小米 MiMo 桌面端（复用其 cookie）；本机无桌面端 → 不可用。
- **CodeBuddy CLI**：需先 `npm i -g` 装腾讯 `codebuddy`/`cbc` CLI 并登录；本机**未安装**（`cli-probe.log` 实测记录）。
- **模型开关**：每渠道可单独开关；未接入账号的渠道模型自动全关。**当前 `settings.json → hideAllModels: true`**，即模型全部隐藏，需要用户手动打开或在设置页「一键全开」。
- **总开关**：`settings.json → enabled: true`（已开）。
- **推荐免费组**：`combos` 中已有 `combo:recommended-free`（`deepseek-v4.1-flash-free` / `glm-5.3-flash-free` / `space-bunny-free`，fallback 策略），接入后可直接选该组。

### 2.5 用模型
在**输入框的模型选择器**里选「**Get It For Free**」分组下的模型即可（免费车道模型名带 `Free`，ZCode 模型名即 `GLM-5.3-Flash` 等）。

---

## 3. 插件的本地状态（只读核实，2026-11-11 23:22–23:23）

`~/.dsh/get-it-for-free/settings.json`（值脱敏）关键字段：

| 字段 | 值 | 含义 |
|---|---|---|
| `enabled` | `true` | 插件总开关已开 |
| `riskAccepted` | `false` | **风险告知尚未接受**（设置页会被全屏挡住） |
| `hideAllModels` | `true` | **模型全部隐藏**（用户当前看不到/选不到） |
| `freeChannelsEnabled` | `false` | 免费车道/探测循环未启用 |
| `forward` | `{enabled:false, host:127.0.0.1, port:18899}` | OpenAI 兼容转发端口**未启用** |
| `egress` | `{enabled:false, mode:'subscription'}` | 出口代理未启用 |
| `chanGateway.relay` | `{enabled:false, port:18326}` | 渠道网关中继未启用 |
| `combos` | 含 `combo:recommended-free` | 推荐免费组已预置 |
| `tokenSaver/localOptimize` | 开 | 省 token / 本地优化开关 |

目录现有文件：`settings.json`、`catalog.json`、`availability.json`、`session-map.json`、`cli-probe.log`；**无账号文件**（`~/.dsh/channel-pack/` 不存在）。

---

## 4. 实测记录（低成本、无账号操作）

1. **插件自身探测（真实网络请求，非我伪造）**：`availability.json` 记录 `at=1794410627678`（≈2026-11-11 23:23:47 +08），出口 `223.104.242.119`（CN）。8 个免费车道模型结果：

   | 模型 | 状态 | 上游返回（截断） |
   |---|---|---|
   | `mimo-v2.6-flash-free` | `throttled` | Free usage limit reached…（OpenCode 免费额度用尽） |
   | `nemotron-3.5-lightning-free` | `throttled` | 同上 |
   | `ling-3.0-flash-fin-free` | `unavailable` | Model is unavailable |
   | `mimo-v2.5-free` | `unavailable` | Model is unavailable |
   | `nemotron-3-ultra-free` | `unavailable` | Model is unavailable |
   | `space-bunny-free` | `unavailable` | Model is unavailable |
   | `muse-spark-1.2-contributor-free` | `unavailable` | Model is unavailable |
   | `muse-spark-1.3-contributor-free` | `unavailable` | Model is unavailable |

   → **从本机当前出口，免费车道 0 个可用**（限流/下线）。
2. **插件 REST API 只读探测**：`GET http://127.0.0.1:3080/api/get-it-for-free/summary`、`/channels` → **401 Unauthorized**（需要浏览器会话凭据，符合其 trust fence 设计；未越权绕过）。
3. **CLI 通道**：`cli-probe.log` 显示 `no candidate existed`（`codebuddy`/`cbc` 不在 PATH 的任何候选目录）→ CLI 通道不可用。
4. **ZCode**：无 `~/.zcode`、无 `zcode` 命令 → 只能走浏览器授权（需要用户本人操作 + captcha），**我未执行**。
5. **未做真实 chat 实测**：阻塞原因 = 无任何已登录渠道 + 免费车道全部限流 + 转发端口未启用（启用会改运行配置，按约束不做）。**结论：目前无法从本机跑通一次真实对话；需用户先完成 §2 登录。**

---

## 5. 批量生成脚本怎么走它（如插件跑通后）

插件内置 **OpenAI 兼容转发监听器**（`src/forward.js`），这是给外部工具（含我们的 `tools/gen-pack-deepseek.mjs`）用的最简路径：

- 启用：Settings → Get It For Free →「免费模型」页 →「本地转发（OpenAI 兼容）」分区 → 勾选**启用转发端口** → 端口默认 **18899**（仅允许 loopback 地址）→ 应用。
- 监听器支持的路径：`POST /v1/chat/completions`、`/chat/completions`、`/v1/responses`、`/responses`，以及 `/v1/messages`、`/v1/messages/count_tokens`（Anthropic 形状）。
- 鉴权：请求头 `Authorization: Bearer <forward key>` 或 `x-api-key`；key 由本机生成（`ofm-` 前缀），在设置页「API Key」处显示/复制/重新生成，存放在 `~/.dsh/get-it-for-free/settings.json → forwardKey`（**明文，文件 0600**）。
- 我们的批量脚本可直接：
  ```bash
  node tools/gen-pack-deepseek.mjs --deck kaoyan-2027-dagang \
    --base-url http://127.0.0.1:18899 --model GLM-5.3-Flash \
    --kinds examples,phrases,mnemonics --limit 20
  # 运行前把 Key 以环境方式提供（脚本走 OpenAI 兼容 provider）
  ```
  注意：我们的 `buildChatUrl()` 对 `http://127.0.0.1:18899` 会拼成 `/v1/chat/completions`，**正好命中**转发路径 ✅；模型 id 用插件选择器里显示的 id（ZCode 为 `GLM-5.3-Flash`，免费车道带 `-free` 后缀）。
- 限制：转发器会重排 `tool_calls[].index`、抑制指纹 decoy 工具调用；**`tool_calls` 场景不建议依赖它**，纯文本 JSON 生成（我们的场景）可用。

---

## 6. 风险与结论

| 维度 | 结论 |
|---|---|
| 合法性/ToS | ⚠️ **高**：插件自述「用第三方客户端反代官方额度这件事，官方明确不允许」，风险提示写明可能**永久封号 + 清空余额/会员**。ZCode 走的是智谱 coding plan 的官方客户端额度，属于反代。 |
| GitHub star 门槛 | 免费车道需 GitHub 登录 + star 插件仓库（服务端校验）；取消 star 即失效——需用户明确同意再操作。 |
| Token/凭据存储 | 登录态：`~/.dsh/channel-pack/state.json`（本次尚无）；转发 Key/出口订阅 URL：`~/.dsh/get-it-for-free/settings.json`（明文，0600）；插件自述「纯本地、无遥测」。**任何 token 不要写进文档/git/聊天。** |
| 稳定性 | 免费车道本次 0/8 可用（限流/下线）；渠道模型池依赖上游风控与每日签到，随时可能失效；插件更新频繁（3.x，README 大量修复记录）。 |
| 许可证 | 插件 MIT；`vendor/channel-pack` 来自 gitee `iJetLi/deepseek-harness-codearts`，**MIT**（NOTICE.md 注明）。可审计，但上游实现含 CDP captcha/反检测逻辑，性质仍是绕过官方客户端校验。 |
| 与环境兼容 | Node v24.22.1 ✅（要求 `^22.19.0 || >=24`）；DSH 0.2.2-rc.1 ✅（要求 ≥0.2.0-rc.1）；route id 与 `juflowai`/`zhipu` 无冲突。 |
| **总体结论** | **仅测试 / 不建议作为主通道。** 若用户坚持：优先 ZCode（有 `~/.zcode` 凭据时最省事），其次腾讯 CodeBuddy；免费车道当前不可用。批量生成仍建议走 `docs/FREE-LLM-PROVIDERS.md` 里的官方免费 API（智谱 GLM-4.7-Flash / 硅基流动）或我们已配置的 juflowai/zhipu。 |

**可选卸载**：设置页红色按钮「删除该插件并退出」会删依赖+bundle 条目+插件目录（账号/历史保留在 `~/.dsh/get-it-for-free/`）；或 `dsh plugin --profile web remove dsh-get-it-for-free`。

---

## 7. 需要用户本人做的事（我无法代做）

1. 打开 Settings → Get It For Free，阅读风险告知并自行决定是否「无视风险继续使用」；
2. ZCode：点「添加账号」完成浏览器授权（可能要装/登录官方 ZCode 客户端，使其生成 `~/.zcode/v2/credentials.json`），然后「测试」→「一键领取」；
3. 若要免费车道：用 GitHub 登录并 star 插件仓库（是否接受由用户定）；
4. 打开需要的模型开关（当前 `hideAllModels: true`）；
5. 若要给批量脚本用：在「免费模型 → 本地转发」启用端口 18899 并复制 API Key（不要发给我/不要进 git）。

**安全提醒（顺带发现，不在本任务范围）**：`~/.dsh/profiles/web/cordis.patch.yml` 里 `juflowai` / `zhipu` 的 `headers.Authorization` 是**明文 Key**。建议后续改为 `apiKeyEnv`/凭据引用并轮换这两个 Key；本次未改动该文件。
